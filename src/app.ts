import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { serviceConfig, type ServiceConfig } from './config/service.js';
import { PostgresDocumentBackend, migrate, migrateVector } from './domain/service.js';
import { createDocumentPipeline } from './config/pipeline.js';
import { DocumentRuntime } from './runtime/document-runtime.js';
import { createGateway } from './a2a/gateway.js';
import type { NaturalTaskRuntime } from './runtime/natural-runtime.js';
import { addMetrics, migrateObservability } from './observability/index.js';
import { addManagementRoutes } from './management/router.js';
import { addManagementUi } from './ui/static.js';

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

export async function startApp(config: ServiceConfig) {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
  let gateway: ReturnType<typeof createGateway> | undefined;
  const server = createServer((req, res) => {
    if (config.logEvents) {
      const startedAt = performance.now();
      res.once('finish', () => console.log(JSON.stringify({ event: 'http_response', method: req.method,
        route: req.url?.split('?')[0]?.replace(/\/v1\/documents\/[^/]+/, '/v1/documents/:id'),
        status: res.statusCode, durationMs: Math.round(performance.now() - startedAt) })));
    }
    if (gateway) gateway(req, res);
    else { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"ready":false}'); }
  });
  let runtime: DocumentRuntime | undefined;
  let natural: NaturalTaskRuntime | undefined;
  let owner: PoolClient | undefined;
  let shutdown: Promise<void> | undefined;
  const close = () => shutdown ??= (async () => {
    try {
      if (server.listening) await closeServer(server);
      await natural?.close();
      await runtime?.close();
    } finally {
      owner?.release(); owner = undefined;
      await pool.end();
    }
  })();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  try {
    owner = await pool.connect();
    const ownership = await owner.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock(hashtext('pi-document-runtime-owner')) AS acquired");
    if (!ownership.rows[0]?.acquired) throw new Error('DATABASE_ALREADY_OWNED: another document runtime owns this database');
    owner.once('error', () => { void close().catch(() => undefined); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP server address');
    const baseUrl = config.publicBaseUrl ?? `http://${config.host === '::1' ? '[::1]' : config.host}:${address.port}`;
    await migrate(pool);
    const pipeline = config.embedding ? createDocumentPipeline(config.embedding) : undefined;
    if (pipeline) await migrateVector(pool, pipeline.profile.dimensions);
    const backend = new PostgresDocumentBackend({ pool, blobRoot: config.blobRoot, publicBaseUrl: baseUrl, pipelineTaskDurationMs: config.taskMaxDurationMs, ...(pipeline ? { pipeline } : {}), ...(config.fault ? { fault: config.fault } : {}) });
    if (config.bootstrap) await pool.query(
      `INSERT INTO pd_principals(tenant_id,principal_id,scopes,token_hash) VALUES($1,$2,$3,$4)
       ON CONFLICT(tenant_id,principal_id) DO NOTHING`,
      [config.bootstrap.tenantId, config.bootstrap.principalId,
        ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'],
        createHash('sha256').update(config.bootstrap.token).digest()],
    );
    if (config.agent) {
      const { NaturalTaskRuntime } = await import('./runtime/natural-runtime.js');
      const { migrateNaturalTasks } = await import('./runtime/natural-store.js');
      await migrateNaturalTasks(pool);
      natural = new NaturalTaskRuntime({ backend, pool, modelProfile: config.agent.profile, apiKey: config.agent.apiKey, limits: config.agentLimits });
    }
    await migrateObservability(pool);
    runtime = await DocumentRuntime.open(backend, config.piStoragePath, {
      fault: config.fault,
      ...(natural ? { models: natural.models, extensions: [natural.extension], deferResume: true } : {}),
    });
    if (natural) {
      const attachedRuntime = runtime;
      await natural.attach({ harness: runtime.harness,
        conversationFor: (principal, contextId) => attachedRuntime.conversationFor(principal, contextId),
        admitDomain: (principal, request, contextId) => backend.admit(principal, request, contextId),
        dispatchDomain: task => attachedRuntime.dispatch(task),
        getDomainTask: (principal, id) => backend.getTask(principal, id),
        cancelDomain: (principal, id) => attachedRuntime.cancel(principal, id),
      });
      await runtime.start();
    }
    gateway = createGateway(runtime, { publicBaseUrl: baseUrl, ...(natural ? { natural } : {}) });
    addManagementRoutes(gateway, pool, backend, runtime, { naturalEnabled: !!natural, publicBaseUrl: baseUrl });
    addManagementUi(gateway);
    addMetrics(gateway, pool, backend);
    const activeRuntime = runtime;
    return { baseUrl, backend, runtime: activeRuntime, natural, server, pool, close };
  } catch (error) {
    await close();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startApp(serviceConfig());
  console.log(JSON.stringify({ event: 'ready', baseUrl: app.baseUrl }));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
}
