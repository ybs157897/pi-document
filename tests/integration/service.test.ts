import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import EmbeddedPostgres from 'embedded-postgres';
import { startApp } from '../../src/app.js';
import type { BusinessResult, DocumentRequest, Principal } from '../../src/domain/types.js';
import type { ServiceConfig } from '../../src/config/service.js';

type WireTask = { id: string; contextId: string; status: { state: string }; artifacts?: { parts: { data?: BusinessResult }[] }[] };
async function freePort() {
  const socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address(); assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => socket.close(() => resolve())); return address.port;
}

test('real HTTP + Pi + PostgreSQL: create/save/read, 20 retries, isolation, ACL revocation and reopen', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-document-integration-'));
  const port = await freePort(); const password = randomBytes(24).toString('hex');
  const postgres = new EmbeddedPostgres({ databaseDir: join(directory, 'pg'), user: 'postgres', password, port, persistent: false,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => undefined, onError: () => undefined,
  });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  const tokenA = randomBytes(24).toString('hex'); const tokenB = randomBytes(24).toString('hex');
  const actorB: Principal = { tenantId: 'fixture-tenant', id: 'reader', scopes: ['knowledge:read', 'knowledge:write'] };
  const config: ServiceConfig = { host: '127.0.0.1', port: 0,
    databaseUrl: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
    piStoragePath: join(directory, 'pi.sqlite'), blobRoot: join(directory, 'blobs'),
    bootstrap: { tenantId: 'fixture-tenant', principalId: 'owner', token: tokenA },
  };
  let rpcId = 0;
  async function raw(method: string, params: unknown, token = tokenA) {
    const response = await fetch(app!.baseUrl + '/a2a', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${token}`,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const body = await response.json() as { result?: { task?: WireTask } & Partial<WireTask>; error?: { code: number; message: string } };
    return { status: response.status, body };
  }
  function getTask(body: Awaited<ReturnType<typeof raw>>['body']): WireTask {
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    const task = body.result?.task ?? body.result;
    assert.ok(task?.id, JSON.stringify(body)); return task as WireTask;
  }
  async function submit(request: DocumentRequest, token = tokenA, contextId?: string) {
    return getTask((await raw('SendMessage', { message: { messageId: `msg-${++rpcId}`, role: 'ROLE_USER', parts: [{ data: request, mediaType: 'application/json' }], ...(contextId ? { contextId } : {}) }, configuration: { returnImmediately: true, acceptedOutputModes: ['application/json'] } }, token)).body);
  }
  async function done(task: WireTask, token = tokenA) {
    const deadline = Date.now() + 5000;
    while (['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING'].includes(task.status.state)) {
      assert.ok(Date.now() < deadline, `task ${task.id} did not finish`);
      await new Promise(resolve => setTimeout(resolve, 25));
      task = getTask((await raw('GetTask', { id: task.id }, token)).body);
    }
    return task;
  }
  function result(task: WireTask): BusinessResult {
    const payload = task.artifacts?.flatMap(artifact => artifact.parts).find(part => part.data)?.data;
    assert.ok(payload, JSON.stringify(task)); return payload;
  }
  try {
    await postgres.initialise(); await postgres.start();
    app = await startApp(config);
    await assert.rejects(startApp({ ...config, piStoragePath: join(directory, 'other-owner.sqlite') }), /DATABASE_ALREADY_OWNED/);
    await app.backend.provisionPrincipal({ ...actorB, token: tokenB });
    const kb = result(await done(await submit({ schemaVersion: '1.0', operation: 'knowledge_base.create', requestId: 'kb-create', input: { name: '实施验收知识库' } })));
    assert.equal(kb.outcome, 'succeeded');
    const knowledgeBaseId = kb.result!.knowledgeBaseId as string;
    const text = '# 重启验收 😀\n编号 PI-2026-001。保存的字节必须原样保留。\n';
    const save: DocumentRequest = { schemaVersion: '1.0', operation: 'document.save', requestId: 'save-one', knowledgeBaseId, input: { title: '恢复试验', source: { kind: 'text', text, mimeType: 'text/markdown' }, waitFor: 'stored' } };
    const savedTask = await done(await submit(save));
    assert.equal(savedTask.status.state, 'TASK_STATE_COMPLETED');
    const saved = result(savedTask);
    assert.equal(saved.result?.indexState, 'stored');
    assert.equal(saved.result?.sha256, createHash('sha256').update(text).digest('hex'));
    assert.equal(saved.result?.version, 1);
    assert.equal(typeof saved.result?.ingestionTaskId, 'string');
    const docId = saved.result!.documentId as string;
    const audit = await app.pool.query('SELECT operation,state,principal_id FROM pd_audit_log WHERE task_id=$1 ORDER BY id', [savedTask.id]);
    assert.ok(audit.rows.some(row => row.state === 'completed' && row.operation === 'document.save' && row.principal_id === 'owner'));
    assert.ok(!JSON.stringify(audit.rows).includes(text));
    const metrics = await fetch(app.baseUrl + '/metrics', { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(metrics.status, 200); assert.ok((await metrics.text()).includes('pi_document_tasks'));
    assert.equal((await fetch(app.baseUrl + '/metrics', { headers: { Authorization: `Bearer ${tokenB}` } })).status, 403);
    const repetitions = await Promise.all(Array.from({ length: 20 }, () => submit(save)));
    assert.ok(repetitions.every(task => task.id === savedTask.id));
    const conflict = await raw('SendMessage', { message: { messageId: 'conflict', role: 'ROLE_USER', parts: [{ data: { ...save, input: { ...save.input, title: 'different' } }, mediaType: 'application/json' }] } });
    assert.equal(conflict.body.error?.code, -32602);
    const forbiddenTask = await raw('GetTask', { id: savedTask.id }, tokenB);
    assert.equal(forbiddenTask.body.error?.code, -32001);
    const beforeGrant = await fetch(app.baseUrl + `/v1/documents/${docId}/content?version=1`, { headers: { Authorization: `Bearer ${tokenB}` } });
    assert.ok([403, 404].includes(beforeGrant.status));
    await app.backend.grantKnowledgeBase(actorB, knowledgeBaseId);
    const readRequest: DocumentRequest = { schemaVersion: '1.0', operation: 'document.get', requestId: 'read-one', knowledgeBaseId, input: { documentId: docId } };
    const readTask = await done(await submit(readRequest, tokenB), tokenB);
    assert.equal(result(readTask).outcome, 'succeeded');
    assert.equal((result(readTask).result!.content as { text: string }).text, text);
    const downloaded = await fetch(app.baseUrl + `/v1/documents/${docId}/content?version=1`, { headers: { Authorization: `Bearer ${tokenB}` } });
    assert.equal(downloaded.status, 200); assert.equal(await downloaded.text(), text);
    await app.backend.revokeKnowledgeBase(actorB, knowledgeBaseId);
    assert.equal((await raw('GetTask', { id: readTask.id }, tokenB)).body.error?.code, -32001);
    const indexed = result(await done(await submit({ ...save, requestId: 'unsupported-indexed', input: { ...save.input, waitFor: 'indexed' } })));
    assert.equal(indexed.outcome, 'failed');
    const address = new URL(app.baseUrl); config.port = Number(address.port);
    await app.close(); app = undefined;
    app = await startApp(config);
    const restored = getTask((await raw('GetTask', { id: savedTask.id })).body);
    assert.equal(restored.status.state, 'TASK_STATE_COMPLETED');
    assert.deepEqual(result(restored), saved);
    assert.equal((await submit(save)).id, savedTask.id);
    const source = await fetch(app.baseUrl + `/v1/documents/${docId}/content?version=1`, { headers: { Authorization: `Bearer ${tokenA}` } });
    assert.equal(await source.text(), text);
    const rotatedToken = randomBytes(24).toString('hex');
    await app.backend.provisionPrincipal({ tenantId: 'fixture-tenant', id: 'owner', scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'], token: rotatedToken });
    await app.close(); app = undefined;
    app = await startApp(config);
    assert.equal(await app.backend.authenticate(tokenA), undefined, 'bootstrap must not reactivate a rotated credential');
    assert.equal((await app.backend.authenticate(rotatedToken))?.id, 'owner');
  } finally {
    await app?.close(); await postgres.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
