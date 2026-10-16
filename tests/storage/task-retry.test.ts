import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { DomainError, type DocumentPipeline, type DocumentRequest, type Principal, type Scope, type StoredTask } from '../../src/domain/types.js';
import { migrateVector, PostgresDocumentBackend } from '../../src/domain/service.js';
import { LocalPostgres } from '../../scripts/support/local-postgres.js';
import { tokenize } from '../../src/retrieval/lexical.js';
import { createEmbeddingClient } from '../../src/retrieval/embedding.js';

const dimensions = 1024;
const scopes: Scope[] = ['knowledge:read', 'knowledge:write', 'knowledge:delete'];
type Environment = { root: string; postgres: LocalPostgres; pool: Pool };
type PipelineState = { parse: number; embed: number; failEmbeddings: number };
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
  const root = await mkdtemp(join(tmpdir(), 'pi-document-task-retry-test-'));
  const postgres = new LocalPostgres({ dataDir: join(root, 'postgres'), port: await reservePort(), password: randomUUID() });
  let pool: Pool | undefined;
  try {
    await postgres.start();
    pool = new Pool({ connectionString: postgres.url, max: 12 });
    await migrateVector(pool, dimensions);
    return { root, postgres, pool };
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

function makePipeline(state: PipelineState): DocumentPipeline {
  return {
    profile: { id: 'retry-test-embedding', version: 'v1', dimensions },
    async parse(bytes) {
      state.parse += 1;
      const text = bytes.toString('utf8').trim();
      const chunks = text.split('\n').filter(line => line.trim()).map((line, ordinal) => ({
        ordinal,
        text: line,
        locator: { kind: 'test_line', line: ordinal + 1 },
        lexicalTokens: tokenize(line),
      }));
      return { text, chunks, warnings: [] };
    },
    async embed(texts) {
      state.embed += 1;
      if (state.failEmbeddings > 0) {
        state.failEmbeddings -= 1;
        throw new DomainError('TEMPORARY_EMBEDDING_FAILURE', 'Temporary embedding failure.', 502, true);
      }
      return texts.map(() => [1, ...Array.from({ length: dimensions - 1 }, () => 0)]);
    },
    tokenize,
  };
}

function createBackend(state: PipelineState): PostgresDocumentBackend {
  return new PostgresDocumentBackend({
    pool: environment.pool,
    blobRoot: join(environment.root, 'blobs'),
    publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline(state),
  });
}

async function provision(backend: PostgresDocumentBackend, label: string): Promise<Principal> {
  const id = `${label}-${randomUUID()}`;
  const tenantId = `tenant-${id}`;
  const token = `retry-token-${randomUUID()}`;
  await backend.provisionPrincipal({ tenantId, id, scopes, token });
  const principal = await backend.authenticate(token);
  assert.ok(principal);
  return principal;
}

async function createKnowledgeBase(backend: PostgresDocumentBackend, principal: Principal): Promise<string> {
  const request: DocumentRequest = {
    schemaVersion: '1.0', operation: 'knowledge_base.create', requestId: `kb-${randomUUID()}`,
    input: { name: 'Task retry test KB' },
  };
  const task = await backend.admit(principal, request);
  const result = await backend.execute(task.id, new AbortController().signal);
  assert.equal(result.outcome, 'succeeded');
  return String(result.result?.knowledgeBaseId);
}

function saveRequest(knowledgeBaseId: string, requestId = `save-${randomUUID()}`, waitFor: 'stored' | 'indexed' = 'indexed'): DocumentRequest {
  return {
    schemaVersion: '1.0', operation: 'document.save', requestId, knowledgeBaseId,
    input: { source: { kind: 'text', text: `Persisted source ${randomUUID()}`, mimeType: 'text/markdown' }, title: 'Retry source', waitFor },
  };
}

async function startRetryableFailure(
  backend: PostgresDocumentBackend, principal: Principal, knowledgeBaseId: string, state: PipelineState,
): Promise<StoredTask> {
  state.failEmbeddings = 1;
  const task = await backend.admit(principal, saveRequest(knowledgeBaseId));
  const result = await backend.execute(task.id, new AbortController().signal);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.retryable, true);
  return backend.getTask(principal, task.id);
}

async function countRows(table: 'pd_documents' | 'pd_document_versions', tenantId: string): Promise<number> {
  const result = await environment.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  return Number(result.rows[0]?.count ?? 0);
}

async function assertRetryUnavailable(backend: PostgresDocumentBackend, principal: Principal, taskId: string, requestId = `retry-${randomUUID()}`): Promise<void> {
  await assert.rejects(
    backend.retryFailedTask(principal, taskId, requestId),
    error => error instanceof DomainError && error.code === 'RETRY_NOT_AVAILABLE' && error.status === 409,
  );
}

test('a temporary embedding failure retries the same source with one task per retry key and reuses parse receipt', { timeout: 120_000 }, async () => {
  const state: PipelineState = { parse: 0, embed: 0, failEmbeddings: 0 };
  const backend = createBackend(state);
  const principal = await provision(backend, 'retry-success');
  const knowledgeBaseId = await createKnowledgeBase(backend, principal);
  const failed = await startRetryableFailure(backend, principal, knowledgeBaseId, state);

  const retries = await Promise.all(Array.from({ length: 20 }, () =>
    backend.retryFailedTask!(principal, failed.id, 'retry-key-1')));
  assert.equal(new Set(retries.map(task => task.id)).size, 1);
  const retry = retries[0]!;
  assert.equal(retry.kind, 'ingestion');
  assert.equal(retry.parentTaskId, failed.id);
  assert.equal(retry.state, 'submitted');
  assert.ok((await backend.pendingTasks()).some(task => task.id === retry.id), 'the generic pending-task pump must see retry ingestion tasks');
  const copiedExecuteReceipt = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = 'execute'`,
    [principal.tenantId, retry.id],
  );
  assert.equal(Number(copiedExecuteReceipt.rows[0]?.count ?? 0), 0, 'a failed execute receipt must never be copied');

  const completed = await backend.execute(retry.id, new AbortController().signal);
  assert.equal(completed.outcome, 'succeeded');
  assert.equal(state.parse, 1, 'the completed parse receipt should be reused');
  assert.equal(state.embed, 2, 'only the failed and retried embedding calls should run');

  const searchTask = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.search', requestId: 'search-after-retry', knowledgeBaseId,
    input: { query: 'unrelated semantic query', mode: 'semantic', topK: 10 },
  });
  const searchResult = await backend.execute(searchTask.id, new AbortController().signal);
  assert.equal(searchResult.outcome, 'succeeded');
  const searchHits = (searchResult.result as { results: Array<{ documentId: string }> }).results;
  assert.ok(searchHits.some(hit => hit.documentId === String((completed.result as { documentId: string }).documentId)));

  const oldTask = await backend.getTask(principal, failed.id);
  assert.equal(oldTask.state, 'failed');
  assert.equal(oldTask.result?.error?.code, 'TEMPORARY_EMBEDDING_FAILURE');
  assert.equal(await countRows('pd_documents', principal.tenantId), 1);
  assert.equal(await countRows('pd_document_versions', principal.tenantId), 1);
  const sourceDocument = await environment.pool.query<{ id: string; revision: string }>(
    `SELECT id, revision::text FROM pd_documents WHERE tenant_id = $1 AND created_by_task_id = $2`,
    [principal.tenantId, failed.id],
  );
  const ready = await environment.pool.query(
    `SELECT 1 FROM pd_documents d JOIN pd_index_generations g
       ON g.tenant_id = d.tenant_id AND g.document_id = d.id AND g.version = d.active_version
         AND g.generation_id = d.active_generation_id
     WHERE d.tenant_id = $1 AND d.id = $2 AND g.state = 'ready'
       AND g.profile_id = 'retry-test-embedding' AND g.profile_version = 'v1' AND g.dimensions = $3`,
    [principal.tenantId, sourceDocument.rows[0]!.id, dimensions],
  );
  const generationRows = await environment.pool.query(
    `SELECT d.active_version, d.active_generation_id, g.generation_id, g.profile_id, g.profile_version, g.dimensions, g.state
     FROM pd_documents d LEFT JOIN pd_index_generations g ON g.tenant_id = d.tenant_id AND g.document_id = d.id
     WHERE d.tenant_id = $1 AND d.id = $2`,
    [principal.tenantId, sourceDocument.rows[0]!.id],
  );
  assert.equal(ready.rowCount, 1, `a successful retry should have published a ready generation: ${JSON.stringify(generationRows.rows)}`);
  const revisionBeforeRejectedRetry = sourceDocument.rows[0]!.revision;
  await assert.rejects(
    backend.retryFailedTask!(principal, failed.id, 'retry-key-after-success'),
    error => error instanceof DomainError && error.code === 'RETRY_NOT_AVAILABLE' && error.status === 409 &&
      error.message === 'This task cannot be retried: this source version already has a ready index',
  );
  const revisionAfterRejectedRetry = await environment.pool.query<{ revision: string }>(
    `SELECT revision::text FROM pd_documents WHERE tenant_id = $1 AND id = $2`,
    [principal.tenantId, sourceDocument.rows[0]!.id],
  );
  assert.equal(revisionAfterRejectedRetry.rows[0]!.revision, revisionBeforeRejectedRetry);

  // The same idempotency key replays its successful task before ready-index rejection is evaluated.
  const replay = await backend.retryFailedTask!(principal, failed.id, 'retry-key-1');
  assert.equal(replay.id, retry.id);
  assert.equal(replay.state, 'completed');
  const lineageCount = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_task_retries WHERE tenant_id = $1 AND source_task_id = $2`,
    [principal.tenantId, failed.id],
  );
  assert.equal(Number(lineageCount.rows[0]?.count ?? 0), 1);
});

test('a failed retry attempt can receive another attempt until its source generation is ready', { timeout: 120_000 }, async () => {
  const state: PipelineState = { parse: 0, embed: 0, failEmbeddings: 0 };
  const backend = createBackend(state);
  const principal = await provision(backend, 'retry-failed-attempt');
  const knowledgeBaseId = await createKnowledgeBase(backend, principal);
  const failedSave = await startRetryableFailure(backend, principal, knowledgeBaseId, state);
  const firstRetry = await backend.retryFailedTask!(principal, failedSave.id, 'retry-first-attempt');

  state.failEmbeddings = 1;
  const firstFailure = await backend.execute(firstRetry.id, new AbortController().signal);
  assert.equal(firstFailure.outcome, 'failed');
  assert.equal(firstFailure.error?.retryable, true);
  assert.equal((await backend.getTask(principal, firstRetry.id)).state, 'failed');

  const secondRetry = await backend.retryFailedTask!(principal, firstRetry.id, 'retry-second-attempt');
  assert.equal(secondRetry.parentTaskId, firstRetry.id);
  assert.equal((await backend.execute(secondRetry.id, new AbortController().signal)).outcome, 'succeeded');
  assert.equal(await countRows('pd_documents', principal.tenantId), 1);
  assert.equal(await countRows('pd_document_versions', principal.tenantId), 1);
});

test('a failed stored-document ingestion task can retry its saved parent source', { timeout: 120_000 }, async () => {
  const state: PipelineState = { parse: 0, embed: 0, failEmbeddings: 0 };
  const backend = createBackend(state);
  const principal = await provision(backend, 'retry-ingestion');
  const knowledgeBaseId = await createKnowledgeBase(backend, principal);
  const save = await backend.admit(principal, saveRequest(knowledgeBaseId, undefined, 'stored'));
  assert.equal((await backend.execute(save.id, new AbortController().signal)).outcome, 'succeeded');
  const child = (await backend.pendingTasks()).find(task => task.kind === 'ingestion' && task.parentTaskId === save.id);
  assert.ok(child);
  state.failEmbeddings = 1;
  assert.equal((await backend.execute(child.id, new AbortController().signal)).error?.retryable, true);

  const retry = await backend.retryFailedTask!(principal, child.id, 'retry-ingestion-key');
  assert.equal(retry.kind, 'ingestion');
  assert.equal(retry.parentTaskId, child.id);
  assert.equal((await backend.execute(retry.id, new AbortController().signal)).outcome, 'succeeded');
  assert.equal(await countRows('pd_documents', principal.tenantId), 1);
  assert.equal(await countRows('pd_document_versions', principal.tenantId), 1);
});

test('retry uses persisted upload bytes after its upload capability expires', { timeout: 120_000 }, async () => {
  const state: PipelineState = { parse: 0, embed: 0, failEmbeddings: 0 };
  const backend = createBackend(state);
  const principal = await provision(backend, 'retry-expired-upload');
  const knowledgeBaseId = await createKnowledgeBase(backend, principal);
  const upload = await backend.createUpload(principal, knowledgeBaseId, Buffer.from('Persisted upload source'), 'text/plain');
  const request: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.save', requestId: `save-upload-${randomUUID()}`, knowledgeBaseId,
    input: { source: { kind: 'upload', uploadId: upload.uploadId }, title: 'Uploaded source', waitFor: 'indexed' },
  };
  state.failEmbeddings = 1;
  const failed = await backend.admit(principal, request);
  assert.equal((await backend.execute(failed.id, new AbortController().signal)).error?.retryable, true);
  await environment.pool.query(
    `UPDATE pd_uploads SET expires_at = now() - interval '1 second' WHERE tenant_id = $1 AND upload_id = $2`,
    [principal.tenantId, upload.uploadId],
  );

  const retry = await backend.retryFailedTask!(principal, failed.id, 'expired-upload-retry');
  assert.equal((await backend.execute(retry.id, new AbortController().signal)).outcome, 'succeeded');
  assert.equal(await countRows('pd_documents', principal.tenantId), 1);
  assert.equal(await countRows('pd_document_versions', principal.tenantId), 1);
});

test('the real embedding client marks five transient 503s retryable and a later healthy attempt succeeds', { timeout: 180_000 }, async () => {
  let attempts = 0;
  let transientFailuresRemaining = 5;
  const responseVector = [1, ...Array.from({ length: dimensions - 1 }, () => 0)];
  const server = createHttpServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the request body */ }
    attempts += 1;
    if (transientFailuresRemaining > 0) {
      transientFailuresRemaining -= 1;
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end('{"error":"temporarily unavailable"}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ index: 0, embedding: responseVector }] }));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const state: PipelineState = { parse: 0, embed: 0, failEmbeddings: 0 };
    const parser = makePipeline(state);
    const embedder = createEmbeddingClient({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      modelId: 'test-embedding-model', dimensions, apiKey: 'fixture-only-key', version: 'fixture-v1', normalization: 'l2',
    });
    const backend = new PostgresDocumentBackend({
      pool: environment.pool,
      blobRoot: join(environment.root, 'blobs'),
      publicBaseUrl: 'https://documents.example.test',
      pipeline: { ...parser, profile: { id: 'real-client-retry-fixture', version: 'fixture-v1', dimensions }, embed: embedder.embed },
    });
    const principal = await provision(backend, 'retry-real-client');
    const knowledgeBaseId = await createKnowledgeBase(backend, principal);
    const failed = await backend.admit(principal, saveRequest(knowledgeBaseId));
    const failedResult = await backend.execute(failed.id, new AbortController().signal);
    assert.equal(failedResult.outcome, 'failed');
    assert.equal(failedResult.error?.code, 'EMBEDDING_RETRY_EXHAUSTED');
    assert.equal(failedResult.error?.retryable, true);
    assert.equal(attempts, 5, 'the client should make five actual HTTP 503 attempts');
    assert.equal(await countRows('pd_documents', principal.tenantId), 1);
    assert.equal(await countRows('pd_document_versions', principal.tenantId), 1);

    const retry = await backend.retryFailedTask!(principal, failed.id, 'real-http-retry');
    const succeeded = await backend.execute(retry.id, new AbortController().signal);
    assert.equal(succeeded.outcome, 'succeeded');
    assert.equal(attempts, 6, 'the recovered provider should answer the next real embedding request');
    assert.equal(state.parse, 1, 'the retry should reuse the persisted parse receipt');
    assert.equal((await backend.getTask(principal, failed.id)).state, 'failed');
    assert.equal(await countRows('pd_documents', principal.tenantId), 1);
    assert.equal(await countRows('pd_document_versions', principal.tenantId), 1);
  } finally {
    await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  }
});

test('retry rejects completed, non-retryable, source-less, update, stale, deleted, and ACL-revoked tasks', { timeout: 180_000 }, async () => {
  const state: PipelineState = { parse: 0, embed: 0, failEmbeddings: 0 };
  const backend = createBackend(state);
  const principal = await provision(backend, 'retry-refusal');
  const knowledgeBaseId = await createKnowledgeBase(backend, principal);

  const completed = await backend.admit(principal, saveRequest(knowledgeBaseId));
  assert.equal((await backend.execute(completed.id, new AbortController().signal)).outcome, 'succeeded');
  await assertRetryUnavailable(backend, principal, completed.id);

  const nonRetryable = await backend.admit(principal, saveRequest(knowledgeBaseId));
  await backend.failTask(nonRetryable.id, 'PARSER_INVALID', 'The parser rejected this source.', false);
  await assertRetryUnavailable(backend, principal, nonRetryable.id);

  const sourceLess = await backend.admit(principal, saveRequest(knowledgeBaseId));
  await backend.failTask(sourceLess.id, 'TEMPORARY_RUNTIME_FAILURE', 'The runtime stopped before saving the source.', true);
  await assertRetryUnavailable(backend, principal, sourceLess.id);

  const completedDocument = await environment.pool.query<{ id: string }>(
    `SELECT id FROM pd_documents WHERE tenant_id = $1 AND created_by_task_id = $2`, [principal.tenantId, completed.id],
  );
  const documentId = completedDocument.rows[0]!.id;
  state.failEmbeddings = 1;
  const failedUpdate = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.update', requestId: `update-failure-${randomUUID()}`, knowledgeBaseId,
    input: { documentId, expectedVersion: 1, source: { kind: 'text', text: 'Updated source.', mimeType: 'text/markdown' }, title: 'Updated' },
  });
  const updateResult = await backend.execute(failedUpdate.id, new AbortController().signal);
  assert.equal(updateResult.error?.retryable, true);
  await assertRetryUnavailable(backend, principal, failedUpdate.id);

  const stale = await startRetryableFailure(backend, principal, knowledgeBaseId, state);
  const staleDocRow = await environment.pool.query<{ id: string }>(
    `SELECT id FROM pd_documents WHERE tenant_id = $1 AND created_by_task_id = $2`, [principal.tenantId, stale.id],
  );
  const staleDocumentId = staleDocRow.rows[0]!.id;
  const update = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.update', requestId: `update-stale-${randomUUID()}`, knowledgeBaseId,
    input: { documentId: staleDocumentId, expectedVersion: 1, source: { kind: 'text', text: 'A newer source version.', mimeType: 'text/markdown' }, title: 'Newer' },
  });
  assert.equal((await backend.execute(update.id, new AbortController().signal)).outcome, 'succeeded');
  await assertRetryUnavailable(backend, principal, stale.id);

  const deleted = await startRetryableFailure(backend, principal, knowledgeBaseId, state);
  const deletedDocRow = await environment.pool.query<{ id: string }>(
    `SELECT id FROM pd_documents WHERE tenant_id = $1 AND created_by_task_id = $2`, [principal.tenantId, deleted.id],
  );
  const deletedTask = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.delete', requestId: `delete-retry-source-${randomUUID()}`, knowledgeBaseId,
    input: { documentId: deletedDocRow.rows[0]!.id, expectedVersion: 1 },
  });
  assert.equal((await backend.execute(deletedTask.id, new AbortController().signal)).outcome, 'succeeded');
  await assertRetryUnavailable(backend, principal, deleted.id);

  const revoked = await startRetryableFailure(backend, principal, knowledgeBaseId, state);
  await backend.revokeKnowledgeBase(principal, knowledgeBaseId);
  await assertRetryUnavailable(backend, principal, revoked.id);
});
