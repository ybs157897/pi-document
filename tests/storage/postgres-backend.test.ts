import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createRequire } from 'node:module';
import EmbeddedPostgres from 'embedded-postgres';
import { Pool } from 'pg';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { DomainError, type DocumentRequest, type Principal, type Scope } from '../../src/domain/types.js';
import { PostgresDocumentBackend, migrate } from '../../src/domain/service.js';

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
require('ajv-formats')(ajv);
const resultSchema = JSON.parse(await (await import('node:fs/promises')).readFile('contracts/document-result.schema.json', 'utf8'));
const validateResult = ajv.compile(resultSchema);

type Environment = {
  root: string;
  postgres: EmbeddedPostgres;
  pool: Pool;
  backend: PostgresDocumentBackend;
};
let environment: Environment;

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function startEnvironment(): Promise<Environment> {
  const root = await mkdtemp(join(tmpdir(), 'pi-document-storage-test-'));
  const port = await reservePort();
  const password = randomUUID();
  const postgres = new EmbeddedPostgres({
    databaseDir: join(root, 'postgres'), port, user: 'postgres', password, persistent: false,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => undefined, onError: console.error,
  });
  let pool: Pool | undefined;
  try {
    await postgres.initialise();
    await postgres.start();
    pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 8 });
    await migrate(pool);
    await migrate(pool);
    return {
      root,
      postgres,
      pool,
      backend: new PostgresDocumentBackend({
        pool,
        blobRoot: join(root, 'blobs'),
        publicBaseUrl: 'https://documents.example.test',
      }),
    };
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await postgres.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

before(async () => { environment = await startEnvironment(); });
after(async () => {
  await environment?.pool.end();
  await environment?.postgres.stop();
  if (environment) await rm(environment.root, { recursive: true, force: true });
});

const scopes: Scope[] = ['knowledge:read', 'knowledge:write', 'knowledge:delete'];
async function provision(id: string, tenantId = `tenant-${id}`, allowedScopes: Scope[] = scopes): Promise<Principal> {
  const token = `opaque-${id}-${randomUUID()}`;
  await environment.backend.provisionPrincipal({ tenantId, id, scopes: allowedScopes, token });
  const principal = await environment.backend.authenticate(token);
  assert.ok(principal);
  return principal;
}

async function createKb(principal: Principal, requestId = `kb-${randomUUID()}`): Promise<{ id: string; taskId: string }> {
  const request: DocumentRequest = {
    schemaVersion: '1.0', operation: 'knowledge_base.create', requestId,
    input: { name: `KB ${requestId}`, description: 'M1 test knowledge base' },
  };
  const task = await environment.backend.admit(principal, request);
  const result = await environment.backend.execute(task.id, new AbortController().signal);
  assert.equal(result.outcome, 'succeeded');
  const knowledgeBaseId = (result.result as { knowledgeBaseId: string }).knowledgeBaseId;
  return { id: knowledgeBaseId, taskId: task.id };
}

function saveRequest(knowledgeBaseId: string, requestId: string, text: string, waitFor?: 'stored' | 'indexed'): DocumentRequest {
  return {
    schemaVersion: '1.0', operation: 'document.save', requestId, knowledgeBaseId,
    input: {
      source: { kind: 'text', text, mimeType: 'text/markdown' },
      title: 'M1 source document', tags: ['m1', 'storage'],
      ...(waitFor ? { waitFor } : {}),
    },
  };
}

function resultOf(task: { result: { result?: Record<string, unknown>; outcome: string } | null }): Record<string, unknown> {
  assert.ok(task.result);
  assert.equal(task.result.outcome, 'succeeded');
  return task.result.result ?? {};
}

async function countRows(table: 'pd_documents' | 'pd_document_versions' | 'pd_blobs' | 'pd_tasks', tenantId: string): Promise<number> {
  const result = await environment.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  return result.rows[0]!.count;
}

let naturalSchemaReady = false;
async function applyNaturalSchema(): Promise<void> {
  if (naturalSchemaReady) return;
  const sql = await readFile(new URL('../../migrations/004_natural_tasks.sql', import.meta.url), 'utf8');
  await environment.pool.query(sql);
  naturalSchemaReady = true;
}

async function insertNaturalTask(
  principal: Principal,
  contextId: string,
  options: { childTaskId?: string; request?: DocumentRequest } = {},
): Promise<string> {
  const taskId = `agt_${randomUUID()}`;
  await environment.pool.query(
    `INSERT INTO pd_agent_contexts (tenant_id, context_id, principal_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [principal.tenantId, contextId, principal.id],
  );
  await environment.pool.query(
    `INSERT INTO pd_agent_tasks (tenant_id, task_id, principal_id, context_id, current_turn_no, state, answer_text)
     VALUES ($1, $2, $3, $4, 1, 'completed', 'answer with referenced document')`,
    [principal.tenantId, taskId, principal.id, contextId],
  );
  if (options.request) {
    const sequence = await environment.pool.query<{ sequence: string }>(
      `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence FROM pd_agent_turns WHERE tenant_id = $1 AND context_id = $2`,
      [principal.tenantId, contextId],
    );
    await environment.pool.query(
      `INSERT INTO pd_agent_turns
        (tenant_id, task_id, turn_no, sequence_no, principal_id, context_id, message_id, payload_hash, input_text, submission_key, state, deadline_at)
       VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'fixture input', $8, 'completed', now() + interval '1 hour')`,
      [principal.tenantId, taskId, sequence.rows[0]!.sequence, principal.id, contextId,
        `message-${randomUUID()}`, createHash('sha256').update(randomUUID()).digest('hex'), `submission-${randomUUID()}`],
    );
    await environment.pool.query(
      `INSERT INTO pd_agent_actions
        (tenant_id, action_id, task_id, turn_no, principal_id, context_id, operation, payload_hash, request_id, request, state, child_task_id, fence)
       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, 'completed', $10, 1)`,
      [principal.tenantId, randomUUID(), taskId, principal.id, contextId, options.request.operation,
        createHash('sha256').update(randomUUID()).digest('hex'), options.request.requestId, options.request, options.childTaskId ?? null],
    );
  }
  return taskId;
}

async function insertWorkingNaturalParent(principal: Principal, contextId: string): Promise<{ taskId: string; fence: number }> {
  const taskId = `agt_${randomUUID()}`;
  const fence = 1;
  await environment.pool.query(
    `INSERT INTO pd_agent_contexts (tenant_id, context_id, principal_id)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [principal.tenantId, contextId, principal.id],
  );
  const sequence = await environment.pool.query<{ sequence: string }>(
    `SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence FROM pd_agent_turns WHERE tenant_id = $1 AND context_id = $2`,
    [principal.tenantId, contextId],
  );
  await environment.pool.query(
    `INSERT INTO pd_agent_tasks (tenant_id, task_id, principal_id, context_id, current_turn_no, state, fence)
     VALUES ($1, $2, $3, $4, 1, 'working', $5)`,
    [principal.tenantId, taskId, principal.id, contextId, fence],
  );
  await environment.pool.query(
    `INSERT INTO pd_agent_turns
       (tenant_id, task_id, turn_no, sequence_no, principal_id, context_id, message_id, payload_hash,
        input_text, submission_key, state, deadline_at, started_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, 'fixture action turn', $8, 'working', now() + interval '1 hour', now())`,
    [principal.tenantId, taskId, sequence.rows[0]!.sequence, principal.id, contextId,
      `fixture-message-${randomUUID()}`, createHash('sha256').update(randomUUID()).digest('hex'), `fixture-submit-${randomUUID()}`],
  );
  await environment.pool.query(
    `UPDATE pd_agent_contexts SET active_task_id = $4, active_turn_no = 1
     WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3`,
    [principal.tenantId, contextId, principal.id, taskId],
  );
  return { taskId, fence };
}

async function insertNaturalActionIntent(
  principal: Principal, contextId: string, taskId: string, fence: number, request: DocumentRequest,
): Promise<string> {
  const actionId = randomUUID();
  await environment.pool.query(
    `INSERT INTO pd_agent_actions
       (tenant_id, action_id, task_id, turn_no, principal_id, context_id, operation, payload_hash, request_id, request, state, fence)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, 'intent', $10)`,
    [principal.tenantId, actionId, taskId, principal.id, contextId, request.operation,
      createHash('sha256').update(randomUUID()).digest('hex'), request.requestId, request, fence],
  );
  return actionId;
}

test('task admission enforces global, tenant, and principal active limits under concurrent PostgreSQL transactions', { timeout: 60_000 }, async () => {
  const tenantA = 'tenant-admission-limits-a';
  const tenantB = 'tenant-admission-limits-b';
  const ownerA1 = await provision('admission-limits-a1', tenantA);
  const ownerA2 = await provision('admission-limits-a2', tenantA);
  const ownerA3 = await provision('admission-limits-a3', tenantA);
  const ownerB1 = await provision('admission-limits-b1', tenantB);
  const ownerB2 = await provision('admission-limits-b2', tenantB);
  const ownerC = await provision('admission-limits-c1', 'tenant-admission-limits-c');
  const admittedIds: string[] = [];
  let requestSequence = 0;
  const newListRequest = (): DocumentRequest => ({
    schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `quota-task-${requestSequence++}-${randomUUID()}`, input: {},
  });
  const admitCount = async (principal: Principal, count: number) => {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const task = await environment.backend.admit(principal, newListRequest());
      assert.equal(task.state, 'submitted');
      ids.push(task.id);
      admittedIds.push(task.id);
    }
    return ids;
  };
  const capacityError = (scope: 'principal' | 'tenant' | 'service') => (error: unknown) =>
    error instanceof DomainError && error.code === 'TASK_CAPACITY_EXCEEDED' && error.status === 429
      && error.retryable && error.message.includes(scope);

  try {
    const ownerA1Tasks = await admitCount(ownerA1, 31);
    const concurrentRequests = [newListRequest(), newListRequest()];
    const concurrent = await Promise.allSettled([
      environment.backend.admit(ownerA1, concurrentRequests[0]!),
      environment.backend.admit(ownerA1, concurrentRequests[1]!),
    ]);
    const acceptedIndex = concurrent.findIndex(result => result.status === 'fulfilled');
    const rejectedIndex = concurrent.findIndex(result => result.status === 'rejected');
    assert.notEqual(acceptedIndex, -1);
    assert.notEqual(rejectedIndex, -1);
    const accepted = concurrent[acceptedIndex]!;
    const rejected = concurrent[rejectedIndex]!;
    assert.equal(accepted.status, 'fulfilled');
    assert.equal(rejected.status, 'rejected');
    if (accepted.status === 'fulfilled' && rejected.status === 'rejected') {
      admittedIds.push(accepted.value.id);
      assert.ok(capacityError('principal')(rejected.reason));
      assert.equal((await environment.backend.admit(ownerA1, concurrentRequests[acceptedIndex]!)).id, accepted.value.id);
    }
    assert.equal(ownerA1Tasks.length + 1, 32);

    await admitCount(ownerA2, 32);
    await assert.rejects(environment.backend.admit(ownerA3, newListRequest()), capacityError('tenant'));
    assert.equal(await countRows('pd_tasks', tenantA), 64);

    await admitCount(ownerB1, 32);
    await admitCount(ownerB2, 32);
    await assert.rejects(environment.backend.admit(ownerC, newListRequest()), capacityError('service'));
    assert.equal(await countRows('pd_tasks', tenantB), 64);
    const active = await environment.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pd_tasks WHERE state IN ('submitted', 'working')`,
    );
    assert.equal(active.rows[0]?.count, 128);
  } finally {
    if (admittedIds.length) await environment.pool.query(`DELETE FROM pd_tasks WHERE id = ANY($1::text[])`, [admittedIds]);
  }
});

test('task pages use persistent keyset cursors and exclude tasks created after the snapshot', { timeout: 30_000 }, async () => {
  const principal = await provision('owner-task-page-base');
  const kb = await createKb(principal);
  const contextId = `task-page-base-${randomUUID()}`;
  const createdIds: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const task = await environment.backend.admit(principal, {
      schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `task-page-base-${index}-${randomUUID()}`, input: {},
    }, contextId);
    assert.equal((await environment.backend.execute(task.id, new AbortController().signal)).outcome, 'succeeded');
    createdIds.push(task.id);
  }
  const first = await environment.backend.listTaskPage(principal, { contextId, limit: 2, includeArtifacts: false });
  assert.equal(first.totalSize, 5);
  assert.deepEqual(first.taskIds, createdIds.slice(0, 2));
  assert.ok(first.nextCursor);

  const secondPrincipal = await provision('reader-task-page-base', principal.tenantId, ['knowledge:read']);
  await assert.rejects(environment.backend.listTaskPage(secondPrincipal, { contextId, limit: 2, cursor: first.nextCursor }),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR');
  await assert.rejects(environment.backend.listTaskPage(principal, { contextId, limit: 2, cursor: first.nextCursor, includeArtifacts: true }),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR');
  await assert.rejects(environment.backend.listTaskPage(principal, { contextId, limit: 101 }),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_PAGE_SIZE');

  const insertedAfterSnapshot = await environment.backend.admit(principal, {
    schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `task-page-late-${randomUUID()}`, input: {},
  }, contextId);
  assert.equal((await environment.backend.execute(insertedAfterSnapshot.id, new AbortController().signal)).outcome, 'succeeded');

  const reopenedBackend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'task-page-cursor-blobs'), publicBaseUrl: 'https://documents.example.test',
  });
  const accumulated = [...first.taskIds];
  let cursor: string | undefined = first.nextCursor;
  let totalSize = first.totalSize;
  while (cursor) {
    const page = await reopenedBackend.listTaskPage(principal, { contextId, limit: 2, cursor, includeArtifacts: false });
    assert.equal(page.totalSize, 5);
    totalSize = page.totalSize;
    accumulated.push(...page.taskIds);
    cursor = page.nextCursor;
  }
  assert.equal(totalSize, 5);
  assert.deepEqual(accumulated, createdIds);
  assert.equal(accumulated.includes(insertedAfterSnapshot.id), false);
  await environment.pool.query(`UPDATE pd_task_page_cursors SET expires_at = now() - interval '1 second' WHERE id = $1`, [first.nextCursor]);
  await assert.rejects(environment.backend.listTaskPage(principal, { contextId, limit: 2, cursor: first.nextCursor }),
    (error: unknown) => error instanceof DomainError && error.code === 'CURSOR_EXPIRED');
  await environment.backend.listTaskPage(principal, { contextId, limit: 2 });
  const expiredTaskCursor = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_task_page_cursors WHERE id = $1`, [first.nextCursor],
  );
  assert.equal(expiredTaskCursor.rows[0]?.count, 0);
});

test('task pages union natural metadata and invalidate cursors when source documents are tombstoned', { timeout: 60_000 }, async () => {
  await applyNaturalSchema();
  const principal = await provision('owner-task-page-natural');
  const kb = await createKb(principal);
  const contextId = `task-page-natural-${randomUUID()}`;
  const saveTask = await environment.backend.admit(principal, saveRequest(kb.id, `task-page-save-${randomUUID()}`, 'natural task referenced source', 'stored'), contextId);
  const saveResult = await environment.backend.execute(saveTask.id, new AbortController().signal);
  assert.equal(saveResult.outcome, 'succeeded');
  const saved = saveResult.result as { documentId: string; ingestionTaskId: string };
  await environment.backend.execute(saved.ingestionTaskId, new AbortController().signal);
  const getRequest: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.get', requestId: `task-page-get-${randomUUID()}`,
    knowledgeBaseId: kb.id, input: { documentId: saved.documentId },
  };
  const getTask = await environment.backend.admit(principal, getRequest, contextId);
  assert.equal((await environment.backend.execute(getTask.id, new AbortController().signal)).outcome, 'succeeded');
  const naturalIds = [
    await insertNaturalTask(principal, contextId, { childTaskId: getTask.id, request: getRequest }),
    await insertNaturalTask(principal, contextId),
    await insertNaturalTask(principal, contextId),
  ];
  for (let index = 0; index < 3; index += 1) {
    const task = await environment.backend.admit(principal, {
      schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `task-page-natural-list-${index}-${randomUUID()}`, input: {},
    }, contextId);
    assert.equal((await environment.backend.execute(task.id, new AbortController().signal)).outcome, 'succeeded');
  }

  const businessIds = (await environment.backend.listTasks(principal, contextId)).map(task => task.id);
  const businessOnly = await environment.backend.listTaskPage(principal, { contextId, limit: 100, includeNatural: false });
  assert.equal(businessOnly.totalSize, businessIds.length);
  for (const naturalId of naturalIds) assert.equal(businessOnly.taskIds.includes(naturalId), false);
  const businessOnlyFirst = await environment.backend.listTaskPage(principal, { contextId, limit: 2, includeNatural: false });
  assert.ok(businessOnlyFirst.nextCursor);
  await assert.rejects(environment.backend.listTaskPage(principal, {
    contextId, limit: 2, cursor: businessOnlyFirst.nextCursor, includeNatural: true,
  }), (error: unknown) => error instanceof DomainError && error.code === 'INVALID_CURSOR');

  const pageIds: string[] = [];
  let page = await environment.backend.listTaskPage(principal, { contextId, limit: 2 });
  const firstCursor = page.nextCursor;
  assert.ok(firstCursor);
  assert.equal(page.totalSize, businessIds.length + naturalIds.length);
  while (true) {
    pageIds.push(...page.taskIds);
    if (!page.nextCursor) break;
    page = await environment.backend.listTaskPage(principal, { contextId, limit: 2, cursor: page.nextCursor });
  }
  assert.equal(new Set(pageIds).size, pageIds.length);
  assert.deepEqual(new Set(pageIds), new Set([...businessIds, ...naturalIds]));

  const deleteTask = await environment.backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.delete', requestId: `task-page-delete-${randomUUID()}`,
    knowledgeBaseId: kb.id, input: { documentId: saved.documentId, expectedVersion: 1 },
  }, contextId);
  const deleted = await environment.backend.execute(deleteTask.id, new AbortController().signal);
  assert.equal(deleted.outcome, 'succeeded');
  const purgeTaskId = (deleted.result as { purgeTaskId: string }).purgeTaskId;
  await assert.rejects(environment.backend.listTaskPage(principal, { contextId, limit: 2, cursor: firstCursor }),
    (error: unknown) => error instanceof DomainError && error.code === 'CURSOR_EXPIRED');

  const current = await environment.backend.listTaskPage(principal, { contextId, limit: 100 });
  assert.equal(current.taskIds.includes(deleteTask.id), true);
  assert.equal(current.taskIds.includes(purgeTaskId), true);
  assert.equal(current.taskIds.includes(getTask.id), false);
  assert.equal(current.taskIds.includes(saveTask.id), false);
  for (const naturalId of naturalIds) assert.equal(current.taskIds.includes(naturalId), false);
});

test('pending task pump excludes natural action children until natural runtime dispatches them', { timeout: 30_000 }, async () => {
  await applyNaturalSchema();
  const owner = await provision('owner-pending-action-barrier');
  const otherOwner = await provision('other-pending-action-barrier', owner.tenantId);
  const otherTenantOwner = await provision('other-tenant-pending-action-barrier');
  const contextId = `pending-action-barrier-${randomUUID()}`;
  const request: DocumentRequest = {
    schemaVersion: '1.0', operation: 'knowledge_base.create', requestId: `pending-action-shared-${randomUUID()}`,
    input: { name: 'unlinked natural action child' },
  };
  const contextBootstrap = await environment.backend.admit(owner, {
    schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `pending-action-context-${randomUUID()}`, input: {},
  }, contextId);
  assert.equal((await environment.backend.execute(contextBootstrap.id, new AbortController().signal)).outcome, 'succeeded');
  await insertNaturalTask(owner, contextId, { request });
  const child = await environment.backend.admit(owner, request, contextId);
  const sameTenantCollision = await environment.backend.admit(otherOwner, request);
  const otherTenantCollision = await environment.backend.admit(otherTenantOwner, request);
  const beforeLink = await environment.backend.pendingTasks();
  assert.equal(beforeLink.some(task => task.id === child.id), false);
  assert.equal(beforeLink.some(task => task.id === sameTenantCollision.id), true);
  assert.equal(beforeLink.some(task => task.id === otherTenantCollision.id), true);

  const action = await environment.pool.query<{ action_id: string }>(
    `SELECT action_id FROM pd_agent_actions WHERE tenant_id = $1 AND principal_id = $2 AND request_id = $3 AND child_task_id IS NULL`,
    [owner.tenantId, owner.id, request.requestId],
  );
  assert.ok(action.rows[0]);
  await environment.pool.query(
    `UPDATE pd_agent_actions SET child_task_id = $4, state = 'admitted', updated_at = now()
     WHERE tenant_id = $1 AND principal_id = $2 AND action_id = $3`,
    [owner.tenantId, owner.id, action.rows[0]!.action_id, child.id],
  );
  assert.equal((await environment.backend.pendingTasks()).some(task => task.id === child.id), false);
});

test('pending task action barrier hides natural operation parents while preserving ingestion and purge children', { timeout: 30_000 }, async () => {
  await applyNaturalSchema();
  const owner = await provision('owner-pending-action-child-kinds');
  const contextId = `pending-action-child-kinds-${randomUUID()}`;
  const kb = await createKb(owner);
  const contextBootstrap = await environment.backend.admit(owner, {
    schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `pending-action-context-${randomUUID()}`, input: {},
  }, contextId);
  assert.equal((await environment.backend.execute(contextBootstrap.id, new AbortController().signal)).outcome, 'succeeded');
  const naturalParent = await insertWorkingNaturalParent(owner, contextId);

  const save = saveRequest(kb.id, `pending-ingestion-${randomUUID()}`, 'Stored text with an ingestion child.', 'stored');
  const saveActionId = await insertNaturalActionIntent(owner, contextId, naturalParent.taskId, naturalParent.fence, save);
  const saveParent = await environment.backend.admit(owner, save, contextId);
  assert.equal((await environment.backend.pendingTasks()).some(task => task.id === saveParent.id), false,
    'the natural-owned save operation must remain hidden from the generic pump');
  await environment.pool.query(
    `UPDATE pd_agent_actions SET child_task_id = $3, state = 'dispatching' WHERE tenant_id = $1 AND action_id = $2`,
    [owner.tenantId, saveActionId, saveParent.id],
  );
  const savedResult = await environment.backend.execute(saveParent.id, new AbortController().signal);
  assert.equal(savedResult.outcome, 'succeeded');
  await environment.pool.query(`UPDATE pd_agent_actions SET state = 'completed' WHERE tenant_id = $1 AND action_id = $2`,
    [owner.tenantId, saveActionId]);
  const saved = savedResult.result as { documentId: string; ingestionTaskId: string };
  assert.ok((await environment.backend.pendingTasks()).some(task => task.id === saved.ingestionTaskId),
    'the stored document ingestion child must remain visible to the generic pump');

  const deletion: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.delete', requestId: `pending-purge-${randomUUID()}`,
    knowledgeBaseId: kb.id, input: { documentId: saved.documentId, expectedVersion: 1 },
  };
  const deleteActionId = await insertNaturalActionIntent(owner, contextId, naturalParent.taskId, naturalParent.fence, deletion);
  const deleteParent = await environment.backend.admit(owner, deletion, contextId);
  assert.equal((await environment.backend.pendingTasks()).some(task => task.id === deleteParent.id), false,
    'the natural-owned delete operation must remain hidden from the generic pump');
  await environment.pool.query(
    `UPDATE pd_agent_actions SET child_task_id = $3, state = 'dispatching' WHERE tenant_id = $1 AND action_id = $2`,
    [owner.tenantId, deleteActionId, deleteParent.id],
  );
  const deleted = await environment.backend.execute(deleteParent.id, new AbortController().signal);
  assert.equal(deleted.outcome, 'succeeded');
  await environment.pool.query(`UPDATE pd_agent_actions SET state = 'completed' WHERE tenant_id = $1 AND action_id = $2`,
    [owner.tenantId, deleteActionId]);
  const purgeTaskId = (deleted.result as { purgeTaskId: string }).purgeTaskId;
  assert.ok((await environment.backend.pendingTasks()).some(task => task.id === purgeTaskId),
    'the delete purge child must remain visible to the generic pump');
});

test('a stale natural dispatch cannot execute an operation after its parent fence is canceled', { timeout: 30_000 }, async () => {
  await applyNaturalSchema();
  const owner = await provision('owner-canceled-natural-dispatch');
  const contextId = `canceled-natural-dispatch-${randomUUID()}`;
  const request: DocumentRequest = {
    schemaVersion: '1.0', operation: 'knowledge_base.create', requestId: `canceled-dispatch-${randomUUID()}`,
    input: { name: `must-not-create-${randomUUID()}` },
  };
  const bootstrap = await environment.backend.admit(owner, {
    schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `canceled-dispatch-context-${randomUUID()}`, input: {},
  }, contextId);
  assert.equal((await environment.backend.execute(bootstrap.id, new AbortController().signal)).outcome, 'succeeded');

  const parentTaskId = `agt_${randomUUID()}`;
  const actionId = randomUUID();
  const fence = 7;
  const payloadHash = createHash('sha256').update(request.requestId).digest('hex');
  await environment.pool.query(
    `INSERT INTO pd_agent_contexts (tenant_id, context_id, principal_id) VALUES ($1, $2, $3)`,
    [owner.tenantId, contextId, owner.id],
  );
  await environment.pool.query(
    `INSERT INTO pd_agent_tasks (tenant_id, task_id, principal_id, context_id, current_turn_no, state, fence)
     VALUES ($1, $2, $3, $4, 1, 'working', $5)`,
    [owner.tenantId, parentTaskId, owner.id, contextId, fence],
  );
  await environment.pool.query(
    `UPDATE pd_agent_contexts SET active_task_id = $4, active_turn_no = 1 WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3`,
    [owner.tenantId, contextId, owner.id, parentTaskId],
  );
  await environment.pool.query(
    `INSERT INTO pd_agent_turns
       (tenant_id, task_id, turn_no, sequence_no, principal_id, context_id, message_id, payload_hash,
        input_text, submission_key, state, deadline_at, started_at)
     VALUES ($1, $2, 1, 1, $3, $4, $5, $6, 'create a knowledge base', $7, 'working', now() + interval '1 hour', now())`,
    [owner.tenantId, parentTaskId, owner.id, contextId, `canceled-dispatch-message-${randomUUID()}`, payloadHash, `canceled-dispatch-submit-${randomUUID()}`],
  );
  await environment.pool.query(
    `INSERT INTO pd_agent_actions
       (tenant_id, action_id, task_id, turn_no, principal_id, context_id, operation, payload_hash, request_id, request, state, fence)
     VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, 'dispatching', $10)`,
    [owner.tenantId, actionId, parentTaskId, owner.id, contextId, request.operation, payloadHash, request.requestId, request, fence],
  );
  const child = await environment.backend.admit(owner, request, contextId);
  await environment.pool.query(
    `UPDATE pd_agent_actions SET child_task_id = $3 WHERE tenant_id = $1 AND action_id = $2`,
    [owner.tenantId, actionId, child.id],
  );
  await environment.pool.query(
    `UPDATE pd_agent_tasks SET state = 'cancel_requested', fence = fence + 1, updated_at = now()
     WHERE tenant_id = $1 AND task_id = $2`,
    [owner.tenantId, parentTaskId],
  );

  const result = await environment.backend.execute(child.id, new AbortController().signal);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'CANCELED');
  assert.equal((await environment.backend.getTask(owner, child.id)).state, 'canceled');
  const created = await environment.pool.query(`SELECT 1 FROM pd_knowledge_bases WHERE tenant_id = $1 AND name = $2`, [
    owner.tenantId, request.input.name,
  ]);
  assert.equal(created.rowCount, 0, 'an operation callback authorized before the fence must not publish after cancellation');
});

test('task page cursors expire after membership revocation hides natural child artifacts', { timeout: 60_000 }, async () => {
  await applyNaturalSchema();
  const owner = await provision('owner-task-page-revoke');
  const reader = await provision('reader-task-page-revoke', owner.tenantId, ['knowledge:read']);
  const kb = await createKb(owner);
  await environment.backend.grantKnowledgeBase(reader, kb.id, ['knowledge:read']);
  const savedResult = await environment.backend.execute(
    (await environment.backend.admit(owner, saveRequest(kb.id, `task-page-revoke-save-${randomUUID()}`, 'revocable task content', 'stored'))).id,
    new AbortController().signal,
  );
  const saved = savedResult.result as { documentId: string; ingestionTaskId: string };
  await environment.backend.execute(saved.ingestionTaskId, new AbortController().signal);

  const contextId = `task-page-revoke-${randomUUID()}`;
  const getRequest: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.get', requestId: `task-page-revoke-get-${randomUUID()}`,
    knowledgeBaseId: kb.id, input: { documentId: saved.documentId },
  };
  const getTask = await environment.backend.admit(reader, getRequest, contextId);
  assert.equal((await environment.backend.execute(getTask.id, new AbortController().signal)).outcome, 'succeeded');
  const naturalId = await insertNaturalTask(reader, contextId, { childTaskId: getTask.id, request: getRequest });
  for (let index = 0; index < 2; index += 1) {
    const listed = await environment.backend.admit(reader, {
      schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `task-page-revoke-list-${index}-${randomUUID()}`, input: {},
    }, contextId);
    assert.equal((await environment.backend.execute(listed.id, new AbortController().signal)).outcome, 'succeeded');
  }
  const first = await environment.backend.listTaskPage(reader, { contextId, limit: 1 });
  assert.ok(first.nextCursor);
  assert.ok(first.taskIds.includes(naturalId) || first.totalSize > 1);

  await environment.backend.revokeKnowledgeBase(reader, kb.id);
  await assert.rejects(environment.backend.listTaskPage(reader, { contextId, limit: 1, cursor: first.nextCursor }),
    (error: unknown) => error instanceof DomainError && error.code === 'CURSOR_EXPIRED');
  const current = await environment.backend.listTaskPage(reader, { contextId, limit: 100 });
  assert.equal(current.totalSize, 0);
  assert.deepEqual(current.taskIds, []);
});

test('PostgreSQL admits KBs, stores source atomically, and exposes a real failed ingestion task', { timeout: 30_000 }, async () => {
  const principal = await provision('owner-basic');
  const kb = await createKb(principal);
  const sourceText = 'Pi Durable 保存原文并通过内容哈希校验。UTF-8 😀 remains intact.';
  const request = saveRequest(kb.id, `save-${randomUUID()}`, sourceText, 'stored');
  const parent = await environment.backend.admit(principal, request, `ctx-${randomUUID()}`);
  assert.equal(parent.state, 'submitted');

  const savedResult = await environment.backend.execute(parent.id, new AbortController().signal);
  assert.equal(validateResult(savedResult), true, ajv.errorsText(validateResult.errors));
  assert.equal(savedResult.outcome, 'succeeded');
  const saved = savedResult.result as {
    documentId: string; knowledgeBaseId: string; version: number; indexState: string; sha256: string; ingestionTaskId: string;
  };
  assert.equal(saved.knowledgeBaseId, kb.id);
  assert.equal(saved.version, 1);
  assert.equal(saved.indexState, 'stored');
  assert.equal(saved.sha256, createHash('sha256').update(Buffer.from(sourceText)).digest('hex'));
  assert.ok(saved.ingestionTaskId);

  const completedParent = await environment.backend.getTask(principal, parent.id);
  assert.equal(completedParent.state, 'completed');
  assert.equal(completedParent.id, parent.id);
  const ingestion = await environment.backend.getTask(principal, saved.ingestionTaskId);
  assert.equal(ingestion.kind, 'ingestion');
  assert.equal(ingestion.parentTaskId, parent.id);
  assert.equal(ingestion.state, 'submitted');
  assert.ok((await environment.backend.pendingTasks()).some(task => task.id === ingestion.id));

  const indexingResult = await environment.backend.execute(ingestion.id, new AbortController().signal);
  assert.equal(indexingResult.outcome, 'failed');
  assert.equal(indexingResult.error?.code, 'INDEXING_NOT_AVAILABLE');
  assert.equal((await environment.backend.getTask(principal, ingestion.id)).state, 'failed');
  assert.equal((await environment.backend.pendingTasks()).some(task => task.id === ingestion.id), false);

  const documentGet: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.get', requestId: `get-${randomUUID()}`,
    knowledgeBaseId: kb.id, input: { documentId: saved.documentId, version: 1 },
  };
  const getTask = await environment.backend.admit(principal, documentGet);
  const getResult = await environment.backend.execute(getTask.id, new AbortController().signal);
  assert.equal(validateResult(getResult), true, ajv.errorsText(validateResult.errors));
  const getData = getResult.result as { content: { text: string; truncated: boolean }; source: { sha256: string; mimeType: string } };
  assert.equal(getData.content.text, sourceText);
  assert.equal(getData.content.truncated, false);
  assert.equal(getData.source.sha256, saved.sha256);
  assert.equal(getData.source.mimeType, 'text/markdown');
  assert.equal((await environment.backend.readContent(principal, saved.documentId, 1)).bytes.toString('utf8'), sourceText);
});

test('20 identical retries reuse one task, version, blob, and hash; changed payload conflicts', { timeout: 30_000 }, async () => {
  const principal = await provision('owner-idempotency');
  const kb = await createKb(principal);
  const text = '多字节 UTF-8 文档内容 😀\n第二行。';
  const requestId = `save-retry-${randomUUID()}`;
  const request = saveRequest(kb.id, requestId, text, 'stored');
  const first = await environment.backend.admit(principal, request);
  const retries = await Promise.all(Array.from({ length: 20 }, () => environment.backend.admit(principal, request)));
  assert.ok(retries.every(task => task.id === first.id));

  const firstResult = await environment.backend.execute(first.id, new AbortController().signal);
  const replayResult = await environment.backend.execute(first.id, new AbortController().signal);
  assert.deepEqual(replayResult, firstResult);
  const saved = firstResult.result as { documentId: string; sha256: string; ingestionTaskId: string };
  const expectedHash = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  assert.equal(saved.sha256, expectedHash);
  const content = await environment.backend.readContent(principal, saved.documentId);
  assert.equal(content.sha256, expectedHash);
  assert.deepEqual(content.bytes, Buffer.from(text, 'utf8'));

  await assert.rejects(
    environment.backend.admit(principal, saveRequest(kb.id, requestId, `${text} changed`, 'stored')),
    (error: unknown) => error instanceof DomainError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(await countRows('pd_documents', principal.tenantId), 1);
  assert.equal(await countRows('pd_document_versions', principal.tenantId), 1);
  assert.equal(await countRows('pd_blobs', principal.tenantId), 1);
  assert.equal(await countRows('pd_tasks', principal.tenantId), 3); // KB creation, parent operation, ingestion child.
  assert.ok((await environment.backend.getTask(principal, saved.ingestionTaskId)).id);
});

test('indexed default and invalid uploads fail before writing any document or blob', { timeout: 30_000 }, async () => {
  const principal = await provision('owner-indexed-fails');
  const kb = await createKb(principal);
  const defaultRequest = saveRequest(kb.id, `save-indexed-${randomUUID()}`, 'must not persist');
  const failed = await environment.backend.admit(principal, defaultRequest);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.result?.outcome, 'failed');
  assert.equal(failed.result?.error?.code, 'INDEXING_NOT_AVAILABLE');
  const explicitDefault = await environment.backend.admit(principal, {
    ...defaultRequest,
    input: { ...defaultRequest.input, waitFor: 'indexed' },
  } as DocumentRequest);
  assert.equal(explicitDefault.id, failed.id);

  const uploadRequest = {
    schemaVersion: '1.0', operation: 'document.save', requestId: `upload-${randomUUID()}`, knowledgeBaseId: kb.id,
    input: { source: { kind: 'upload', uploadId: 'not-supported-in-m1' }, title: 'unsupported', waitFor: 'stored' },
  } as DocumentRequest;
  const unsupportedSource = await environment.backend.admit(principal, uploadRequest);
  assert.equal(unsupportedSource.state, 'submitted');
  const invalidUpload = await environment.backend.execute(unsupportedSource.id, new AbortController().signal);
  assert.equal(invalidUpload.outcome, 'failed');
  assert.equal(invalidUpload.error?.code, 'INVALID_UPLOAD');
  assert.equal(await countRows('pd_documents', principal.tenantId), 0);
  assert.equal(await countRows('pd_document_versions', principal.tenantId), 0);
  assert.equal(await countRows('pd_blobs', principal.tenantId), 0);
});

test('current DB scopes and KB membership are checked for execution, task reads, and content reads', { timeout: 30_000 }, async () => {
  const owner = await provision('owner-acl');
  const reader = await provision('reader-acl', owner.tenantId, ['knowledge:read']);
  const foreign = await provision('foreign-acl');
  const kb = await createKb(owner);
  const sourceText = 'ACL revocation hides both old artifacts and source bytes.';
  const save = await environment.backend.admit(owner, saveRequest(kb.id, `acl-save-${randomUUID()}`, sourceText, 'stored'));
  const savedResult = await environment.backend.execute(save.id, new AbortController().signal);
  const saved = savedResult.result as { documentId: string };

  await environment.backend.grantKnowledgeBase(reader, kb.id, ['knowledge:read']);
  const getRequest: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.get', requestId: `reader-get-${randomUUID()}`,
    knowledgeBaseId: kb.id, input: { documentId: saved.documentId },
  };
  const readerTask = await environment.backend.admit(reader, getRequest);
  await environment.backend.execute(readerTask.id, new AbortController().signal);
  assert.equal((await environment.backend.getTask(reader, readerTask.id)).state, 'completed');
  assert.equal((await environment.backend.readContent(reader, saved.documentId)).bytes.toString('utf8'), sourceText);

  await environment.backend.revokeKnowledgeBase(reader, kb.id);
  await assert.rejects(environment.backend.getTask(reader, readerTask.id),
    (error: unknown) => error instanceof DomainError && error.code === 'KNOWLEDGE_BASE_NOT_FOUND');
  assert.equal((await environment.backend.listTasks(reader)).some(task => task.id === readerTask.id), false);
  await assert.rejects(environment.backend.readContent(reader, saved.documentId),
    (error: unknown) => error instanceof DomainError && error.code === 'KNOWLEDGE_BASE_NOT_FOUND');
  await assert.rejects(environment.backend.admit(foreign, getRequest),
    (error: unknown) => error instanceof DomainError && error.code === 'KNOWLEDGE_BASE_NOT_FOUND');

  const sharedContext = `ctx-owner-${randomUUID()}`;
  await environment.backend.admit(owner, {
    schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `ctx-one-${randomUUID()}`, input: {},
  }, sharedContext);
  const sameTenantOtherPrincipal = await provision('other-context-owner', owner.tenantId);
  await assert.rejects(environment.backend.admit(sameTenantOtherPrincipal, {
    schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `ctx-two-${randomUUID()}`, input: {},
  }, sharedContext), (error: unknown) => error instanceof DomainError && error.code === 'CONTEXT_OWNER_MISMATCH');

  const pending = await environment.backend.admit(owner, saveRequest(kb.id, `revoked-scope-${randomUUID()}`, 'must not write', 'stored'));
  await environment.backend.provisionPrincipal({
    tenantId: owner.tenantId, id: owner.id, scopes: ['knowledge:read'], token: 'owner-acl-rotated',
  });
  const deniedWrite = await environment.backend.execute(pending.id, new AbortController().signal);
  assert.equal(deniedWrite.outcome, 'failed');
  assert.ok(['FORBIDDEN', 'KNOWLEDGE_BASE_NOT_FOUND'].includes(deniedWrite.error?.code ?? ''));
  assert.equal(await countRows('pd_documents', owner.tenantId), 1);
});

test('cancel and execute serialize without reverting terminal state; canceled work leaves no content', { timeout: 30_000 }, async () => {
  const principal = await provision('owner-cancel');
  const kb = await createKb(principal);
  const canceled = await environment.backend.admit(principal, saveRequest(kb.id, `cancel-${randomUUID()}`, 'do not store', 'stored'));
  const cancelResult = await environment.backend.cancel(principal, canceled.id);
  assert.equal(cancelResult.state, 'canceled');
  assert.equal((await environment.backend.cancel(principal, canceled.id)).state, 'canceled');
  const canceledStored = await environment.backend.getTask(principal, canceled.id);
  assert.equal(canceledStored.state, 'canceled');
  assert.equal(canceledStored.result, null);
  const afterCancel = await environment.backend.execute(canceled.id, new AbortController().signal);
  assert.equal(afterCancel.outcome, 'failed');
  assert.equal(afterCancel.error?.code, 'CANCELED');
  assert.equal(await countRows('pd_documents', principal.tenantId), 0);

  const completing = await environment.backend.admit(principal, saveRequest(kb.id, `complete-${randomUUID()}`, 'completed before cancel', 'stored'));
  const lock = await environment.pool.connect();
  let execute: Promise<unknown> | undefined;
  let cancel: Promise<unknown> | undefined;
  try {
    await lock.query('BEGIN');
    await lock.query(`SELECT id FROM pd_tasks WHERE id = $1 FOR UPDATE`, [completing.id]);
    execute = environment.backend.execute(completing.id, new AbortController().signal);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
    cancel = environment.backend.cancel(principal, completing.id);
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
    await lock.query('COMMIT');
  } finally {
    await lock.query('ROLLBACK').catch(() => undefined);
    lock.release();
  }
  const [executed, canceledAfter] = await Promise.allSettled([execute, cancel]);
  assert.equal(executed.status, 'fulfilled');
  assert.equal(canceledAfter.status, 'rejected');
  if (canceledAfter.status === 'rejected') {
    assert.ok(canceledAfter.reason instanceof DomainError);
    assert.equal(canceledAfter.reason.code, 'TASK_NOT_CANCELABLE');
  }
  assert.equal((await environment.backend.getTask(principal, completing.id)).state, 'completed');
  assert.equal(await countRows('pd_documents', principal.tenantId), 1);
});

test('document and knowledge-base lists paginate with principal/filter-bound cursors', { timeout: 30_000 }, async () => {
  const principal = await provision('owner-pagination');
  const kb = await createKb(principal);
  await createKb(principal);
  for (let index = 0; index < 3; index++) {
    const task = await environment.backend.admit(principal, saveRequest(kb.id, `page-save-${index}-${randomUUID()}`, `page ${index}`, 'stored'));
    const saved = await environment.backend.execute(task.id, new AbortController().signal);
    assert.equal(saved.outcome, 'succeeded');
    const ingestionTaskId = (saved.result as { ingestionTaskId?: string }).ingestionTaskId;
    assert.ok(ingestionTaskId);
    const ingestion = await environment.backend.execute(ingestionTaskId, new AbortController().signal);
    assert.equal(ingestion.outcome, 'failed');
    assert.equal(ingestion.error?.code, 'INDEXING_NOT_AVAILABLE');
  }
  const originalRows = await environment.pool.query<{ id: string }>(
    `SELECT id FROM pd_documents WHERE tenant_id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL ORDER BY id`,
    [principal.tenantId, kb.id],
  );
  assert.equal(originalRows.rows.length, 3);
  const firstRequest: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.list', requestId: `list-1-${randomUUID()}`,
    knowledgeBaseId: kb.id, input: { limit: 2 },
  };
  const firstTask = await environment.backend.admit(principal, firstRequest);
  const firstResult = await environment.backend.execute(firstTask.id, new AbortController().signal);
  assert.equal(firstResult.outcome, 'succeeded');
  const firstPage = firstResult.result as { documents: { documentId: string }[]; nextCursor?: string };
  assert.equal(firstPage.documents.length, 2);
  assert.ok(firstPage.nextCursor);
  assert.deepEqual(firstPage.documents.map(item => item.documentId), originalRows.rows.slice(0, 2).map(row => row.id));

  const concurrentSave = await environment.backend.admit(principal,
    saveRequest(kb.id, `page-save-after-snapshot-${randomUUID()}`, 'created after the list snapshot', 'stored'));
  const concurrentSaveResult = await environment.backend.execute(concurrentSave.id, new AbortController().signal);
  assert.equal(concurrentSaveResult.outcome, 'succeeded');
  const concurrentIngestionId = (concurrentSaveResult.result as { ingestionTaskId: string }).ingestionTaskId;
  await environment.backend.execute(concurrentIngestionId, new AbortController().signal);

  const concurrentDelete = await environment.backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.delete', requestId: `page-delete-after-snapshot-${randomUUID()}`,
    knowledgeBaseId: kb.id, input: { documentId: originalRows.rows[2]!.id, expectedVersion: 1 },
  });
  const concurrentDeleteResult = await environment.backend.execute(concurrentDelete.id, new AbortController().signal);
  assert.equal(concurrentDeleteResult.outcome, 'succeeded');

  const secondTask = await environment.backend.admit(principal, {
    ...firstRequest,
    requestId: `list-2-${randomUUID()}`,
    input: { limit: 2, cursor: firstPage.nextCursor },
  });
  const secondResult = await environment.backend.execute(secondTask.id, new AbortController().signal);
  const secondPage = secondResult.result as { documents: { documentId: string }[]; nextCursor?: string };
  assert.deepEqual(secondPage.documents, []);
  assert.equal(secondPage.nextCursor, undefined);
  assert.deepEqual([...firstPage.documents, ...secondPage.documents].map(item => item.documentId), originalRows.rows.slice(0, 2).map(row => row.id));
  const currentRows = await environment.pool.query<{ id: string }>(
    `SELECT id FROM pd_documents WHERE tenant_id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL ORDER BY id`,
    [principal.tenantId, kb.id],
  );
  assert.equal(currentRows.rows.length, 3);
  assert.equal(currentRows.rows.some(row => row.id === originalRows.rows[2]!.id), false);

  const firstKbPageTask = await environment.backend.admit(principal, {
    schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `kb-list-1-${randomUUID()}`, input: { limit: 1 },
  });
  const firstKbPageResult = await environment.backend.execute(firstKbPageTask.id, new AbortController().signal);
  const firstKbPage = firstKbPageResult.result as { knowledgeBases: { knowledgeBaseId: string }[]; nextCursor?: string };
  assert.ok(firstKbPage.nextCursor);
  const mismatched = await environment.backend.admit(principal, {
    schemaVersion: '1.0', operation: 'knowledge_base.list', requestId: `kb-list-mismatch-${randomUUID()}`, input: { limit: 1, cursor: firstPage.nextCursor },
  });
  const mismatchResult = await environment.backend.execute(mismatched.id, new AbortController().signal);
  assert.equal(mismatchResult.outcome, 'failed');
  assert.equal(mismatchResult.error?.code, 'INVALID_CURSOR');

  await environment.pool.query(`UPDATE pd_list_cursors SET expires_at = now() - interval '1 second' WHERE id = $1`, [firstPage.nextCursor]);
  const expiredListCursorTask = await environment.backend.admit(principal, {
    ...firstRequest, requestId: `list-expired-cursor-${randomUUID()}`, input: { limit: 2, cursor: firstPage.nextCursor },
  });
  const expiredListCursor = await environment.backend.execute(expiredListCursorTask.id, new AbortController().signal);
  assert.equal(expiredListCursor.error?.code, 'CURSOR_EXPIRED');
  const cursorPruneTask = await environment.backend.admit(principal, {
    ...firstRequest, requestId: `list-trigger-cursor-prune-${randomUUID()}`,
  });
  await environment.backend.execute(cursorPruneTask.id, new AbortController().signal);
  const expiredListCursorRows = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_list_cursors WHERE id = $1`, [firstPage.nextCursor],
  );
  assert.equal(expiredListCursorRows.rows[0]?.count, 0);
});
