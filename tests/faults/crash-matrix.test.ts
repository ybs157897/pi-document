import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { startApp } from '../../src/app.js';
import type { ServiceConfig } from '../../src/config/service.js';
import { LocalPostgres } from '../../scripts/support/local-postgres.js';

async function freePort() {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve())); return address.port;
}
type WireTask = { id: string; status: { state: string }; artifacts?: { parts: { data: { outcome: string; result: Record<string, unknown> } }[] }[] };
async function rpc(base: string, token: string, method: string, params: unknown) {
  const response = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'A2A-Version': '1.0', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal: AbortSignal.timeout(15_000) });
  const body = await response.json() as { result?: { task?: WireTask } & Partial<WireTask>; error?: unknown };
  assert.equal(body.error, undefined, JSON.stringify(body));
  return (body.result?.task ?? body.result) as WireTask;
}
const send = (base: string, token: string, data: unknown, immediate = true) => rpc(base, token, 'SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data, mediaType: 'application/json' }] }, configuration: { returnImmediately: immediate, acceptedOutputModes: ['application/json'] } });
async function waitTask(base: string, token: string, task: WireTask) {
  const deadline = Date.now() + 15_000;
  while (['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state)) {
    assert.ok(Date.now() < deadline, `Task ${task.id} did not converge`);
    await new Promise(resolve => setTimeout(resolve, 20)); task = await rpc(base, token, 'GetTask', { id: task.id });
  }
  return task;
}
async function boot(directory: string, config: ServiceConfig, faultPoint?: string) {
  const path = join(directory, `child-${randomUUID()}.json`);
  await writeFile(path, JSON.stringify({ ...config, faultPoint }), { mode: 0o600 });
  const child = fork('tests/faults/service-child.ts', [path], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let stderr = '', fired: string | undefined;
  child.stderr?.on('data', bytes => { stderr += String(bytes); });
  child.on('message', (message: { event: string; point?: string }) => { if (message.event === 'fault') fired = message.point; });
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Child boot timed out: ${stderr}`)), 10_000);
    child.on('message', (message: { event: string; baseUrl?: string }) => { if (message.event === 'ready') { clearTimeout(timeout); resolve(message.baseUrl!); } });
    child.once('exit', (code, signal) => { clearTimeout(timeout); reject(new Error(`Child exited during boot (${code}/${signal}): ${stderr}`)); });
  });
  return { child, baseUrl, fired: () => fired, stderr: () => stderr };
}
async function shutdown(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'exit');
  child.send({ event: 'shutdown' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { await closed; } finally { clearTimeout(timeout); }
}

test('SIGKILL at each admission/source/parse/embedding/publication window converges three times', { timeout: 240_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-document-faults-'));
  const postgres = new LocalPostgres({ dataDir: join(directory, 'pg'), port: await freePort(), password: randomBytes(24).toString('hex') });
  const modelCalls = new Map<string, number>();
  const model = createHttpServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer fault-fixture');
      const buffers: Buffer[] = []; for await (const part of request) buffers.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(buffers).toString()) as { input: string[] };
      const marker = body.input[0]?.split(' ')[0] ?? '';
      modelCalls.set(marker, (modelCalls.get(marker) ?? 0) + 1);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: body.input.map((_text, index) => ({ index, embedding: [1, ...Array(1023).fill(0)] })) }));
    } catch { response.writeHead(500); response.end('{}'); }
  });
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
  const modelAddress = model.address(); assert.ok(modelAddress && typeof modelAddress !== 'string');
  let administrator: Pool | undefined;
  const cases: Record<string, unknown>[] = [];
  try {
    await postgres.start(); administrator = new Pool({ connectionString: postgres.url });
    const points = ['admission-committed', 'pi-admitted', 'blob-written', 'parse-finished', 'embedding-batch-finished', 'index-staged', 'index-published', 'outbox-handled'];
    for (const point of points) for (let repeat = 1; repeat <= 3; repeat++) {
      const dbName = 'fault_' + randomBytes(8).toString('hex');
      await administrator.query(`CREATE DATABASE ${dbName}`);
      const url = new URL(postgres.url); url.pathname = '/' + dbName;
      const pool = new Pool({ connectionString: url.toString() });
      const scope = `${point}-${repeat}`; const token = randomBytes(24).toString('hex');
      const config: ServiceConfig = { databaseUrl: url.toString(), host: '127.0.0.1', port: 0, blobRoot: join(directory, scope, 'blobs'), piStoragePath: join(directory, scope, 'pi.sqlite'),
        bootstrap: { tenantId: 'faults', principalId: 'owner', token },
        embedding: { baseUrl: `http://127.0.0.1:${modelAddress.port}`, modelId: 'fault-fixture', apiKey: 'fault-fixture', dimensions: 1024, version: '1', normalization: 'l2' },
      };
      let seed: Awaited<ReturnType<typeof startApp>> | undefined;
      let running: Awaited<ReturnType<typeof boot>> | undefined;
      try {
        seed = await startApp(config);
        const kbTask = await send(seed.baseUrl, token, { schemaVersion: '1.0', operation: 'knowledge_base.create', requestId: 'kb', input: { name: '故障注入夹具' } }, false);
        const kbId = kbTask.artifacts![0]!.parts[0]!.data.result.knowledgeBaseId;
        await seed.close(); seed = undefined;
        running = await boot(directory, config, point);
        const request = { schemaVersion: '1.0', operation: 'document.save', requestId: 'fault-save', knowledgeBaseId: kbId, input: {
          title: scope, source: { kind: 'text', mimeType: 'text/plain', text: Array.from({ length: 12 }, (_, i) => `${scope} 第${i + 1}段，进程恢复后只保留一个版本和一个发布代次。`).join('\n\n') }, waitFor: 'indexed',
        } };
        const exited = once(running.child, 'exit');
        await send(running.baseUrl, token, request).catch(() => undefined);
        const timeout = setTimeout(() => running!.child.kill('SIGTERM'), 10_000);
        const [, signal] = await exited; clearTimeout(timeout);
        assert.equal(running.fired(), point, `Fault hook did not fire: ${point}: ${running.stderr()}`);
        assert.equal(signal, 'SIGKILL');
        const before = await pool.query("SELECT id, pi_task_id FROM pd_tasks WHERE operation='document.save' AND kind='operation'");
        assert.equal(before.rowCount, 1);
        const originalId = before.rows[0].id;
        const recoveryStarted = performance.now();
        running = await boot(directory, config);
        const recoveryReadyMs = performance.now() - recoveryStarted;
        assert.ok(recoveryReadyMs <= 30_000);
        const restored = await waitTask(running.baseUrl, token, await send(running.baseUrl, token, request));
        assert.equal(restored.id, originalId); assert.equal(restored.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(restored));
        const counts = await pool.query(`SELECT
          (SELECT count(*)::int FROM pd_documents) AS documents,
          (SELECT count(*)::int FROM pd_document_versions) AS versions,
          (SELECT count(*)::int FROM pd_index_generations WHERE state='ready') AS ready_generations,
          (SELECT count(*)::int FROM pd_indexed_chunks) AS chunks,
          (SELECT count(*)::int FROM pd_tasks WHERE operation='document.save' AND kind='operation') AS save_tasks`);
        assert.deepEqual(counts.rows[0], { documents: 1, versions: 1, ready_generations: 1, chunks: 12, save_tasks: 1 });
        const after = await pool.query('SELECT pi_task_id FROM pd_tasks WHERE id=$1', [originalId]);
        if (before.rows[0].pi_task_id !== null) assert.equal(after.rows[0].pi_task_id, before.rows[0].pi_task_id);
        const replay = await send(running.baseUrl, token, request); assert.equal(replay.id, originalId);
        cases.push({ point, repeat, signal, taskIdStable: true, recoveryReadyMs, recoveryTerminalMs: performance.now() - recoveryStarted, counts: counts.rows[0], modelCalls: modelCalls.get(scope) ?? 0 });
      } finally { await seed?.close(); await shutdown(running?.child); await pool.end(); }
    }
    await mkdir('evidence/m3', { recursive: true });
    await writeFile('evidence/m3/crash-matrix.json', JSON.stringify({ status: 'passed', repeatsPerWindow: 3, cases,
      provider: 'local deterministic HTTP embedding fixture; no quality claims',
      limitation: 'Cancel-accepted and tombstone-vs-publish windows are verified separately; outbox-handled shares the Pi-admission-before-PG-ACK boundary.' }, null, 2) + '\n');
  } finally {
    await administrator?.end(); await postgres.stop();
    await new Promise<void>(resolve => { model.close(() => resolve()); model.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
