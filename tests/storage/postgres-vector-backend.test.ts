import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { DomainError, type DocumentPipeline, type DocumentRequest, type Principal, type Scope } from '../../src/domain/types.js';
import { migrateVector, PostgresDocumentBackend } from '../../src/domain/service.js';
import { LocalPostgres } from '../../scripts/support/local-postgres.js';
import { tokenize } from '../../src/retrieval/lexical.js';
import { parseSource } from '../../src/ingestion/parser.js';
import { chunkDocument } from '../../src/ingestion/chunker.js';

const dimensions = 3;
const fixtureRoot = fileURLToPath(new URL('../../fixtures/parsers/', import.meta.url));
const scopes: Scope[] = ['knowledge:read', 'knowledge:write', 'knowledge:delete'];
type Environment = { root: string; postgres: LocalPostgres; pool: Pool };
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
  const root = await mkdtemp(join(tmpdir(), 'pi-document-vector-test-'));
  const postgres = new LocalPostgres({ dataDir: join(root, 'postgres'), port: await reservePort(), password: randomUUID() });
  let pool: Pool | undefined;
  try {
    await postgres.start();
    pool = new Pool({ connectionString: postgres.url, max: 8 });
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

function makePipeline(options: {
  profileId?: string;
  dimensions?: number;
  beforeEmbed?: (texts: string[]) => Promise<void>;
  counts?: { parse: number; embed: number };
} = {}): DocumentPipeline {
  const profileDimensions = options.dimensions ?? dimensions;
  return {
    profile: { id: options.profileId ?? 'test-embedding-profile', version: 'test-v1', dimensions: profileDimensions },
    async parse(bytes) {
      if (options.counts) options.counts.parse += 1;
      const text = bytes.toString('utf8').replace(/\r\n?/g, '\n');
      const lines = text.split('\n').filter(line => line.trim());
      let offset = 0;
      const chunks = lines.map((line, ordinal) => {
        const startOffset = Array.from(text.slice(0, text.indexOf(line, offset))).length;
        offset = text.indexOf(line, offset) + line.length;
        return {
          ordinal,
          text: line,
          locator: { kind: 'text_span', startLine: ordinal + 1, endLine: ordinal + 1, startOffset, endOffset: startOffset + Array.from(line).length },
          lexicalTokens: tokenize(line),
        };
      });
      return { text, chunks, warnings: [] };
    },
    async embed(texts, signal) {
      if (options.counts) options.counts.embed += 1;
      if (signal.aborted) throw new DomainError('CANCELED', 'Embedding was canceled.', 409);
      await options.beforeEmbed?.(texts);
      return texts.map(text => {
        if (profileDimensions !== 3) return Array.from({ length: profileDimensions }, (_, index) => index === 0 ? 1 : 0);
        if (/合同|contract|编号|XR-7/i.test(text)) return [1, 0, 0];
        if (/dog|狗/i.test(text)) return [0, 1, 0];
        return [0, 0, 1];
      });
    },
    tokenize,
  };
}

function makeParserPipeline(): DocumentPipeline {
  return {
    profile: { id: 'real-parser-test-profile', version: 'test-v1', dimensions },
    async parse(bytes, mimeType, signal) {
      const parsed = await parseSource(bytes, mimeType, signal);
      const chunks = chunkDocument(parsed).map(chunk => ({
        ordinal: chunk.ordinal, text: chunk.text, locator: { ...chunk.locator }, lexicalTokens: [...chunk.lexicalTokens],
      }));
      return { text: parsed.text, chunks, warnings: parsed.warnings };
    },
    async embed(texts) { return texts.map(() => [1, 0, 0]); },
    tokenize,
  };
}

async function provision(backend: PostgresDocumentBackend, id: string): Promise<Principal> {
  const token = `opaque-${id}-${randomUUID()}`;
  await backend.provisionPrincipal({ tenantId: `tenant-${id}`, id, scopes, token });
  const principal = await backend.authenticate(token);
  assert.ok(principal);
  return principal;
}

async function createKb(backend: PostgresDocumentBackend, principal: Principal) {
  const request: DocumentRequest = {
    schemaVersion: '1.0', operation: 'knowledge_base.create', requestId: `kb-${randomUUID()}`,
    input: { name: 'Vector test KB' },
  };
  const task = await backend.admit(principal, request);
  const result = await backend.execute(task.id, new AbortController().signal);
  assert.equal(result.outcome, 'succeeded');
  return (result.result as { knowledgeBaseId: string }).knowledgeBaseId;
}

function saveRequest(knowledgeBaseId: string, text: string, waitFor: 'stored' | 'indexed' = 'indexed'): DocumentRequest {
  return {
    schemaVersion: '1.0', operation: 'document.save', requestId: `save-${randomUUID()}`, knowledgeBaseId,
    input: { source: { kind: 'text', text, mimeType: 'text/markdown' }, title: `Vector doc ${Array.from(text).slice(0, 16).join('')}`, waitFor },
  };
}

function uploadSaveRequest(knowledgeBaseId: string, uploadId: string, waitFor: 'stored' | 'indexed' = 'indexed'): DocumentRequest {
  return {
    schemaVersion: '1.0', operation: 'document.save', requestId: `upload-save-${randomUUID()}`, knowledgeBaseId,
    input: { source: { kind: 'upload', uploadId }, title: `Uploaded ${uploadId}`, waitFor },
  };
}

function updateRequest(knowledgeBaseId: string, documentId: string, expectedVersion: number, text: string, waitFor: 'stored' | 'indexed' = 'indexed'): DocumentRequest {
  return {
    schemaVersion: '1.0', operation: 'document.update', requestId: `update-${randomUUID()}`, knowledgeBaseId,
    input: {
      documentId, expectedVersion, source: { kind: 'text', text, mimeType: 'text/markdown' },
      title: `Updated ${expectedVersion + 1}`, waitFor,
    },
  };
}

function deleteRequest(knowledgeBaseId: string, documentId: string, expectedVersion: number): DocumentRequest {
  return {
    schemaVersion: '1.0', operation: 'document.delete', requestId: `delete-${randomUUID()}`, knowledgeBaseId,
    input: { documentId, expectedVersion },
  };
}

async function saveIndexed(backend: PostgresDocumentBackend, principal: Principal, knowledgeBaseId: string, text: string) {
  const task = await backend.admit(principal, saveRequest(knowledgeBaseId, text));
  assert.equal(task.state, 'submitted');
  const result = await backend.execute(task.id, new AbortController().signal);
  assert.equal(result.outcome, 'succeeded', result.error?.message);
  const saved = result.result as { documentId: string; version: number; indexState: string; generationId: string; sha256: string };
  assert.equal(saved.indexState, 'ready');
  assert.ok(saved.generationId);
  return { task, result, saved };
}

async function search(backend: PostgresDocumentBackend, principal: Principal, knowledgeBaseId: string, query: string, mode: 'hybrid' | 'semantic' | 'keyword', documentIds?: string[]) {
  const request: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.search', requestId: `search-${randomUUID()}`, knowledgeBaseId,
    input: { query, mode, topK: 10, ...(documentIds ? { filters: { documentIds } } : {}) },
  };
  const task = await backend.admit(principal, request);
  return backend.execute(task.id, new AbortController().signal);
}

test('indexed text saves publish ready generations and keyword, cosine, and RRF retrieval use pgvector', { timeout: 60_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline(),
  });
  const principal = await provision(backend, 'owner-index-search');
  const knowledgeBaseId = await createKb(backend, principal);
  const relevant = await saveIndexed(backend, principal, knowledgeBaseId, '合同编号 XR-7 属于采购合同。\n证据应来自这一段。');
  await saveIndexed(backend, principal, knowledgeBaseId, 'Dogs are friendly animals.');

  const keyword = await search(backend, principal, knowledgeBaseId, '合同编号 XR-7', 'keyword');
  assert.equal(keyword.outcome, 'succeeded');
  const keywordResult = keyword.result as { results: Array<{ documentId: string; scoreType: string; locator: { kind: string } }> };
  assert.equal(keywordResult.results[0]?.documentId, relevant.saved.documentId);
  assert.equal(keywordResult.results[0]?.scoreType, 'lexical');
  assert.equal(keywordResult.results[0]?.locator.kind, 'text_span');

  const naturalKeyword = await search(backend, principal, knowledgeBaseId, '请帮我查询合同编号 XR-7 的验收信息在哪里？', 'keyword');
  assert.equal((naturalKeyword.result as typeof keywordResult).results[0]?.documentId, relevant.saved.documentId);

  const semantic = await search(backend, principal, knowledgeBaseId, '合同编号 XR-7', 'semantic');
  const semanticResult = semantic.result as { results: Array<{ documentId: string; scoreType: string }> };
  assert.equal(semanticResult.results[0]?.documentId, relevant.saved.documentId);
  assert.equal(semanticResult.results[0]?.scoreType, 'cosine');

  const hybrid = await search(backend, principal, knowledgeBaseId, '合同编号 XR-7', 'hybrid');
  const hybridResult = hybrid.result as { results: Array<{ documentId: string; scoreType: string }>; degraded: boolean; degradationReason: string; actualMode: string };
  assert.equal(hybridResult.results[0]?.documentId, relevant.saved.documentId);
  assert.equal(hybridResult.results[0]?.scoreType, 'rrf');
  assert.equal(hybridResult.degraded, true);
  assert.equal(hybridResult.degradationReason, 'reranker_not_configured');
  assert.equal(hybridResult.actualMode, 'hybrid');

  const getTask = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.get', requestId: `get-${randomUUID()}`, knowledgeBaseId,
    input: { documentId: relevant.saved.documentId, version: 1 },
  });
  const getResult = await backend.execute(getTask.id, new AbortController().signal);
  assert.equal((getResult.result as { indexState: string }).indexState, 'ready');
  const listTask = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.list', requestId: `list-${randomUUID()}`, knowledgeBaseId,
    input: { filters: { documentIds: [relevant.saved.documentId] } },
  });
  const listResult = await backend.execute(listTask.id, new AbortController().signal);
  assert.equal((listResult.result as { documents: Array<{ indexState: string }> }).documents[0]?.indexState, 'ready');
});

test('hybrid search degrades to real lexical hits on embedding failure and fails on lexical SQL errors', { timeout: 60_000 }, async () => {
  const pipeline = makePipeline();
  const embed = pipeline.embed.bind(pipeline);
  pipeline.embed = async (texts, signal) => {
    if (texts.some(text => text.startsWith('QUERY '))) {
      throw new DomainError('EMBEDDING_TIMEOUT', 'Injected query embedding outage.', 503, true);
    }
    return embed(texts, signal);
  };
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'search-failure-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline,
  });
  const principal = await provision(backend, 'owner-search-failure');
  const knowledgeBaseId = await createKb(backend, principal);
  const indexed = await saveIndexed(backend, principal, knowledgeBaseId, 'distinctive query fallbackneedle source evidence');

  const degraded = await search(backend, principal, knowledgeBaseId, 'QUERY fallbackneedle', 'hybrid');
  assert.equal(degraded.outcome, 'succeeded');
  const degradedResult = degraded.result as {
    results: Array<{ documentId: string; scoreType: string }>;
    degraded: boolean; degradationReason: string; actualMode: string;
  };
  assert.equal(degradedResult.results[0]?.documentId, indexed.saved.documentId);
  assert.equal(degradedResult.results[0]?.scoreType, 'lexical');
  assert.equal(degradedResult.degraded, true);
  assert.equal(degradedResult.degradationReason, 'embedding_unavailable:EMBEDDING_TIMEOUT;reranker_not_configured');
  assert.equal(degradedResult.actualMode, 'keyword');

  const brokenLexical = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.search', requestId: `lexical-db-failure-${randomUUID()}`, knowledgeBaseId,
    input: { query: 'fallbackneedle', mode: 'keyword' },
  });
  await environment.pool.query(`ALTER TABLE pd_indexed_chunks RENAME COLUMN lexical_tsv TO lexical_tsv_disabled`);
  let failed: Awaited<ReturnType<typeof backend.execute>>;
  try {
    failed = await backend.execute(brokenLexical.id, new AbortController().signal);
  } finally {
    await environment.pool.query(`ALTER TABLE pd_indexed_chunks RENAME COLUMN lexical_tsv_disabled TO lexical_tsv`);
  }
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.error?.code, 'SEARCH_BACKEND_FAILED');
  assert.equal((await backend.getTask(principal, brokenLexical.id)).state, 'failed');
  assert.equal(failed.result, undefined);
});

test('indexed publication persists all 10,000 chunks in bounded PostgreSQL insert batches', { timeout: 120_000 }, async () => {
  const paragraphs = Array(10_000).fill('PERF-2026 repeated indexed paragraph source');
  const sourceText = paragraphs.join('\n\n');
  const pipeline = makePipeline();
  pipeline.parse = async bytes => {
    const text = bytes.toString('utf8');
    const sourceParagraphs = text.split('\n\n');
    let offset = 0;
    const chunks = sourceParagraphs.map((value, ordinal) => {
      const startOffset = offset;
      const endOffset = startOffset + Array.from(value).length;
      offset = endOffset + 2;
      return {
        ordinal,
        text: value,
        locator: { kind: 'text_span', startLine: ordinal + 1, endLine: ordinal + 1, startOffset, endOffset },
        lexicalTokens: tokenize(value),
      };
    });
    return { text, chunks, warnings: [] };
  };
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'bulk-index-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline,
  });
  const principal = await provision(backend, 'owner-bulk-index');
  const knowledgeBaseId = await createKb(backend, principal);
  const upload = await backend.createUpload(principal, knowledgeBaseId, Buffer.from(sourceText), 'text/markdown');
  const task = await backend.admit(principal, uploadSaveRequest(knowledgeBaseId, upload.uploadId));
  const result = await backend.execute(task.id, new AbortController().signal);
  assert.equal(result.outcome, 'succeeded', result.error?.message);
  const saved = result.result as { documentId: string; indexState: string };
  assert.equal(saved.indexState, 'ready');
  const indexed = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_indexed_chunks WHERE tenant_id = $1 AND document_id = $2`,
    [principal.tenantId, saved.documentId],
  );
  assert.equal(indexed.rows[0]?.count, 10_000);
});

test('frozen doc-091 DOCX v1 to v2 upload update publishes with deterministic embeddings', { timeout: 60_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'doc-091-update-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makeParserPipeline(),
  });
  const principal = await provision(backend, 'owner-frozen-doc-091-update');
  const knowledgeBaseId = await createKb(backend, principal);
  const baseline = await readFile(new URL('../../fixtures/evaluation/frozen/documents/doc-091.docx', import.meta.url));
  const version2 = await readFile(new URL('../../fixtures/evaluation/frozen/updates/doc-091-v2.docx', import.meta.url));
  const baselineUpload = await backend.createUpload(principal, knowledgeBaseId, baseline,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const saveTask = await backend.admit(principal, uploadSaveRequest(knowledgeBaseId, baselineUpload.uploadId));
  const saved = await backend.execute(saveTask.id, new AbortController().signal);
  assert.equal(saved.outcome, 'succeeded', saved.error?.message);
  const savedDocument = saved.result as { documentId: string; version: number };
  assert.equal(savedDocument.version, 1);

  const version2Upload = await backend.createUpload(principal, knowledgeBaseId, version2,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const update: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.update', requestId: `update-doc-091-${randomUUID()}`, knowledgeBaseId,
    input: {
      documentId: savedDocument.documentId, expectedVersion: 1,
      source: { kind: 'upload', uploadId: version2Upload.uploadId }, title: 'doc-091 v2', tags: ['frozen-doc-091'], waitFor: 'indexed',
    },
  };
  const updateTask = await backend.admit(principal, update);
  const updated = await backend.execute(updateTask.id, new AbortController().signal);
  assert.equal(updated.outcome, 'succeeded', updated.error?.message);
  assert.equal((updated.result as { version: number; indexState: string }).version, 2);
  assert.equal((updated.result as { version: number; indexState: string }).indexState, 'ready');
  assert.deepEqual((await backend.readContent(principal, savedDocument.documentId, 2)).bytes, version2);
});

test('indexed updates honor the absolute task deadline and do not publish after it', { timeout: 30_000 }, async () => {
  let beginBlockedEmbed!: () => void;
  const blockedEmbedStarted = new Promise<void>(resolve => { beginBlockedEmbed = resolve; });
  const pipeline = makePipeline();
  const embed = pipeline.embed.bind(pipeline);
  pipeline.embed = async (texts, signal) => {
    if (texts.some(text => text.includes('deadline marker'))) {
      beginBlockedEmbed();
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new DomainError('CANCELED', 'The embedding operation received an abort signal.', 409));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    return embed(texts, signal);
  };
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'task-budget-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline,
  });
  assert.equal(backend.pipelineTaskDurationMs, 15 * 60 * 1000);
  const principal = await provision(backend, 'owner-task-budget');
  const knowledgeBaseId = await createKb(backend, principal);
  const initial = await saveIndexed(backend, principal, knowledgeBaseId, 'task budget baseline');
  const update = await backend.admit(principal, updateRequest(knowledgeBaseId, initial.saved.documentId, 1, 'deadline marker must not publish'));
  await environment.pool.query(`UPDATE pd_tasks SET created_at = now() - interval '14 minutes 57 seconds' WHERE tenant_id = $1 AND id = $2`,
    [principal.tenantId, update.id]);

  const executing = backend.execute(update.id, new AbortController().signal);
  await blockedEmbedStarted;
  const result = await executing;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'TASK_TIME_BUDGET_EXCEEDED');
  assert.equal(result.error?.retryable, true);
  assert.equal((await backend.getTask(principal, update.id)).state, 'failed');
  assert.equal((await backend.readContent(principal, initial.saved.documentId)).bytes.toString('utf8'), 'task budget baseline');
  const cleanup = await environment.pool.query<{ reservations: number; version_two: number; active_version: number }>(
    `SELECT (SELECT count(*)::int FROM pd_document_update_reservations WHERE tenant_id = $1 AND document_id = $2) AS reservations,
            (SELECT count(*)::int FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2 AND version = 2) AS version_two,
            active_version
     FROM pd_documents WHERE tenant_id = $1 AND id = $2`,
    [principal.tenantId, initial.saved.documentId],
  );
  assert.deepEqual(cleanup.rows[0], { reservations: 0, version_two: 0, active_version: 1 });
});

test('pipeline task duration accepts a bounded millisecond override', { timeout: 15_000 }, async () => {
  const pipeline = makePipeline();
  const embed = pipeline.embed.bind(pipeline);
  let beginBlockedEmbed!: () => void;
  const blockedEmbedStarted = new Promise<void>(resolve => { beginBlockedEmbed = resolve; });
  pipeline.embed = async (texts, signal) => {
    if (texts.some(text => text.includes('low budget marker'))) {
      beginBlockedEmbed();
      await new Promise<never>((_resolve, reject) => {
        const onAbort = () => reject(new DomainError('CANCELED', 'The embedding operation received an abort signal.', 409));
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      });
    }
    return embed(texts, signal);
  };
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'short-task-budget-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline, pipelineTaskDurationMs: 1_000,
  });
  assert.equal(backend.pipelineTaskDurationMs, 1_000);
  assert.throws(() => new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'invalid-task-budget-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipelineTaskDurationMs: 900_001,
  }), (error: unknown) => error instanceof DomainError && error.code === 'TASK_DURATION_INVALID');
  assert.throws(() => new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'zero-task-budget-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipelineTaskDurationMs: 0,
  }), (error: unknown) => error instanceof DomainError && error.code === 'TASK_DURATION_INVALID');

  const principal = await provision(backend, 'owner-short-task-budget');
  const knowledgeBaseId = await createKb(backend, principal);
  const initial = await saveIndexed(backend, principal, knowledgeBaseId, 'low budget baseline');
  const update = await backend.admit(principal, updateRequest(knowledgeBaseId, initial.saved.documentId, 1, 'low budget marker'));
  await environment.pool.query(`UPDATE pd_tasks SET created_at = now() - interval '500 milliseconds' WHERE tenant_id = $1 AND id = $2`,
    [principal.tenantId, update.id]);
  const executing = backend.execute(update.id, new AbortController().signal);
  await blockedEmbedStarted;
  const result = await executing;
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'TASK_TIME_BUDGET_EXCEEDED');
  assert.equal((await backend.readContent(principal, initial.saved.documentId)).bytes.toString('utf8'), 'low budget baseline');
});

test('document updates stage a new version while the old active version stays searchable, then publish with CAS', { timeout: 60_000 }, async () => {
  let beginUpdateEmbed!: () => void;
  let releaseUpdateEmbed!: () => void;
  const updateEmbedStarted = new Promise<void>(resolve => { beginUpdateEmbed = resolve; });
  const updateEmbedGate = new Promise<void>(resolve => { releaseUpdateEmbed = resolve; });
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'update-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline({ beforeEmbed: async texts => { if (texts.some(text => text.includes('new revision marker'))) { beginUpdateEmbed(); await updateEmbedGate; } } }),
  });
  const principal = await provision(backend, 'owner-update-cas');
  const knowledgeBaseId = await createKb(backend, principal);
  const initial = await saveIndexed(backend, principal, knowledgeBaseId, 'old revision marker');
  const update = await backend.admit(principal, updateRequest(knowledgeBaseId, initial.saved.documentId, 1, 'new revision marker'));
  const executing = backend.execute(update.id, new AbortController().signal);
  await updateEmbedStarted;

  const duringGetTask = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.get', requestId: `during-update-get-${randomUUID()}`, knowledgeBaseId,
    input: { documentId: initial.saved.documentId },
  });
  const duringGet = await backend.execute(duringGetTask.id, new AbortController().signal);
  assert.equal((duringGet.result as { version: number; content: { text: string } }).version, 1);
  assert.match((duringGet.result as { content: { text: string } }).content.text, /old revision marker/);
  const oldSearch = await search(backend, principal, knowledgeBaseId, 'old revision marker', 'keyword', [initial.saved.documentId]);
  assert.equal((oldSearch.result as { results: unknown[] }).results.length, 1);
  const stagedSearch = await search(backend, principal, knowledgeBaseId, 'new revision marker', 'keyword', [initial.saved.documentId]);
  assert.equal((stagedSearch.result as { results: unknown[] }).results.length, 0);

  const conflictTask = await backend.admit(principal, updateRequest(knowledgeBaseId, initial.saved.documentId, 1, 'competing revision marker'));
  assert.equal(conflictTask.state, 'failed');
  assert.equal(conflictTask.result?.error?.code, 'VERSION_CONFLICT');
  releaseUpdateEmbed();
  const published = await executing;
  assert.equal(published.outcome, 'succeeded', published.error?.message);
  const updated = published.result as { documentId: string; version: number; indexState: string; generationId: string };
  assert.equal(updated.version, 2);
  assert.equal(updated.indexState, 'ready');
  assert.ok(updated.generationId);

  const newSearch = await search(backend, principal, knowledgeBaseId, 'new revision marker', 'keyword', [initial.saved.documentId]);
  assert.equal((newSearch.result as { results: unknown[] }).results.length, 1);
  const staleSearch = await search(backend, principal, knowledgeBaseId, 'old revision marker', 'keyword', [initial.saved.documentId]);
  assert.equal((staleSearch.result as { results: unknown[] }).results.length, 0);
  const versions = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2`,
    [principal.tenantId, initial.saved.documentId],
  );
  assert.equal(versions.rows[0]?.count, 2);
});

test('stored document updates keep the old active version until the public ingestion child publishes', { timeout: 60_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'stored-update-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline(),
  });
  const principal = await provision(backend, 'owner-stored-update');
  const knowledgeBaseId = await createKb(backend, principal);
  const initial = await saveIndexed(backend, principal, knowledgeBaseId, 'stored update old phrase');
  const parent = await backend.admit(principal, updateRequest(knowledgeBaseId, initial.saved.documentId, 1, 'stored update new phrase', 'stored'));
  const stored = await backend.execute(parent.id, new AbortController().signal);
  assert.equal(stored.outcome, 'succeeded', stored.error?.message);
  const saved = stored.result as { version: number; indexState: string; ingestionTaskId: string };
  assert.equal(saved.version, 2);
  assert.equal(saved.indexState, 'stored');
  assert.ok(saved.ingestionTaskId);

  const during = await backend.readContent(principal, initial.saved.documentId);
  assert.equal(during.bytes.toString('utf8'), 'stored update old phrase');
  const beforePublish = await search(backend, principal, knowledgeBaseId, 'stored update new phrase', 'keyword', [initial.saved.documentId]);
  assert.equal((beforePublish.result as { results: unknown[] }).results.length, 0);

  const child = await backend.execute(saved.ingestionTaskId, new AbortController().signal);
  assert.equal(child.outcome, 'succeeded', child.error?.message);
  assert.equal((child.result as { indexState: string }).indexState, 'ready');
  assert.equal((await backend.readContent(principal, initial.saved.documentId)).bytes.toString('utf8'), 'stored update new phrase');
  const afterPublish = await search(backend, principal, knowledgeBaseId, 'stored update new phrase', 'keyword', [initial.saved.documentId]);
  assert.equal((afterPublish.result as { results: Array<{ version: number }> }).results[0]?.version, 2);
});

test('canceling or failing an update releases its version reservation so the active version can be retried', { timeout: 60_000 }, async () => {
  const pipeline = makePipeline();
  const parse = pipeline.parse.bind(pipeline);
  let failRetrySourceOnce = true;
  pipeline.parse = async (bytes, mimeType, signal) => {
    if (failRetrySourceOnce && bytes.toString('utf8').includes('retry parse fault')) {
      failRetrySourceOnce = false;
      throw new DomainError('PARSER_FAILED', 'Injected parser failure.', 502, true);
    }
    return parse(bytes, mimeType, signal);
  };
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'update-reservation-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline,
  });
  const principal = await provision(backend, 'owner-update-reservation');
  const knowledgeBaseId = await createKb(backend, principal);
  const initial = await saveIndexed(backend, principal, knowledgeBaseId, 'reservation baseline');

  const storedUpdate = await backend.admit(principal, updateRequest(knowledgeBaseId, initial.saved.documentId, 1, 'canceled update body', 'stored'));
  const storedResult = await backend.execute(storedUpdate.id, new AbortController().signal);
  assert.equal(storedResult.outcome, 'succeeded');
  const stored = storedResult.result as { ingestionTaskId: string; version: number };
  assert.equal(stored.version, 2);
  const canceledChild = await backend.cancel(principal, stored.ingestionTaskId);
  assert.equal(canceledChild.state, 'canceled');
  const afterCancel = await environment.pool.query<{ reservations: number; versions: number; active_version: number }>(
    `SELECT (SELECT count(*)::int FROM pd_document_update_reservations WHERE tenant_id = $1 AND document_id = $2) AS reservations,
            (SELECT count(*)::int FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2 AND version = 2) AS versions,
            active_version
     FROM pd_documents WHERE tenant_id = $1 AND id = $2`,
    [principal.tenantId, initial.saved.documentId],
  );
  assert.deepEqual(afterCancel.rows[0], { reservations: 0, versions: 0, active_version: 1 });

  const retryCanceled = await backend.admit(principal, updateRequest(knowledgeBaseId, initial.saved.documentId, 1, 'retry after canceled update', 'stored'));
  const retryCanceledResult = await backend.execute(retryCanceled.id, new AbortController().signal);
  assert.equal(retryCanceledResult.outcome, 'succeeded', retryCanceledResult.error?.message);
  const retryChildId = (retryCanceledResult.result as { ingestionTaskId: string }).ingestionTaskId;
  assert.equal((await backend.execute(retryChildId, new AbortController().signal)).outcome, 'succeeded');

  const failedUpdate = await backend.admit(principal, updateRequest(knowledgeBaseId, initial.saved.documentId, 2, 'retry parse fault first attempt'));
  const failedResult = await backend.execute(failedUpdate.id, new AbortController().signal);
  assert.equal(failedResult.outcome, 'failed');
  assert.equal(failedResult.error?.code, 'PARSER_FAILED');
  const afterFailure = await environment.pool.query<{ reservations: number; target_versions: number; active_version: number }>(
    `SELECT (SELECT count(*)::int FROM pd_document_update_reservations WHERE tenant_id = $1 AND document_id = $2) AS reservations,
            (SELECT count(*)::int FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2 AND version = 3) AS target_versions,
            active_version
     FROM pd_documents WHERE tenant_id = $1 AND id = $2`,
    [principal.tenantId, initial.saved.documentId],
  );
  assert.deepEqual(afterFailure.rows[0], { reservations: 0, target_versions: 0, active_version: 2 });
  const retryFailed = await backend.admit(principal, updateRequest(knowledgeBaseId, initial.saved.documentId, 2, 'retry after parser failure'));
  const retryFailedResult = await backend.execute(retryFailed.id, new AbortController().signal);
  assert.equal(retryFailedResult.outcome, 'succeeded', retryFailedResult.error?.message);
  assert.equal((retryFailedResult.result as { version: number }).version, 3);
  assert.equal((await backend.readContent(principal, initial.saved.documentId)).bytes.toString('utf8'), 'retry after parser failure');
});

test('document.get cursors page Unicode code points and bind principal, version, and page size', { timeout: 60_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'content-cursor-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline(),
  });
  const principal = await provision(backend, 'owner-content-cursor');
  const knowledgeBaseId = await createKb(backend, principal);
  const text = `标题😀\n${'片段😀'.repeat(45)}`;
  const { saved } = await saveIndexed(backend, principal, knowledgeBaseId, text);
  const readPage = async (cursor?: string, limit = 17, version?: number) => {
    const task = await backend.admit(principal, {
      schemaVersion: '1.0', operation: 'document.get', requestId: `cursor-get-${randomUUID()}`, knowledgeBaseId,
      input: { documentId: saved.documentId, limit, ...(cursor ? { cursor } : {}), ...(version ? { version } : {}) },
    });
    return backend.execute(task.id, new AbortController().signal);
  };
  const firstPage = await readPage();
  assert.equal(firstPage.outcome, 'succeeded', firstPage.error?.message);
  const firstValue = firstPage.result as { content: { text: string; truncated: boolean; nextCursor?: string }; version: number };
  assert.equal(firstValue.version, 1);
  assert.equal(firstValue.content.truncated, true);
  assert.ok(firstValue.content.nextCursor);
  let content = firstValue.content.text;
  let nextCursor: string | undefined = firstValue.content.nextCursor;
  const updatedText = 'Updated content must not change an already paged version.';
  const update = await backend.admit(principal, updateRequest(knowledgeBaseId, saved.documentId, 1, updatedText));
  const updateResult = await backend.execute(update.id, new AbortController().signal);
  assert.equal(updateResult.outcome, 'succeeded', updateResult.error?.message);
  assert.equal((updateResult.result as { version: number }).version, 2);

  let page = await readPage(nextCursor, 17);
  for (let pageIndex = 0; pageIndex < 20; pageIndex += 1) {
    assert.equal(page.outcome, 'succeeded', page.error?.message);
    const value = page.result as { content: { text: string; truncated: boolean; nextCursor?: string }; version: number };
    assert.equal(value.version, 1);
    assert.ok(Array.from(value.content.text).length <= 17);
    content += value.content.text;
    if (!value.content.truncated) { nextCursor = undefined; break; }
    assert.ok(value.content.nextCursor);
    nextCursor = value.content.nextCursor;
    page = await readPage(nextCursor, 17, 1);
  }
  assert.equal(content, text);
  assert.equal(nextCursor, undefined);
  const currentVersion = await readPage(undefined, 17);
  assert.equal((currentVersion.result as { version: number }).version, 2);
  assert.match((currentVersion.result as { content: { text: string } }).content.text, /^Updated content/);

  const first = await readPage(undefined, 10, 1);
  const cursor = (first.result as { content: { nextCursor: string } }).content.nextCursor;
  const changedLimit = await readPage(cursor, 11, 1);
  assert.equal(changedLimit.outcome, 'failed');
  assert.equal(changedLimit.error?.code, 'INVALID_CURSOR');
  await environment.pool.query(`UPDATE pd_content_cursors SET expires_at = now() - interval '1 second' WHERE id = $1`, [cursor]);
  const expired = await readPage(cursor, 10, 1);
  assert.equal(expired.outcome, 'failed');
  assert.equal(expired.error?.code, 'CURSOR_EXPIRED');
  await readPage(undefined, 10, 1);
  const expiredContentCursor = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_content_cursors WHERE id = $1`, [cursor],
  );
  assert.equal(expiredContentCursor.rows[0]?.count, 0);
});

test('delete tombstones immediately, hides historical document artifacts, and purges only unshared blobs', { timeout: 60_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'purge-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline(),
  });
  const principal = await provision(backend, 'owner-delete-purge');
  const knowledgeBaseId = await createKb(backend, principal);
  const sharedText = 'shared source body remains available through the sibling document';
  const victim = await saveIndexed(backend, principal, knowledgeBaseId, sharedText);
  const sibling = await saveIndexed(backend, principal, knowledgeBaseId, sharedText);
  const blobBefore = await environment.pool.query<{ relative_path: string; count: number }>(
    `SELECT b.relative_path, count(v.document_id)::int AS count FROM pd_blobs b
     JOIN pd_document_versions v ON v.tenant_id = b.tenant_id AND v.sha256 = b.sha256
     WHERE b.tenant_id = $1 AND b.sha256 = $2 GROUP BY b.relative_path`,
    [principal.tenantId, victim.saved ? (await backend.readContent(principal, victim.saved.documentId)).sha256 : ''],
  );
  assert.equal(blobBefore.rows[0]?.count, 2);

  const getTask = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.get', requestId: `before-delete-get-${randomUUID()}`, knowledgeBaseId,
    input: { documentId: victim.saved.documentId, version: 1 },
  });
  assert.equal((await backend.execute(getTask.id, new AbortController().signal)).outcome, 'succeeded');
  const queryTask = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.search', requestId: `before-delete-search-${randomUUID()}`, knowledgeBaseId,
    input: { query: 'shared source body', mode: 'keyword', filters: { documentIds: [victim.saved.documentId] } },
  });
  assert.equal((await backend.execute(queryTask.id, new AbortController().signal)).outcome, 'succeeded');

  const deleteTask = await backend.admit(principal, deleteRequest(knowledgeBaseId, victim.saved.documentId, 1));
  const deleted = await backend.execute(deleteTask.id, new AbortController().signal);
  assert.equal(deleted.outcome, 'succeeded', deleted.error?.message);
  const deleteResult = deleted.result as { documentId: string; deleted: boolean; purgeState: string; purgeTaskId: string };
  assert.equal(deleteResult.deleted, true);
  assert.equal(deleteResult.purgeState, 'pending');
  assert.ok(deleteResult.purgeTaskId);
  assert.equal((await backend.getTask(principal, deleteTask.id)).result?.result?.purgeState, 'pending');
  await assert.rejects(backend.readContent(principal, victim.saved.documentId),
    (error: unknown) => error instanceof DomainError && error.code === 'DOCUMENT_NOT_FOUND');
  await assert.rejects(backend.getTask(principal, getTask.id),
    (error: unknown) => error instanceof DomainError && error.code === 'DOCUMENT_NOT_FOUND');
  await assert.rejects(backend.getTask(principal, queryTask.id),
    (error: unknown) => error instanceof DomainError && error.code === 'DOCUMENT_NOT_FOUND');
  const hiddenHistory = await backend.listTasks(principal);
  assert.equal(hiddenHistory.some(task => [getTask.id, queryTask.id, victim.task.id].includes(task.id)), false);
  const listTask = await backend.admit(principal, {
    schemaVersion: '1.0', operation: 'document.list', requestId: `after-delete-list-${randomUUID()}`, knowledgeBaseId,
    input: { filters: { documentIds: [victim.saved.documentId] } },
  });
  const list = await backend.execute(listTask.id, new AbortController().signal);
  assert.equal((list.result as { documents: unknown[] }).documents.length, 0);
  const searchResult = await search(backend, principal, knowledgeBaseId, 'shared source body', 'keyword', [victim.saved.documentId]);
  assert.equal((searchResult.result as { results: unknown[] }).results.length, 0);

  const purgeTask = await backend.getTask(principal, deleteResult.purgeTaskId);
  assert.equal(purgeTask.kind, 'purge');
  assert.equal(purgeTask.state, 'submitted');
  const purged = await backend.execute(purgeTask.id, new AbortController().signal);
  assert.equal(purged.outcome, 'succeeded', purged.error?.message);
  assert.equal((purged.result as { purgeState: string }).purgeState, 'completed');
  const deleteAfterPurge = await backend.getTask(principal, deleteTask.id);
  assert.equal(deleteAfterPurge.state, 'completed');
  assert.equal(deleteAfterPurge.result?.result?.purgeState, 'completed');
  assert.deepEqual((await backend.readContent(principal, sibling.saved.documentId)).bytes, Buffer.from(sharedText));
  const versions = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2`,
    [principal.tenantId, victim.saved.documentId],
  );
  assert.equal(versions.rows[0]?.count, 0);
  assert.equal(blobBefore.rows[0]?.relative_path, (await environment.pool.query<{ relative_path: string }>(
    `SELECT relative_path FROM pd_blobs WHERE tenant_id = $1 AND sha256 = $2`, [principal.tenantId, victim.saved.sha256],
  )).rows[0]?.relative_path);
});

test('upload IDs are owner and KB bound, expire after one hour, and keep replayed results stable', { timeout: 60_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'upload-blobs'), publicBaseUrl: 'https://documents.example.test',
  });
  const principal = await provision(backend, 'owner-upload-lifecycle');
  const knowledgeBaseId = await createKb(backend, principal);
  const bytes = Buffer.from('upload bytes are checked and saved as immutable source content.\n', 'utf8');
  const upload = await backend.createUpload(principal, knowledgeBaseId, bytes, 'text/plain; charset=utf-8');
  assert.equal(upload.size, bytes.byteLength);
  assert.equal(upload.mime, 'text/plain');
  assert.ok(Date.parse(upload.expiresAt) - Date.now() > 59 * 60_000);
  assert.ok(Date.parse(upload.expiresAt) - Date.now() <= 60 * 60_000);
  const request = uploadSaveRequest(knowledgeBaseId, upload.uploadId, 'stored');
  const task = await backend.admit(principal, request);
  const saved = await backend.execute(task.id, new AbortController().signal);
  assert.equal(saved.outcome, 'succeeded', saved.error?.message);
  const stored = saved.result as { documentId: string; sha256: string; ingestionTaskId: string };
  assert.equal(stored.sha256, upload.sha256);
  assert.deepEqual((await backend.readContent(principal, stored.documentId)).bytes, bytes);

  await environment.pool.query(
    `UPDATE pd_uploads SET expires_at = now() - interval '1 second' WHERE tenant_id = $1 AND upload_id = $2`,
    [principal.tenantId, upload.uploadId],
  );
  const replay = await backend.admit(principal, request);
  assert.equal(replay.id, task.id);
  assert.deepEqual(await backend.execute(replay.id, new AbortController().signal), saved);

  const expiredUpload = await backend.createUpload(principal, knowledgeBaseId, Buffer.from('expired upload'), 'text/plain');
  await environment.pool.query(
    `UPDATE pd_uploads SET expires_at = now() - interval '1 second' WHERE tenant_id = $1 AND upload_id = $2`,
    [principal.tenantId, expiredUpload.uploadId],
  );
  const expiredTask = await backend.admit(principal, uploadSaveRequest(knowledgeBaseId, expiredUpload.uploadId, 'stored'));
  const expired = await backend.execute(expiredTask.id, new AbortController().signal);
  assert.equal(expired.outcome, 'failed');
  assert.equal(expired.error?.code, 'UPLOAD_EXPIRED');
  const expiredStored = await backend.getTask(principal, expiredTask.id);
  assert.equal(expiredStored.state, 'failed');
  assert.equal(expiredStored.result?.error?.code, 'UPLOAD_EXPIRED');
  assert.equal(expiredStored.result?.result, undefined);

  const writerId = `writer-${randomUUID()}`;
  const writerToken = `opaque-${writerId}`;
  await backend.provisionPrincipal({ tenantId: principal.tenantId, id: writerId, scopes: ['knowledge:read', 'knowledge:write'], token: writerToken });
  const writer = await backend.authenticate(writerToken);
  assert.ok(writer);
  await backend.grantKnowledgeBase(writer, knowledgeBaseId, ['knowledge:write']);
  const writerUpload = await backend.createUpload(writer, knowledgeBaseId, Buffer.from('different owner bytes'), 'text/plain');
  const wrongOwnerTask = await backend.admit(principal, uploadSaveRequest(knowledgeBaseId, writerUpload.uploadId, 'stored'));
  const wrongOwner = await backend.execute(wrongOwnerTask.id, new AbortController().signal);
  assert.equal(wrongOwner.outcome, 'failed');
  assert.equal(wrongOwner.error?.code, 'INVALID_UPLOAD');

  await assert.rejects(backend.createUpload(principal, knowledgeBaseId, Buffer.from('not a PDF'), 'application/pdf'),
    (error: unknown) => error instanceof DomainError && error.code === 'INVALID_UPLOAD');
  await assert.rejects(backend.createUpload(principal, knowledgeBaseId, Buffer.from('plain text'), 'application/octet-stream'),
    (error: unknown) => error instanceof DomainError && error.code === 'UNSUPPORTED_FORMAT');
  await assert.rejects(backend.createUpload(principal, knowledgeBaseId, Buffer.alloc(50 * 1024 * 1024 + 1), 'text/plain'),
    (error: unknown) => error instanceof DomainError && error.code === 'SIZE_LIMIT');
});

test('the shared parser indexes and preserves source bytes for TXT, Markdown, PDF, DOCX, and HTML uploads', { timeout: 120_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'format-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makeParserPipeline(),
  });
  const principal = await provision(backend, 'owner-format-matrix');
  const knowledgeBaseId = await createKb(backend, principal);
  const formats = [
    { folder: 'txt', extension: 'txt', mime: 'text/plain' },
    { folder: 'md', extension: 'md', mime: 'text/markdown' },
    { folder: 'pdf', extension: 'pdf', mime: 'application/pdf' },
    { folder: 'docx', extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
    { folder: 'html', extension: 'html', mime: 'text/html' },
  ];
  for (const format of formats) {
    const bytes = await readFile(join(fixtureRoot, format.folder, `normal.${format.extension}`));
    const upload = await backend.createUpload(principal, knowledgeBaseId, bytes, format.mime);
    const task = await backend.admit(principal, uploadSaveRequest(knowledgeBaseId, upload.uploadId));
    const result = await backend.execute(task.id, new AbortController().signal);
    assert.equal(result.outcome, 'succeeded', `${format.folder}: ${result.error?.message}`);
    const saved = result.result as { documentId: string; version: number; indexState: string; generationId: string };
    assert.equal(saved.indexState, 'ready', format.folder);
    assert.ok(saved.generationId, format.folder);
    assert.deepEqual((await backend.readContent(principal, saved.documentId, 1)).bytes, bytes, format.folder);
    const getTask = await backend.admit(principal, {
      schemaVersion: '1.0', operation: 'document.get', requestId: `format-get-${format.folder}-${randomUUID()}`, knowledgeBaseId,
      input: { documentId: saved.documentId, version: 1 },
    });
    const getResult = await backend.execute(getTask.id, new AbortController().signal);
    assert.equal(getResult.outcome, 'succeeded', `${format.folder}: ${getResult.error?.message}`);
    const readable = getResult.result as { content: { text: string }; indexState: string };
    assert.equal(readable.content.text, (await parseSource(bytes, format.mime)).text, format.folder);
    assert.equal(readable.indexState, 'ready', format.folder);
    const metadata = await environment.pool.query<{
      source_type: string; mime_type: string; source_upload_id: string; source_uri: string | null; fetched_at: Date | null; chunk_count: number;
    }>(
      `SELECT d.source_type, v.mime_type, v.source_upload_id, v.source_uri, v.fetched_at, g.chunk_count
       FROM pd_documents d
       JOIN pd_document_versions v ON v.tenant_id = d.tenant_id AND v.document_id = d.id AND v.version = $3
       JOIN pd_index_generations g ON g.tenant_id = d.tenant_id AND g.document_id = d.id AND g.version = v.version AND g.generation_id = $4
       WHERE d.tenant_id = $1 AND d.id = $2`,
      [principal.tenantId, saved.documentId, saved.version, saved.generationId],
    );
    assert.equal(metadata.rows[0]?.source_type, 'upload', format.folder);
    assert.equal(metadata.rows[0]?.mime_type, format.mime, format.folder);
    assert.equal(metadata.rows[0]?.source_upload_id, upload.uploadId, format.folder);
    assert.equal(metadata.rows[0]?.source_uri, null, format.folder);
    assert.equal(metadata.rows[0]?.fetched_at, null, format.folder);
    assert.ok(Number(metadata.rows[0]?.chunk_count) > 0, format.folder);
  }
});

test('stored saves stay invisible until the public ingestion task publishes its generation', { timeout: 60_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'stored-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline(),
  });
  const principal = await provision(backend, 'owner-stored-child');
  const knowledgeBaseId = await createKb(backend, principal);
  const parent = await backend.admit(principal, saveRequest(knowledgeBaseId, '只有 ingestion 完成后才应出现在搜索里。', 'stored'));
  const storedResult = await backend.execute(parent.id, new AbortController().signal);
  assert.equal(storedResult.outcome, 'succeeded');
  const saved = storedResult.result as { documentId: string; ingestionTaskId: string; indexState: string };
  assert.equal(saved.indexState, 'stored');
  assert.ok(saved.ingestionTaskId);
  assert.equal((await backend.getTask(principal, saved.ingestionTaskId)).state, 'submitted');
  const before = await search(backend, principal, knowledgeBaseId, 'ingestion 搜索', 'keyword', [saved.documentId]);
  assert.equal((before.result as { results: unknown[] }).results.length, 0);

  const child = await backend.execute(saved.ingestionTaskId, new AbortController().signal);
  assert.equal(child.outcome, 'succeeded', child.error?.message);
  assert.equal((child.result as { indexState: string }).indexState, 'ready');
  const after = await search(backend, principal, knowledgeBaseId, 'ingestion 搜索', 'keyword', [saved.documentId]);
  assert.equal((after.result as { results: unknown[] }).results.length, 1);
});

test('admission caps active per-principal ingestion at two and checks idempotent replay first', { timeout: 60_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'ingestion-limit-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline(),
  });
  const principal = await provision(backend, 'owner-ingestion-limit');
  const knowledgeBaseId = await createKb(backend, principal);
  const firstRequest = saveRequest(knowledgeBaseId, 'active slot one', 'stored');
  const secondRequest = saveRequest(knowledgeBaseId, 'active slot two', 'stored');
  const first = await backend.admit(principal, firstRequest);
  const second = await backend.admit(principal, secondRequest);
  assert.equal(first.state, 'submitted');
  assert.equal(second.state, 'submitted');
  await assert.rejects(backend.admit(principal, saveRequest(knowledgeBaseId, 'active slot three', 'stored')),
    (error: unknown) => error instanceof DomainError && error.code === 'LIMIT_EXCEEDED' && error.status === 429 && error.retryable);
  assert.equal((await backend.admit(principal, firstRequest)).id, first.id);

  const firstStored = await backend.execute(first.id, new AbortController().signal);
  const ingestionId = (firstStored.result as { ingestionTaskId: string }).ingestionTaskId;
  assert.equal((await backend.getTask(principal, ingestionId)).state, 'submitted');
  await assert.rejects(backend.admit(principal, saveRequest(knowledgeBaseId, 'still full', 'stored')),
    (error: unknown) => error instanceof DomainError && error.code === 'LIMIT_EXCEEDED' && error.status === 429 && error.retryable);
  await backend.execute(ingestionId, new AbortController().signal);
  const available = await backend.admit(principal, saveRequest(knowledgeBaseId, 'slot available', 'stored'));
  assert.equal(available.state, 'submitted');
});

test('embedding cache is scoped by tenant, profile, and content hash', { timeout: 60_000 }, async () => {
  const counts = { parse: 0, embed: 0 };
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'embedding-cache-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline({ counts }),
  });
  const principal = await provision(backend, 'owner-embedding-cache');
  const knowledgeBaseId = await createKb(backend, principal);
  await saveIndexed(backend, principal, knowledgeBaseId, 'shared content cache phrase');
  assert.equal(counts.embed, 1);
  await saveIndexed(backend, principal, knowledgeBaseId, 'shared content cache phrase');
  assert.equal(counts.embed, 1);
  const cacheRows = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_embedding_cache WHERE tenant_id = $1`, [principal.tenantId],
  );
  assert.equal(cacheRows.rows[0]?.count, 1);

  const otherPrincipal = await provision(backend, 'other-tenant-embedding-cache');
  const otherKb = await createKb(backend, otherPrincipal);
  await saveIndexed(backend, otherPrincipal, otherKb, 'shared content cache phrase');
  assert.equal(counts.embed, 2);
});

test('parse and completed embedding batches survive Pi checkpoint failure and are reused on replay', { timeout: 60_000 }, async () => {
  const counts = { parse: 0, embed: 0 };
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'receipt-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline({ counts }),
  });
  const principal = await provision(backend, 'owner-receipt-replay');
  const knowledgeBaseId = await createKb(backend, principal);
  const task = await backend.admit(principal, saveRequest(knowledgeBaseId,
    Array.from({ length: 9 }, (_, index) => `receipt replay line ${index}`).join('\n')));
  await assert.rejects(
    backend.execute(task.id, new AbortController().signal, async step => {
      if (step === 'embedding-batch-0-receipt') throw new Error('simulated Pi checkpoint interruption');
    }),
    /simulated Pi checkpoint interruption/,
  );
  assert.equal(counts.parse, 1);
  const receipt = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = 'parse'`,
    [principal.tenantId, task.id],
  );
  assert.equal(receipt.rows[0]?.count, 1);

  const replay = await backend.execute(task.id, new AbortController().signal);
  assert.equal(replay.outcome, 'succeeded', replay.error?.message);
  assert.equal(counts.parse, 1);
  assert.equal(counts.embed, 2);
  const finalTask = await backend.getTask(principal, task.id);
  assert.equal(finalTask.state, 'completed');
  const embeddingReceipts = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = 'embedding'`,
    [principal.tenantId, task.id],
  );
  assert.equal(embeddingReceipts.rows[0]?.count, 2);
});

test('canceling an in-flight ingestion prevents staging generation publication', { timeout: 60_000 }, async () => {
  let beginEmbed!: () => void;
  let releaseEmbed!: () => void;
  const embedStarted = new Promise<void>(resolve => { beginEmbed = resolve; });
  const embedGate = new Promise<void>(resolve => { releaseEmbed = resolve; });
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'cancel-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline({ beforeEmbed: async texts => { if (texts.some(text => text.includes('cancel during vector call'))) { beginEmbed(); await embedGate; } } }),
  });
  const principal = await provision(backend, 'owner-cancel-indexing');
  const knowledgeBaseId = await createKb(backend, principal);
  const task = await backend.admit(principal, saveRequest(knowledgeBaseId, 'cancel during vector call'));
  const executing = backend.execute(task.id, new AbortController().signal);
  await embedStarted;
  const source = await environment.pool.query<{ id: string }>(`SELECT id FROM pd_documents WHERE created_by_task_id = $1`, [task.id]);
  assert.ok(source.rows[0]);
  const stagingSearch = await search(backend, principal, knowledgeBaseId, 'cancel vector', 'keyword', [source.rows[0].id]);
  assert.equal((stagingSearch.result as { results: unknown[] }).results.length, 0);
  const canceled = await backend.cancel(principal, task.id);
  assert.equal(canceled.state, 'canceled');
  releaseEmbed();
  const outcome = await executing;
  assert.equal(outcome.outcome, 'failed');
  assert.equal(outcome.error?.code, 'CANCELED');
  const active = await environment.pool.query<{ active_generation_id: string | null }>(
    `SELECT d.active_generation_id FROM pd_documents d WHERE d.created_by_task_id = $1`, [task.id],
  );
  assert.equal(active.rows[0]?.active_generation_id, null);
  const generation = await environment.pool.query<{ state: string }>(
    `SELECT state FROM pd_index_generations WHERE tenant_id = $1 AND document_id = (SELECT id FROM pd_documents WHERE created_by_task_id = $2)`,
    [principal.tenantId, task.id],
  );
  assert.equal(generation.rows[0]?.state, 'canceled');
});

test('empty parser output and malformed embedding vectors cannot publish a ready generation', { timeout: 60_000 }, async () => {
  const emptyPipeline = makePipeline();
  emptyPipeline.parse = async () => ({ text: '', chunks: [], warnings: [] });
  const emptyBackend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'empty-parse-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: emptyPipeline,
  });
  const emptyPrincipal = await provision(emptyBackend, 'owner-empty-parse');
  const emptyKb = await createKb(emptyBackend, emptyPrincipal);
  const emptyTask = await emptyBackend.admit(emptyPrincipal, saveRequest(emptyKb, 'empty parse must fail'));
  const emptyResult = await emptyBackend.execute(emptyTask.id, new AbortController().signal);
  assert.equal(emptyResult.outcome, 'failed');
  assert.equal(emptyResult.error?.code, 'EMPTY_PARSE');

  const malformedPipeline = makePipeline();
  malformedPipeline.embed = async texts => texts.map(() => [1, 0]);
  const malformedBackend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'bad-embedding-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: malformedPipeline,
  });
  const malformedPrincipal = await provision(malformedBackend, 'owner-bad-embedding');
  const malformedKb = await createKb(malformedBackend, malformedPrincipal);
  const malformedTask = await malformedBackend.admit(malformedPrincipal, saveRequest(malformedKb, 'bad embedding dimensions must fail'));
  const malformedResult = await malformedBackend.execute(malformedTask.id, new AbortController().signal);
  assert.equal(malformedResult.outcome, 'failed');
  assert.equal(malformedResult.error?.code, 'EMBEDDING_DIMENSION_MISMATCH');
  const chunks = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_indexed_chunks WHERE tenant_id = $1`, [malformedPrincipal.tenantId],
  );
  assert.equal(chunks.rows[0]?.count, 0);
});

test('migration and pipeline reject a dimension that differs from the configured pgvector schema', { timeout: 60_000 }, async () => {
  await assert.rejects(migrateVector(environment.pool, 4),
    (error: unknown) => error instanceof DomainError && error.code === 'VECTOR_DIMENSION_MISMATCH');
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'dimension-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makePipeline({ dimensions: 4, profileId: 'wrong-dimension-profile' }),
  });
  const principal = await provision(backend, 'owner-wrong-dimension');
  const knowledgeBaseId = await createKb(backend, principal);
  const task = await backend.admit(principal, saveRequest(knowledgeBaseId, 'dimension mismatch must fail'));
  const result = await backend.execute(task.id, new AbortController().signal);
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error?.code, 'VECTOR_DIMENSION_MISMATCH');
  assert.equal((await backend.getTask(principal, task.id)).state, 'failed');
});

test('a real public HTML URL is fetched outside PostgreSQL, indexed, and retains final source provenance', { timeout: 120_000 }, async () => {
  const backend = new PostgresDocumentBackend({
    pool: environment.pool, blobRoot: join(environment.root, 'url-blobs'), publicBaseUrl: 'https://documents.example.test',
    pipeline: makeParserPipeline(),
  });
  const principal = await provision(backend, 'owner-public-url');
  const knowledgeBaseId = await createKb(backend, principal);
  const request: DocumentRequest = {
    schemaVersion: '1.0', operation: 'document.save', requestId: `url-save-${randomUUID()}`, knowledgeBaseId,
    input: { source: { kind: 'url', url: 'https://example.com/' }, title: 'Example Domain', waitFor: 'indexed' },
  };
  const task = await backend.admit(principal, request);
  const result = await backend.execute(task.id, new AbortController().signal);
  assert.equal(result.outcome, 'succeeded', result.error?.message);
  const saved = result.result as { documentId: string; version: number; generationId: string; indexState: string; sha256: string };
  assert.equal(saved.indexState, 'ready');
  const provenance = await environment.pool.query<{ source_uri: string; fetched_at: Date; mime_type: string }>(
    `SELECT source_uri, fetched_at, mime_type FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2 AND version = $3`,
    [principal.tenantId, saved.documentId, saved.version],
  );
  assert.equal(provenance.rows[0]?.source_uri, 'https://example.com/');
  assert.ok(provenance.rows[0]?.fetched_at instanceof Date);
  assert.equal(provenance.rows[0]?.mime_type, 'text/html');
  const source = await backend.readContent(principal, saved.documentId, saved.version);
  assert.equal(source.sha256, saved.sha256);
  assert.match(source.bytes.toString('utf8'), /Example Domain/);
  const indexed = await environment.pool.query<{ text_content: string; lexical_tokens: string[]; lexical_tsv: string }>(
    `SELECT text_content, lexical_tokens, lexical_tsv FROM pd_indexed_chunks WHERE tenant_id = $1 AND document_id = $2`,
    [principal.tenantId, saved.documentId],
  );
  assert.ok(indexed.rows.some(row => /example/i.test(row.text_content)), JSON.stringify(indexed.rows));
  assert.ok(indexed.rows.some(row => row.lexical_tokens.includes('documentation')), JSON.stringify(indexed.rows));
  const hits = await search(backend, principal, knowledgeBaseId, 'documentation', 'keyword', [saved.documentId]);
  const searchResult = hits.result as { results: Array<{ sourceUri?: string }> };
  assert.ok(searchResult.results.length > 0, JSON.stringify(hits));
  const firstHit = searchResult.results[0];
  assert.equal(firstHit?.sourceUri, 'https://example.com/');
  const resultReplay = await backend.execute(task.id, new AbortController().signal);
  assert.deepEqual(resultReplay, result);
  const receipts = await environment.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = 'source-fetch'`,
    [principal.tenantId, task.id],
  );
  assert.equal(receipts.rows[0]?.count, 1);

  const storedTask = await backend.admit(principal, {
    ...request,
    requestId: `url-stored-${randomUUID()}`,
    input: { ...request.input, title: 'Example Domain stored', waitFor: 'stored' },
  });
  const stored = await backend.execute(storedTask.id, new AbortController().signal);
  assert.equal(stored.outcome, 'succeeded', stored.error?.message);
  const storedResult = stored.result as { indexState: string; ingestionTaskId: string; documentId: string };
  assert.equal(storedResult.indexState, 'stored');
  const ingestion = await backend.execute(storedResult.ingestionTaskId, new AbortController().signal);
  assert.equal(ingestion.outcome, 'succeeded', ingestion.error?.message);
  assert.equal((ingestion.result as { indexState: string }).indexState, 'ready');
});
