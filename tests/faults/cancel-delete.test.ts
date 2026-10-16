import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Pool } from 'pg';
import { startApp } from '../../src/app.js';
import { LocalPostgres } from '../../scripts/support/local-postgres.js';
import type { ServiceConfig } from '../../src/config/service.js';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function bounded<T>(promise: Promise<T>, milliseconds: number) {
  let timer: NodeJS.Timeout;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Fault test timed out')), milliseconds); })]); }
  finally { clearTimeout(timer!); }
}
async function rpc(base: string, token: string, method: string, params: unknown) {
  const response = await fetch(base + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'A2A-Version': '1.0', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal: AbortSignal.timeout(15_000) });
  return await response.json() as { result?: any; error?: { code: number } };
}
async function send(base: string, token: string, data: unknown, immediately = false) {
  const result = await rpc(base, token, 'SendMessage', { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data, mediaType: 'application/json' }] }, configuration: { returnImmediately: immediately, acceptedOutputModes: ['application/json'] } });
  assert.equal(result.error, undefined, JSON.stringify(result)); return result.result.task;
}
async function boot(directory: string, config: ServiceConfig, faultPoint?: string) {
  const path = join(directory, `${randomUUID()}.json`); await writeFile(path, JSON.stringify({ ...config, faultPoint }), { mode: 0o600 });
  const child = fork('tests/faults/service-child.ts', [path], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let fired = ''; let stderr = '';
  child.stderr?.on('data', bytes => { stderr += String(bytes); });
  child.on('message', (message: any) => { if (message.event === 'fault') fired = message.point; });
  const baseUrl = await bounded(new Promise<string>((resolve, reject) => {
    child.on('message', (message: any) => { if (message.event === 'ready') resolve(message.baseUrl); });
    child.once('exit', () => reject(new Error(`Child boot failed: ${stderr}`)));
  }), 10_000);
  return { child, baseUrl, fired: () => fired };
}
async function stop(child?: ChildProcess) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exit = once(child, 'exit'); child.send({ event: 'shutdown' });
  try { await bounded(exit, 5000); } catch { child.kill('SIGKILL'); await exit; }
}

test('SIGKILL after cancel/tombstone cannot revive or publish late model work (three runs each)', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-document-fences-'));
  let held = false; let release = () => {}; let announce = () => {}; let gate = Promise.resolve();
  const provider = createServer(async (request, response) => {
    const buffers: Buffer[] = []; for await (const bytes of request) buffers.push(Buffer.from(bytes));
    const data = JSON.parse(Buffer.concat(buffers).toString()) as { input: string[] };
    if (held) { announce(); await gate; }
    if (!response.destroyed) { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ data: data.input.map((_value, index) => ({ index, embedding: [1, ...Array(1023).fill(0)] })) })); }
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address(); assert.ok(providerAddress && typeof providerAddress !== 'string');
  const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const portAddress = portServer.address(); assert.ok(portAddress && typeof portAddress !== 'string');
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const postgres = new LocalPostgres({ dataDir: join(directory, 'pg'), port: portAddress.port, password: randomBytes(24).toString('hex') });
  let administrator: Pool | undefined;
  const cases: unknown[] = [];
  try {
    await postgres.start(); administrator = new Pool({ connectionString: postgres.url });
    for (const point of ['cancel-accepted', 'tombstone-committed']) for (let repeat = 1; repeat <= 3; repeat++) {
      held = false;
      const name = 'fence_' + randomBytes(8).toString('hex'); await administrator.query(`CREATE DATABASE ${name}`);
      const url = new URL(postgres.url); url.pathname = '/' + name;
      const pool = new Pool({ connectionString: url.toString() });
      const token = randomBytes(24).toString('hex');
      const config: ServiceConfig = { databaseUrl: url.toString(), host: '127.0.0.1', port: 0, blobRoot: join(directory, name, 'blobs'), piStoragePath: join(directory, name, 'pi.sqlite'), bootstrap: { tenantId: 'fence', principalId: 'owner', token },
        embedding: { baseUrl: `http://127.0.0.1:${providerAddress.port}`, modelId: 'fence-fixture', apiKey: 'fixture', dimensions: 1024, version: '1', normalization: 'l2' } };
      let seed: Awaited<ReturnType<typeof startApp>> | undefined; let running: Awaited<ReturnType<typeof boot>> | undefined;
      try {
        seed = await startApp(config);
        const kbTask = await send(seed.baseUrl, token, { schemaVersion: '1.0', operation: 'knowledge_base.create', requestId: 'kb', input: { name: '取消与删除夹具' } });
        const kbId = kbTask.artifacts[0].parts[0].data.result.knowledgeBaseId;
        let original: any;
        if (point === 'tombstone-committed') original = await send(seed.baseUrl, token, { schemaVersion: '1.0', operation: 'document.save', requestId: 'v1', knowledgeBaseId: kbId, input: { title: '旧版', source: { kind: 'text', text: '原始版本可以被检索。' }, waitFor: 'indexed' } });
        const originalDocId = original?.artifacts[0].parts[0].data.result.documentId;
        await seed.close(); seed = undefined;
        running = await boot(directory, config, point);
        gate = new Promise<void>(resolve => { release = resolve; });
        const seen = new Promise<void>(resolve => { announce = resolve; }); held = true;
        const pending = await send(running.baseUrl, token, { schemaVersion: '1.0', operation: original ? 'document.update' : 'document.save', requestId: 'delayed', knowledgeBaseId: kbId,
          input: { ...(original ? { documentId: originalDocId, expectedVersion: 1 } : {}), title: '模型延迟的新版本', source: { kind: 'text', text: '延迟模型返回后不应发布这个新的版本。' }, waitFor: 'indexed' } }, true);
        await bounded(seen, 5000);
        const exited = once(running.child, 'exit');
        if (original) await send(running.baseUrl, token, { schemaVersion: '1.0', operation: 'document.delete', requestId: 'delete', knowledgeBaseId: kbId, input: { documentId: originalDocId, expectedVersion: 1 } }).catch(() => undefined);
        else await rpc(running.baseUrl, token, 'CancelTask', { id: pending.id }).catch(() => undefined);
        const [, signal] = await bounded(exited, 10_000); assert.equal(signal, 'SIGKILL'); assert.equal(running.fired(), point);
        release(); held = false;
        running = await boot(directory, config);
        if (original) {
          const content = await fetch(running.baseUrl + `/v1/documents/${originalDocId}/content?version=1`, { headers: { Authorization: `Bearer ${token}` } });
          assert.equal(content.status, 404);
          assert.equal((await rpc(running.baseUrl, token, 'GetTask', { id: original.id })).error?.code, -32001);
          const purge = await pool.query("SELECT id,state FROM pd_tasks WHERE kind='purge'"); assert.equal(purge.rowCount, 1);
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) { const state = await pool.query('SELECT state FROM pd_tasks WHERE id=$1', [purge.rows[0].id]); if (state.rows[0].state === 'completed') break; await pause(25); }
          assert.equal((await pool.query('SELECT state FROM pd_tasks WHERE id=$1', [purge.rows[0].id])).rows[0].state, 'completed');
          assert.equal((await rpc(running.baseUrl, token, 'GetTask', { id: original.id })).error?.code, -32001, 'purging must not make historical content visible again');
        } else {
          const canceled = await rpc(running.baseUrl, token, 'GetTask', { id: pending.id }); assert.equal(canceled.result.status.state, 'TASK_STATE_CANCELED');
          assert.equal((await pool.query("SELECT count(*)::int AS count FROM pd_index_generations WHERE state='ready'")).rows[0].count, 0);
        }
        const searched = await send(running.baseUrl, token, { schemaVersion: '1.0', operation: 'document.search', requestId: 'after-fence', knowledgeBaseId: kbId, input: { query: '版本', mode: 'keyword', rerank: false } });
        assert.deepEqual(searched.artifacts[0].parts[0].data.result.results, []);
        cases.push({ point, repeat, signal: 'SIGKILL', lateModelResultReleased: true, visibleHitsAfterRecovery: 0 });
      } finally { release(); held = false; await seed?.close(); await stop(running?.child); await pool.end(); }
    }
    await mkdir('evidence/m3', { recursive: true });
    await writeFile('evidence/m3/cancel-delete-crashes.json', JSON.stringify({ status: 'passed', repeatsPerWindow: 3, cases, provider: 'local controlled delayed HTTP embedding fixture' }, null, 2) + '\n');
  } finally { release(); await administrator?.end(); await postgres.stop(); await new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); }
});
