import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { createAssistantMessageEventStream, type AssistantMessage, type Models } from '@earendil-works/pi-ai';
import { Pool } from 'pg';
import { createProfileModels, type ModelProfile } from '../../src/config/model.js';
import { migrate, PostgresDocumentBackend } from '../../src/domain/service.js';
import { DomainError } from '../../src/domain/types.js';
import { NaturalTaskRuntime } from '../../src/runtime/natural-runtime.js';
import { migrateNaturalTasks } from '../../src/runtime/natural-store.js';
import { DocumentRuntime } from '../../src/runtime/document-runtime.js';

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

function deterministicModels(profile: ModelProfile): { models: Models; calls: () => number } {
  const models = createProfileModels(profile, 'fixture-api-key');
  let requests = 0;
  models.streamSimple = ((model) => {
    requests += 1;
    const response: AssistantMessage = {
      role: 'assistant',
      content: requests === 1
        ? [{ type: 'toolCall', id: 'fixture-create-kb', name: 'knowledge_base_create', arguments: { name: 'fixture-docs', description: 'Deterministic natural-agent test fixture.' } }]
        : [{ type: 'text', text: 'Created the fixture-docs knowledge base.' }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: requests === 1 ? 'toolUse' : 'stop',
      timestamp: Date.now(),
    };
    const stream = createAssistantMessageEventStream();
    stream.end(response);
    return stream;
  }) as typeof models.streamSimple;
  return { models, calls: () => requests };
}

test('real Pi Harness runs the registered natural tool against PostgreSQL with a deterministic model fixture', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-document-natural-runtime-'));
  const port = await reservePort();
  const password = randomUUID();
  const postgres = new EmbeddedPostgres({
    databaseDir: join(directory, 'postgres'), port, user: 'postgres', password, persistent: false,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => undefined, onError: console.error,
  });
  let pool: Pool | undefined;
  let runtime: DocumentRuntime | undefined;
  let natural: NaturalTaskRuntime | undefined;
  try {
    await postgres.initialise();
    await postgres.start();
    pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 8 });
    await migrate(pool);

    const backend = new PostgresDocumentBackend({
      pool,
      blobRoot: join(directory, 'blobs'),
      publicBaseUrl: 'https://documents.example.test',
    });
    const token = `natural-fixture-${randomUUID()}`;
    await backend.provisionPrincipal({
      tenantId: 'tenant-natural-fixture',
      id: 'principal-natural-fixture',
      token,
      scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'],
    });
    const principal = await backend.authenticate(token);
    assert.ok(principal);

    const modelProfile: ModelProfile = {
      provider: 'qwen-maas',
      modelId: 'deterministic-natural-fixture',
      baseUrl: 'https://models.example.test/v1',
      credentialsEnv: 'PI_DOCUMENT_AGENT_API_KEY',
      contextWindow: 8192,
      maxOutputTokens: 512,
      timeoutMs: 10_000,
    };
    const fixture = deterministicModels(modelProfile);
    natural = new NaturalTaskRuntime({ backend, pool, modelProfile, apiKey: 'fixture-api-key', models: fixture.models });
    await migrateNaturalTasks(pool);
    runtime = await DocumentRuntime.open(backend, join(directory, 'pi.sqlite'), {
      models: natural.models,
      extensions: [natural.extension],
      deferResume: true,
    });
    await natural.attach({
      harness: runtime.harness,
      conversationFor: (actor, contextId) => runtime!.conversationFor(actor, contextId),
      admitDomain: (actor, request, contextId) => backend.admit(actor, request, contextId),
      dispatchDomain: task => runtime!.dispatch(task),
      getDomainTask: (actor, id) => backend.getTask(actor, id),
      cancelDomain: (actor, id) => runtime!.cancel(actor, id),
    });
    await runtime.start();

    const submitted = await natural.submitText(principal, 'natural-fixture-message', '请创建知识库 fixture-docs');
    const deadline = Date.now() + 15_000;
    let settled = await natural.getTask(principal, submitted.id);
    while (!['completed', 'failed', 'canceled', 'input_required'].includes(settled.state) && Date.now() < deadline) {
      await delay(25);
      settled = await natural.getTask(principal, submitted.id);
    }
    assert.equal(settled.state, 'completed', JSON.stringify(settled.error));
    assert.equal(settled.answer, 'Created the fixture-docs knowledge base.');
    assert.equal(fixture.calls(), 2);

    const actionRows = await pool.query<{ operation: string; state: string; child_task_id: string | null }>(
      `SELECT operation, state, child_task_id FROM pd_agent_actions WHERE tenant_id = $1 AND task_id = $2`,
      [principal.tenantId, settled.id],
    );
    assert.equal(actionRows.rows.length, 1);
    assert.equal(actionRows.rows[0]?.operation, 'knowledge_base.create');
    assert.equal(actionRows.rows[0]?.state, 'completed');
    assert.ok(actionRows.rows[0]?.child_task_id);

    const knowledgeBases = await backend.listTasks(principal);
    assert.ok(knowledgeBases.some(task => task.id === actionRows.rows[0]?.child_task_id && task.state === 'completed'));
    const replay = await natural.submitText(principal, 'natural-fixture-message', '请创建知识库 fixture-docs');
    assert.equal(replay.id, settled.id);
    assert.equal(fixture.calls(), 2);
    await assert.rejects(
      natural.submitText(principal, 'natural-fixture-message', '请创建知识库 other-docs'),
      (error: unknown) => error instanceof DomainError && error.code === 'IDEMPOTENCY_CONFLICT',
    );
    await pool.query(`UPDATE pd_principals SET scopes = ARRAY['knowledge:read']::text[] WHERE tenant_id = $1 AND principal_id = $2`, [principal.tenantId, principal.id]);
    await assert.rejects(
      natural.getTask(principal, settled.id),
      (error: unknown) => error instanceof DomainError && error.status === 404,
    );
    await assert.rejects(
      natural.submitText(principal, 'natural-fixture-message', '请创建知识库 fixture-docs'),
      (error: unknown) => error instanceof DomainError && error.status === 404,
    );
    assert.deepEqual(await natural.listTasks(principal), []);
  } finally {
    await natural?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await postgres.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
