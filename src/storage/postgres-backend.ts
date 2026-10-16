import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { DomainError, type BusinessResult, type DocumentBackend, type DocumentPipeline, type DocumentRequest, type IndexedChunk, type Principal, type Scope, type StoredTask, type TaskState } from '../domain/types.js';
import { parseRequest } from '../domain/validation.js';
import { rrf, lexicalQuery } from '../retrieval/lexical.js';
import { fetchPublicHtml, type FetchedHtml } from '../ingestion/source-fetch.js';
import type { FaultHook } from '../observability/faults.js';
import { migrate } from './migrate.js';
import { listPostgresTaskPage, pruneExpiredCursorRows, type TaskPageInput } from './postgres-task-paging.js';

type Queryable = Pick<PoolClient, 'query'>;
type TaskRow = {
  id: string;
  tenant_id: string;
  principal_id: string;
  context_id: string;
  operation: DocumentRequest['operation'];
  request_id: string;
  payload_hash: string;
  request: DocumentRequest | string;
  kind: 'operation' | 'ingestion' | 'purge';
  parent_task_id: string | null;
  state: TaskState;
  result: BusinessResult | string | null;
  pi_task_id: string | number | null;
  pi_conversation_id: string | number | null;
  created_at: Date | string;
  updated_at: Date | string;
  principal_scopes?: Scope[];
};
type KnowledgeBaseRow = { id: string; name: string };
type DocumentRow = {
  id: string;
  title: string;
  tags: string[] | string;
  active_version: number;
  sha256: string;
  mime_type: string;
  byte_size: string | number;
  relative_path: string;
  active_generation_id?: string | null;
};
type CursorRow = {
  id: string;
  tenant_id: string;
  principal_id: string;
  resource_kind: 'documents' | 'knowledge_bases';
  knowledge_base_id: string | null;
  filter_hash: string;
  last_id: string;
  expires_at: Date | string;
  snapshot_at: Date | string;
};
type ContentPosition = { version: number; offset: number; filterHash: string };
type ContentCursorRow = { version: number; next_offset: number; filter_hash: string; expires_at: Date | string };
type ResolvedSource = {
  bytes: Buffer;
  mimeType: string;
  sourceType: 'text' | 'upload' | 'url';
  sourceUri?: string;
  fetchedAt?: string;
  sourceUploadId?: string;
};
type SaveOrUpdateRequest = Extract<DocumentRequest, { operation: 'document.save' | 'document.update' }>;
type IndexDocumentRef = {
  documentId: string;
  version: number;
  sha256: string;
  knowledgeBaseId: string;
  expectedVersion?: number;
  expectedRevision?: number;
};
type UrlSourceReceipt = { relativePath: string; sha256: string; mimeType: string; size: number; sourceUri: string; fetchedAt: string };
type RetryTarget = { documentId: string; version: number; sha256: string; knowledgeBaseId: string };

const allKbScopes: Scope[] = ['knowledge:read', 'knowledge:write', 'knowledge:delete'];
const knownScopes = new Set<Scope>(['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin']);
const listCursorLifetimeMs = 60 * 60 * 1000;
const uploadLifetimeMs = 60 * 60 * 1000;
const maxSourceBytes = 50 * 1024 * 1024;
const defaultContentPageSize = 100;
const indexedChunkInsertBatchSize = 1_000;
const maxActiveTasksGlobal = 128;
const maxActiveTasksPerTenant = 64;
const maxActiveTasksPerPrincipal = 32;
const maxActiveIngestionsPerPrincipal = 2;
const defaultPipelineTaskDurationMs = 15 * 60 * 1000;
const acceptedMimeTypes = new Set([
  'text/plain', 'text/markdown', 'text/x-markdown', 'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/html',
]);

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record).filter(key => record[key] !== undefined).sort();
  return `{${fields.map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function normalizeRequest(value: DocumentRequest): DocumentRequest {
  const request = JSON.parse(JSON.stringify(value)) as DocumentRequest;
  switch (request.operation) {
    case 'document.save':
      request.input.waitFor ??= 'indexed';
      request.input.tags ??= [];
      if (request.input.source.kind === 'text') request.input.source.mimeType ??= 'text/plain';
      break;
    case 'document.search':
      request.input.topK ??= 10;
      request.input.mode ??= 'hybrid';
      request.input.rerank ??= true;
      break;
    case 'document.list':
      request.input.limit ??= 20;
      request.input.filters ??= {};
      break;
    case 'document.get':
      request.input.limit ??= defaultContentPageSize;
      break;
    case 'knowledge_base.list':
      request.input.limit ??= 20;
      break;
    case 'document.answer':
      request.input.topK ??= 10;
      request.input.filters ??= {};
      break;
    case 'document.update':
      request.input.waitFor ??= 'indexed';
      if (request.input.source.kind === 'text') request.input.source.mimeType ??= 'text/plain';
      break;
  }
  return request;
}

function failure(request: DocumentRequest, code: string, message: string, retryable = false): BusinessResult {
  return {
    schemaVersion: '1.0', operation: request.operation, requestId: request.requestId,
    outcome: 'failed', error: { code, message, retryable },
  };
}

function retryNotAvailable(reason: string): DomainError {
  return new DomainError('RETRY_NOT_AVAILABLE', `This task cannot be retried: ${reason}`, 409);
}

function success(request: DocumentRequest, result: Record<string, unknown>): BusinessResult {
  return { schemaVersion: '1.0', operation: request.operation, requestId: request.requestId, outcome: 'succeeded', result };
}

function parseJson<T>(value: T | string): T {
  return (typeof value === 'string' ? JSON.parse(value) : value) as T;
}

function timeString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function pipelineTaskDeadline(task: Pick<TaskRow, 'created_at'>, durationMs: number): number {
  const createdAt = task.created_at instanceof Date ? task.created_at.getTime() : Date.parse(task.created_at);
  return createdAt + durationMs;
}

function pipelineTaskBudgetError(): DomainError {
  return new DomainError('TASK_TIME_BUDGET_EXCEEDED', 'The task exceeded its absolute execution time budget.', 408, true);
}

function assertPipelineTaskWithinBudget(task: Pick<TaskRow, 'created_at'>, durationMs: number): void {
  if (Date.now() >= pipelineTaskDeadline(task, durationMs)) throw pipelineTaskBudgetError();
}

function scopesFromDatabase(value: Scope[] | string): Scope[] {
  const scopes = typeof value === 'string' ? JSON.parse(value) as string[] : value;
  return scopes.filter((scope): scope is Scope => knownScopes.has(scope as Scope));
}

function normalizeSourceMime(mimeType: string): string {
  const normalized = mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!acceptedMimeTypes.has(normalized)) throw new DomainError('UNSUPPORTED_FORMAT', 'The source media type is not supported.');
  return normalized;
}

function validateSourceBytes(bytes: Buffer, mimeType: string, invalidCode = 'INVALID_UPLOAD'): void {
  if (bytes.byteLength === 0) throw new DomainError('EMPTY_DOCUMENT', 'The source document is empty.');
  if (bytes.byteLength > maxSourceBytes) throw new DomainError('SIZE_LIMIT', 'The source document exceeds 50 MiB.', 413);
  if (mimeType === 'application/pdf') {
    if (bytes.length < 5 || bytes.toString('ascii', 0, 5) !== '%PDF-') throw new DomainError(invalidCode, 'The PDF header does not match its declared media type.');
    return;
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) throw new DomainError(invalidCode, 'The DOCX ZIP signature does not match its declared media type.');
    return;
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('NUL_BYTE');
  } catch {
    throw new DomainError(invalidCode, 'The source bytes are not valid UTF-8 text for the declared media type.');
  }
}

function mapTask(row: TaskRow, scopes: Scope[]): StoredTask {
  return {
    id: row.id,
    contextId: row.context_id,
    principal: { tenantId: row.tenant_id, id: row.principal_id, scopes },
    request: parseJson(row.request),
    kind: row.kind,
    parentTaskId: row.parent_task_id,
    state: row.state,
    result: row.result === null ? null : parseJson(row.result),
    piTaskId: row.pi_task_id === null ? null : Number(row.pi_task_id),
    piConversationId: row.pi_conversation_id === null ? null : Number(row.pi_conversation_id),
    createdAt: timeString(row.created_at),
    updatedAt: timeString(row.updated_at),
  };
}

function requiredScope(request: DocumentRequest): Scope {
  switch (request.operation) {
    case 'knowledge_base.create': return 'knowledge:write';
    case 'knowledge_base.list': return 'knowledge:read';
    case 'document.delete': return 'knowledge:delete';
    case 'document.save':
    case 'document.update': return 'knowledge:write';
    case 'document.search':
    case 'document.get':
    case 'document.list':
    case 'document.answer': return 'knowledge:read';
  }
}

function requestedKnowledgeBaseId(request: DocumentRequest): string | undefined {
  return 'knowledgeBaseId' in request ? request.knowledgeBaseId : undefined;
}

function unsupportedReason(request: DocumentRequest, indexingEnabled = false): { code: string; message: string } | undefined {
  switch (request.operation) {
    case 'knowledge_base.create':
    case 'knowledge_base.list':
    case 'document.list':
      return undefined;
    case 'document.get':
      return undefined;
    case 'document.save':
      if (request.input.waitFor === 'indexed' && !indexingEnabled) {
        return { code: 'INDEXING_NOT_AVAILABLE', message: 'No document indexing pipeline is configured; waitFor=indexed is unavailable.' };
      }
      return undefined;
    case 'document.search':
      if (!indexingEnabled) return { code: 'INDEXING_NOT_AVAILABLE', message: 'No document indexing pipeline is configured.' };
      return undefined;
    case 'document.update':
      if (request.input.waitFor === 'indexed' && !indexingEnabled) {
        return { code: 'INDEXING_NOT_AVAILABLE', message: 'No document indexing pipeline is configured; waitFor=indexed is unavailable.' };
      }
      return undefined;
    case 'document.delete':
      return undefined;
    default:
      return { code: 'OPERATION_NOT_IMPLEMENTED', message: `${request.operation} is not implemented by this M1 backend.` };
  }
}

async function inTransaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await body(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function activePrincipal(client: Queryable, tenantId: string, principalId: string): Promise<Principal> {
  const result = await client.query<{ scopes: Scope[] | string; revoked_at: Date | null }>(
    `SELECT scopes, revoked_at FROM pd_principals WHERE tenant_id = $1 AND principal_id = $2`,
    [tenantId, principalId],
  );
  const row = result.rows[0];
  if (!row || row.revoked_at) throw new DomainError('UNAUTHENTICATED', 'The principal is not active.', 401);
  return { tenantId, id: principalId, scopes: scopesFromDatabase(row.scopes) };
}

function hasGlobalScope(principal: Principal, scope: Scope): boolean {
  return principal.scopes.includes('knowledge:admin') || principal.scopes.includes(scope);
}

async function ensureGlobalScope(principal: Principal, scope: Scope): Promise<void> {
  if (!hasGlobalScope(principal, scope)) throw new DomainError('FORBIDDEN', 'The principal lacks the required scope.', 403);
}

async function acquireTaskAdmissionLocks(client: Queryable, principal: Principal): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext('pi-document-admission-global'), 0)`);
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('pi-document-admission-tenant'), hashtext($1))`, [principal.tenantId],
  );
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('pi-document-admission-principal'), hashtext($1))`,
    [`${principal.tenantId}:${principal.id}`],
  );
}

async function countActiveTasks(client: Queryable, principal: Principal): Promise<{ global: number; tenant: number; principal: number }> {
  const counts = await client.query<{ global_count: number; tenant_count: number; principal_count: number }>(
    `SELECT count(*)::int AS global_count,
            count(*) FILTER (WHERE tenant_id = $1)::int AS tenant_count,
            count(*) FILTER (WHERE tenant_id = $1 AND principal_id = $2)::int AS principal_count
     FROM pd_tasks WHERE state IN ('submitted', 'working')`,
    [principal.tenantId, principal.id],
  );
  const row = counts.rows[0];
  return { global: Number(row?.global_count ?? 0), tenant: Number(row?.tenant_count ?? 0), principal: Number(row?.principal_count ?? 0) };
}

async function ensureKnowledgeBaseAccess(client: Queryable, principal: Principal, knowledgeBaseId: string, scope: Scope): Promise<void> {
  const kb = await client.query(
    `SELECT 1 FROM pd_knowledge_bases WHERE tenant_id = $1 AND id = $2`,
    [principal.tenantId, knowledgeBaseId],
  );
  if (kb.rowCount === 0) throw new DomainError('KNOWLEDGE_BASE_NOT_FOUND', 'Knowledge base is not available.', 404);
  if (principal.scopes.includes('knowledge:admin')) return;
  if (!principal.scopes.includes(scope)) throw new DomainError('KNOWLEDGE_BASE_NOT_FOUND', 'Knowledge base is not available.', 404);
  const membership = await client.query<{ scopes: Scope[] | string }>(
    `SELECT scopes FROM pd_knowledge_base_members WHERE tenant_id = $1 AND knowledge_base_id = $2 AND principal_id = $3`,
    [principal.tenantId, knowledgeBaseId, principal.id],
  );
  if (!membership.rows[0] || !scopesFromDatabase(membership.rows[0].scopes).includes(scope)) {
    throw new DomainError('KNOWLEDGE_BASE_NOT_FOUND', 'Knowledge base is not available.', 404);
  }
}

async function assertContextOwner(client: Queryable, tenantId: string, contextId: string, principalId: string): Promise<void> {
  const result = await client.query<{ principal_id: string }>(
    `SELECT principal_id FROM pd_contexts WHERE tenant_id = $1 AND context_id = $2`,
    [tenantId, contextId],
  );
  if (result.rows[0] && result.rows[0].principal_id !== principalId) {
    throw new DomainError('CONTEXT_OWNER_MISMATCH', 'The context belongs to another principal.', 404);
  }
}

async function createContext(client: Queryable, tenantId: string, contextId: string, principalId: string): Promise<void> {
  await assertContextOwner(client, tenantId, contextId, principalId);
  await client.query(
    `INSERT INTO pd_contexts (tenant_id, context_id, principal_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, context_id) DO NOTHING`,
    [tenantId, contextId, principalId],
  );
  await assertContextOwner(client, tenantId, contextId, principalId);
}

async function assertTaskResourcesAccessible(client: Queryable, taskId: string, principal: Principal, scope: Scope): Promise<void> {
  const resources = await client.query<{ knowledge_base_id: string }>(
    `SELECT knowledge_base_id FROM pd_task_resources WHERE tenant_id = $1 AND task_id = $2 ORDER BY knowledge_base_id`,
    [principal.tenantId, taskId],
  );
  for (const resource of resources.rows) {
    await ensureKnowledgeBaseAccess(client, principal, resource.knowledge_base_id, scope);
  }
  const documents = await client.query<{ id: string; knowledge_base_id: string; deleted_at: Date | string | null }>(
    `SELECT d.id, d.knowledge_base_id, d.deleted_at
     FROM pd_task_document_resources r
     JOIN pd_documents d ON d.tenant_id = r.tenant_id AND d.id = r.document_id
     WHERE r.tenant_id = $1 AND r.task_id = $2 ORDER BY d.id`,
    [principal.tenantId, taskId],
  );
  for (const document of documents.rows) {
    if (document.deleted_at) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document is not available.', 404);
    await ensureKnowledgeBaseAccess(client, principal, document.knowledge_base_id, scope);
  }
}

function makeCursorFilterHash(value: unknown): string {
  return sha256(canonicalJson(value));
}

function serializeTask(row: TaskRow, principal: Principal): StoredTask {
  return mapTask(row, principal.scopes);
}

function classifyUnsupported(request: DocumentRequest, indexingEnabled: boolean): { code: string; message: string } | undefined {
  return unsupportedReason(request, indexingEnabled);
}

export type ProvisionPrincipalInput = { tenantId: string; id: string; scopes: Scope[]; token: string };

export class PostgresDocumentBackend implements DocumentBackend {
  readonly pool: Pool;
  readonly blobRoot: string;
  readonly publicBaseUrl: string;
  readonly pipeline?: DocumentPipeline;
  readonly indexingEnabled: boolean;
  readonly fault?: FaultHook;
  readonly pipelineTaskDurationMs: number;

  constructor(options: {
    pool: Pool; blobRoot: string; publicBaseUrl: string; pipeline?: DocumentPipeline; fault?: FaultHook; pipelineTaskDurationMs?: number;
  }) {
    this.pool = options.pool;
    this.blobRoot = resolve(options.blobRoot);
    this.pipeline = options.pipeline;
    this.indexingEnabled = Boolean(options.pipeline);
    this.fault = options.fault;
    this.pipelineTaskDurationMs = options.pipelineTaskDurationMs ?? defaultPipelineTaskDurationMs;
    if (!Number.isSafeInteger(this.pipelineTaskDurationMs) || this.pipelineTaskDurationMs < 1 ||
      this.pipelineTaskDurationMs > defaultPipelineTaskDurationMs) {
      throw new DomainError('TASK_DURATION_INVALID', `pipelineTaskDurationMs must be an integer from 1 through ${defaultPipelineTaskDurationMs}.`);
    }
    if (options.pipeline && (!Number.isSafeInteger(options.pipeline.profile.dimensions) || options.pipeline.profile.dimensions < 1 || options.pipeline.profile.dimensions > 2000)) {
      throw new DomainError('EMBEDDING_DIMENSION_INVALID', 'The indexing pipeline dimensions must be an integer from 1 through 2000.');
    }
    const publicBase = new URL(options.publicBaseUrl);
    if (!['http:', 'https:'].includes(publicBase.protocol) || publicBase.username || publicBase.password) {
      throw new Error('PUBLIC_BASE_URL_INVALID');
    }
    this.publicBaseUrl = publicBase.toString().replace(/\/$/, '');
  }

  private async injectFault(point: string): Promise<void> {
    await this.fault?.(point);
  }

  static migrate(pool: Pool): Promise<void> {
    return migrate(pool);
  }

  async provisionPrincipal(input: ProvisionPrincipalInput): Promise<void> {
    if (!input.tenantId.trim() || !input.id.trim() || !input.token) throw new DomainError('PRINCIPAL_INVALID', 'tenantId, id, and token are required.');
    if (input.scopes.some(scope => !knownScopes.has(scope))) throw new DomainError('PRINCIPAL_SCOPE_INVALID', 'The principal contains an unsupported scope.');
    const tokenHash = Buffer.from(sha256(input.token), 'hex');
    await this.pool.query(
      `INSERT INTO pd_principals (tenant_id, principal_id, scopes, token_hash, revoked_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, now())
       ON CONFLICT (tenant_id, principal_id) DO UPDATE
       SET scopes = EXCLUDED.scopes, token_hash = EXCLUDED.token_hash, revoked_at = NULL, updated_at = now()`,
      [input.tenantId, input.id, input.scopes, tokenHash],
    );
  }

  async grantKnowledgeBase(principal: Principal, knowledgeBaseId: string, scopes: Scope[] = allKbScopes): Promise<void> {
    const grants = [...new Set(scopes.filter(scope => scope !== 'knowledge:admin'))];
    if (grants.some(scope => !knownScopes.has(scope))) throw new DomainError('PRINCIPAL_SCOPE_INVALID', 'The KB grant contains an unsupported scope.');
    await inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      const kb = await client.query(`SELECT 1 FROM pd_knowledge_bases WHERE tenant_id = $1 AND id = $2`, [current.tenantId, knowledgeBaseId]);
      if (kb.rowCount === 0) throw new DomainError('KNOWLEDGE_BASE_NOT_FOUND', 'Knowledge base is not available.', 404);
      await client.query(
        `INSERT INTO pd_knowledge_base_members (tenant_id, knowledge_base_id, principal_id, scopes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, knowledge_base_id, principal_id) DO UPDATE SET scopes = EXCLUDED.scopes`,
        [current.tenantId, knowledgeBaseId, current.id, grants],
      );
    });
  }

  async revokeKnowledgeBase(principal: Principal, knowledgeBaseId: string): Promise<void> {
    await inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      await client.query(
        `DELETE FROM pd_knowledge_base_members WHERE tenant_id = $1 AND knowledge_base_id = $2 AND principal_id = $3`,
        [current.tenantId, knowledgeBaseId, current.id],
      );
    });
  }

  async createUpload(
    principal: Principal, knowledgeBaseId: string, input: Buffer, mimeType: string,
  ): Promise<{ uploadId: string; sha256: string; size: number; mime: string; expiresAt: string }> {
    if (!Buffer.isBuffer(input)) throw new DomainError('INVALID_UPLOAD', 'Upload bytes must be a binary buffer.');
    const authorized = await inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      await ensureGlobalScope(current, 'knowledge:write');
      await ensureKnowledgeBaseAccess(client, current, knowledgeBaseId, 'knowledge:write');
      return current;
    });
    const mime = normalizeSourceMime(mimeType);
    validateSourceBytes(input, mime);
    const digest = sha256(input);
    const relativePath = await this.writeBlob(principal.tenantId, digest, input);
    const uploadId = randomUUID();
    const expiresAt = new Date(Date.now() + uploadLifetimeMs);
    return inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      await ensureGlobalScope(current, 'knowledge:write');
      await ensureKnowledgeBaseAccess(client, current, knowledgeBaseId, 'knowledge:write');
      await client.query(
        `INSERT INTO pd_blobs (tenant_id, sha256, relative_path, mime_type, byte_size)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, sha256) DO NOTHING`,
        [authorized.tenantId, digest, relativePath, mime, input.byteLength],
      );
      const blob = await client.query<{ relative_path: string; mime_type: string; byte_size: string | number }>(
        `SELECT relative_path, mime_type, byte_size FROM pd_blobs WHERE tenant_id = $1 AND sha256 = $2 FOR UPDATE`,
        [current.tenantId, digest],
      );
      const blobRow = blob.rows[0];
      if (!blobRow || blobRow.relative_path !== relativePath || blobRow.mime_type !== mime || Number(blobRow.byte_size) !== input.byteLength) {
        throw new DomainError('BLOB_METADATA_CONFLICT', 'Content-addressed upload metadata does not match.', 500);
      }
      await client.query(
        `INSERT INTO pd_uploads (tenant_id, upload_id, principal_id, knowledge_base_id, sha256, mime_type, byte_size, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [current.tenantId, uploadId, current.id, knowledgeBaseId, digest, mime, input.byteLength, expiresAt],
      );
      return { uploadId, sha256: digest, size: input.byteLength, mime, expiresAt: expiresAt.toISOString() };
    });
  }

  async authenticate(token: string): Promise<Principal | undefined> {
    if (!token) return undefined;
    const tokenHash = Buffer.from(sha256(token), 'hex');
    const result = await this.pool.query<{ tenant_id: string; principal_id: string; scopes: Scope[] | string }>(
      `SELECT tenant_id, principal_id, scopes FROM pd_principals WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
    const row = result.rows[0];
    return row ? { tenantId: row.tenant_id, id: row.principal_id, scopes: scopesFromDatabase(row.scopes) } : undefined;
  }

  async admit(principal: Principal, input: DocumentRequest, contextId?: string): Promise<StoredTask> {
    const request = normalizeRequest(parseRequest(input));
    const payloadHash = sha256(canonicalJson(request));
    const requestedContextId = contextId?.trim() || undefined;

    return inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      if (requestedContextId) await assertContextOwner(client, current.tenantId, requestedContextId, current.id);
      await ensureGlobalScope(current, requiredScope(request));
      const knowledgeBaseId = requestedKnowledgeBaseId(request);
      if (knowledgeBaseId) await ensureKnowledgeBaseAccess(client, current, knowledgeBaseId, requiredScope(request));

      const replayExisting = async (): Promise<StoredTask | undefined> => {
        const existing = await client.query<TaskRow>(
          `SELECT * FROM pd_tasks WHERE tenant_id = $1 AND principal_id = $2 AND operation = $3 AND request_id = $4 AND kind = 'operation' FOR UPDATE`,
          [current.tenantId, current.id, request.operation, request.requestId],
        );
        const row = existing.rows[0];
        if (!row) return undefined;
        if (row.payload_hash !== payloadHash) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'requestId was already used with a different business payload.', 409);
        }
        await assertTaskResourcesAccessible(client, row.id, current, 'knowledge:read');
        return serializeTask(row, current);
      };
      const replay = await replayExisting();
      if (replay) return replay;

      let failureReason = classifyUnsupported(request, this.indexingEnabled);
      let updateDocument: { id: string; revision: string | number; active_version: number } | undefined;
      if (!failureReason && request.operation === 'document.update') {
        const selectedDocument = await client.query<{ id: string; revision: string | number; active_version: number }>(
          `SELECT id, revision, active_version FROM pd_documents
           WHERE tenant_id = $1 AND id = $2 AND knowledge_base_id = $3 AND deleted_at IS NULL FOR UPDATE`,
          [current.tenantId, request.input.documentId, request.knowledgeBaseId],
        );
        updateDocument = selectedDocument.rows[0];
        if (!updateDocument) {
          failureReason = { code: 'DOCUMENT_NOT_FOUND', message: 'Document is not available.' };
        } else if (updateDocument.active_version !== request.input.expectedVersion) {
          failureReason = { code: 'VERSION_CONFLICT', message: 'The expected document version is no longer active.' };
        } else {
          const reservation = await client.query(
            `SELECT 1 FROM pd_document_update_reservations
             WHERE tenant_id = $1 AND document_id = $2 AND expected_version = $3`,
            [current.tenantId, updateDocument.id, request.input.expectedVersion],
          );
          if (reservation.rowCount) failureReason = { code: 'VERSION_CONFLICT', message: 'An update for this document version is already in progress.' };
        }
      }
      if (!failureReason && (request.operation === 'document.save' || request.operation === 'document.update')) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtext('pi-document-active-ingestions'), hashtext($1))`,
          [`${current.tenantId}:${current.id}`],
        );
        const active = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pd_tasks
           WHERE tenant_id = $1 AND principal_id = $2 AND operation IN ('document.save', 'document.update')
             AND kind IN ('operation', 'ingestion') AND state IN ('submitted', 'working')`,
          [current.tenantId, current.id],
        );
        if (Number(active.rows[0]?.count ?? 0) >= 2) {
          throw new DomainError('LIMIT_EXCEEDED', `This principal already has ${maxActiveIngestionsPerPrincipal} active document ingestion tasks; retry after one completes.`, 429, true);
        }
      }
      if (!failureReason) {
        await acquireTaskAdmissionLocks(client, current);
        const racedReplay = await replayExisting();
        if (racedReplay) return racedReplay;
        const active = await countActiveTasks(client, current);
        if (active.principal >= maxActiveTasksPerPrincipal) {
          throw new DomainError('TASK_CAPACITY_EXCEEDED', `The principal active task limit (${maxActiveTasksPerPrincipal}) has been reached; retry after a task completes.`, 429, true);
        }
        if (active.tenant >= maxActiveTasksPerTenant) {
          throw new DomainError('TASK_CAPACITY_EXCEEDED', `The tenant active task limit (${maxActiveTasksPerTenant}) has been reached; retry after a task completes.`, 429, true);
        }
        if (active.global >= maxActiveTasksGlobal) {
          throw new DomainError('TASK_CAPACITY_EXCEEDED', `The service active task limit (${maxActiveTasksGlobal}) has been reached; retry after a task completes.`, 429, true);
        }
      }
      const taskId = randomUUID();
      const context = requestedContextId ?? randomUUID();
      await createContext(client, current.tenantId, context, current.id);
      const state: TaskState = failureReason ? 'failed' : 'submitted';
      const result = failureReason ? failure(request, failureReason.code, failureReason.message) : null;
      const inserted = await client.query<TaskRow>(
        `INSERT INTO pd_tasks
          (id, tenant_id, principal_id, context_id, operation, request_id, payload_hash, request, kind, state, result)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'operation', $9, $10)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [taskId, current.tenantId, current.id, context, request.operation, request.requestId, payloadHash,
          request, state, result],
      );
      if (!inserted.rows[0]) {
        const raced = await client.query<TaskRow>(
          `SELECT * FROM pd_tasks WHERE tenant_id = $1 AND principal_id = $2 AND operation = $3 AND request_id = $4 AND kind = 'operation' FOR UPDATE`,
          [current.tenantId, current.id, request.operation, request.requestId],
        );
        if (!raced.rows[0]) throw new Error('TASK_INSERT_CONFLICT_WITHOUT_IDEMPOTENCY_ROW');
        if (raced.rows[0].payload_hash !== payloadHash) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 'requestId was already used with a different business payload.', 409);
        }
        await assertTaskResourcesAccessible(client, raced.rows[0].id, current, 'knowledge:read');
        return serializeTask(raced.rows[0], current);
      }

      if (knowledgeBaseId) {
        await client.query(
          `INSERT INTO pd_task_resources (tenant_id, task_id, knowledge_base_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [current.tenantId, taskId, knowledgeBaseId],
        );
      }
      if (request.operation === 'document.update' && updateDocument) {
        await client.query(
          `INSERT INTO pd_task_document_resources (tenant_id, task_id, document_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [current.tenantId, taskId, updateDocument.id],
        );
        if (!failureReason) {
          const reservation = await client.query(
            `INSERT INTO pd_document_update_reservations
              (tenant_id, document_id, expected_version, target_version, expected_revision, reserved_task_id)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING RETURNING document_id`,
            [current.tenantId, updateDocument.id, request.input.expectedVersion, request.input.expectedVersion + 1,
              updateDocument.revision, taskId],
          );
          if (!reservation.rows[0]) {
            const conflict = failure(request, 'VERSION_CONFLICT', 'An update for this document version is already in progress.');
            await client.query(`UPDATE pd_tasks SET state = 'failed', result = $2 WHERE tenant_id = $1 AND id = $3`,
              [current.tenantId, conflict, taskId]);
            await client.query(`UPDATE pd_outbox SET delivered_at = COALESCE(delivered_at, now()) WHERE task_id = $1 AND event_type = 'dispatch'`, [taskId]);
            return mapTask({ ...inserted.rows[0]!, state: 'failed', result: conflict }, current.scopes);
          }
        }
      }
      await client.query(
        `INSERT INTO pd_outbox (event_id, tenant_id, task_id, event_type, payload, delivered_at)
         VALUES ($1, $2, $3, 'dispatch', $4, CASE WHEN $5 THEN now() ELSE NULL END)`,
        [randomUUID(), current.tenantId, taskId, { taskId }, Boolean(failureReason)],
      );
      return serializeTask(inserted.rows[0], current);
    });
  }

  async retryFailedTask(principal: Principal, originalTaskId: string, requestId: string): Promise<StoredTask> {
    if (!requestId || requestId.length > 128) throw new DomainError('REQUEST_ID_INVALID', 'requestId must contain 1 to 128 characters.');

    return inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      await ensureGlobalScope(current, 'knowledge:write');

      const findRetry = async (): Promise<StoredTask | undefined> => {
        const existing = await client.query<TaskRow>(
          `SELECT t.* FROM pd_task_retries r
           JOIN pd_tasks t ON t.tenant_id = r.tenant_id AND t.id = r.retry_task_id
           WHERE r.tenant_id = $1 AND r.principal_id = $2 AND r.source_task_id = $3 AND r.request_id = $4
           FOR UPDATE OF t`,
          [current.tenantId, current.id, originalTaskId, requestId],
        );
        const row = existing.rows[0];
        if (!row) return undefined;
        try {
          await assertTaskResourcesAccessible(client, row.id, current, 'knowledge:write');
        } catch (error) {
          if (error instanceof DomainError) throw retryNotAvailable('the source document or current write permission is no longer available');
          throw error;
        }
        return serializeTask(row, current);
      };

      const replay = await findRetry();
      if (replay) return replay;

      const selected = await client.query<TaskRow>(
        `SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
        [current.tenantId, originalTaskId],
      );
      const original = selected.rows[0];
      if (!original || original.principal_id !== current.id) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
      const replayAfterOriginalLock = await findRetry();
      if (replayAfterOriginalLock) return replayAfterOriginalLock;
      if (original.state !== 'failed') throw retryNotAvailable('only failed tasks can be retried');
      const originalResult = original.result ? parseJson(original.result) : null;
      if (!originalResult || originalResult.outcome !== 'failed' || originalResult.error?.retryable !== true) {
        throw retryNotAvailable('the failure is not marked retryable');
      }

      const originalRequest = parseJson(original.request);
      if (originalRequest.operation !== 'document.save' || original.kind === 'purge') {
        throw retryNotAvailable('only a failed document.save or its indexing task can be retried');
      }
      if (!this.pipeline) throw retryNotAvailable('document indexing is not configured');
      const knowledgeBaseId = originalRequest.knowledgeBaseId;
      try {
        await ensureKnowledgeBaseAccess(client, current, knowledgeBaseId, 'knowledge:write');
      } catch (error) {
        if (error instanceof DomainError) throw retryNotAvailable('write access to the source knowledge base is no longer available');
        throw error;
      }

      let target: RetryTarget | undefined;
      const inherited = await client.query<{
        document_id: string; version: number; source_sha256: string; retry_task_id: string;
      }>(
        `SELECT document_id, version, source_sha256, retry_task_id
         FROM pd_task_retries WHERE tenant_id = $1 AND retry_task_id = $2`,
        [current.tenantId, original.id],
      );
      if (inherited.rows[0]) {
        target = {
          documentId: inherited.rows[0].document_id,
          version: Number(inherited.rows[0].version),
          sha256: inherited.rows[0].source_sha256,
          knowledgeBaseId: '',
        };
      } else if (original.kind === 'operation') {
        const saved = await client.query<{ id: string; knowledge_base_id: string; sha256: string }>(
          `SELECT d.id, d.knowledge_base_id, v.sha256
           FROM pd_documents d JOIN pd_document_versions v
             ON v.tenant_id = d.tenant_id AND v.document_id = d.id AND v.version = 1
           WHERE d.tenant_id = $1 AND d.created_by_task_id = $2
           FOR UPDATE OF d`,
          [current.tenantId, original.id],
        );
        const row = saved.rows[0];
        if (row) target = { documentId: row.id, version: 1, sha256: row.sha256, knowledgeBaseId: row.knowledge_base_id };
      } else if (original.kind === 'ingestion' && original.parent_task_id) {
        const parent = await client.query<TaskRow>(
          `SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2`,
          [current.tenantId, original.parent_task_id],
        );
        const parentTask = parent.rows[0];
        const parentResult = parentTask?.result ? parseJson(parentTask.result) : null;
        const saved = parentResult?.result;
        if (parentTask?.kind === 'operation' && parentTask.operation === 'document.save' && parentResult?.outcome === 'succeeded' &&
          saved && typeof saved.documentId === 'string' && Number.isSafeInteger(Number(saved.version)) &&
          typeof saved.sha256 === 'string' && typeof saved.knowledgeBaseId === 'string') {
          target = {
            documentId: saved.documentId,
            version: Number(saved.version),
            sha256: saved.sha256,
            knowledgeBaseId: saved.knowledgeBaseId,
          };
        }
      }
      if (!target) throw retryNotAvailable('the saved source was never committed');
      if (target.knowledgeBaseId && target.knowledgeBaseId !== knowledgeBaseId) {
        throw retryNotAvailable('the saved source belongs to a different knowledge base');
      }

      const source = await client.query<{
        id: string; knowledge_base_id: string; active_version: number; deleted_at: Date | string | null;
        sha256: string; mime_type: string; byte_size: string | number; relative_path: string;
        blob_mime_type: string; blob_byte_size: string | number;
      }>(
        `SELECT d.id, d.knowledge_base_id, d.active_version, d.deleted_at,
                v.sha256, v.mime_type, v.byte_size, b.relative_path,
                b.mime_type AS blob_mime_type, b.byte_size AS blob_byte_size
         FROM pd_documents d
         JOIN pd_document_versions v ON v.tenant_id = d.tenant_id AND v.document_id = d.id AND v.version = $3
         JOIN pd_blobs b ON b.tenant_id = v.tenant_id AND b.sha256 = v.sha256
         WHERE d.tenant_id = $1 AND d.id = $2
         FOR UPDATE OF d`,
        [current.tenantId, target.documentId, target.version],
      );
      const sourceRow = source.rows[0];
      if (!sourceRow || sourceRow.deleted_at || sourceRow.active_version !== target.version ||
        sourceRow.sha256 !== target.sha256 || sourceRow.knowledge_base_id !== knowledgeBaseId) {
        throw retryNotAvailable('the saved source was deleted or its active version changed');
      }
      const reservation = await client.query(
        `SELECT 1 FROM pd_document_update_reservations
         WHERE tenant_id = $1 AND document_id = $2 AND expected_version = $3 FOR UPDATE`,
        [current.tenantId, target.documentId, target.version],
      );
      if (reservation.rowCount) throw retryNotAvailable('a document update is already in progress');
      if (sourceRow.mime_type !== sourceRow.blob_mime_type || Number(sourceRow.byte_size) !== Number(sourceRow.blob_byte_size)) {
        throw retryNotAvailable('the saved source metadata failed its integrity check');
      }
      let sourceBytes: Buffer;
      try {
        sourceBytes = await readFile(this.resolveBlobPath(sourceRow.relative_path));
      } catch {
        throw retryNotAvailable('the saved source bytes are no longer available');
      }
      if (sourceBytes.byteLength !== Number(sourceRow.byte_size) || sha256(sourceBytes) !== target.sha256) {
        throw retryNotAvailable('the saved source bytes failed their integrity check');
      }

      await acquireTaskAdmissionLocks(client, current);
      const activeRetry = await client.query(
        `SELECT 1 FROM pd_task_retries r JOIN pd_tasks t ON t.tenant_id = r.tenant_id AND t.id = r.retry_task_id
         WHERE r.tenant_id = $1 AND r.document_id = $2 AND r.version = $3 AND t.state IN ('submitted', 'working')
         LIMIT 1`,
        [current.tenantId, target.documentId, target.version],
      );
      if (activeRetry.rowCount) throw retryNotAvailable('another indexing retry for this source version is still active');

      const profile = this.pipeline.profile;
      const readyGeneration = await client.query(
        `SELECT 1 FROM pd_documents d
         JOIN pd_index_generations g ON g.tenant_id = d.tenant_id AND g.document_id = d.id
           AND g.version = d.active_version AND g.generation_id = d.active_generation_id
         WHERE d.tenant_id = $1 AND d.id = $2 AND d.active_version = $3 AND d.deleted_at IS NULL
           AND g.state = 'ready' AND g.profile_id = $4 AND g.profile_version = $5 AND g.dimensions = $6
         LIMIT 1`,
        [current.tenantId, target.documentId, target.version, profile.id, profile.version, profile.dimensions],
      );
      if (readyGeneration.rowCount) throw retryNotAvailable('this source version already has a ready index');

      const activeIngestions = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM pd_tasks
         WHERE tenant_id = $1 AND principal_id = $2 AND operation IN ('document.save', 'document.update')
           AND kind IN ('operation', 'ingestion') AND state IN ('submitted', 'working')`,
        [current.tenantId, current.id],
      );
      if (Number(activeIngestions.rows[0]?.count ?? 0) >= maxActiveIngestionsPerPrincipal) {
        throw new DomainError('LIMIT_EXCEEDED', `This principal already has ${maxActiveIngestionsPerPrincipal} active document ingestion tasks; retry after one completes.`, 429, true);
      }
      const active = await countActiveTasks(client, current);
      if (active.principal >= maxActiveTasksPerPrincipal || active.tenant >= maxActiveTasksPerTenant || active.global >= maxActiveTasksGlobal) {
        throw new DomainError('TASK_CAPACITY_EXCEEDED', 'The active task capacity has been reached; retry after a task completes.', 429, true);
      }

      const request = structuredClone(originalRequest);
      request.requestId = requestId;
      const taskId = randomUUID();
      const payloadHash = sha256(canonicalJson(request));
      await createContext(client, current.tenantId, original.context_id, current.id);
      const inserted = await client.query<TaskRow>(
        `INSERT INTO pd_tasks
          (id, tenant_id, principal_id, context_id, operation, request_id, payload_hash, request, kind, parent_task_id, state)
         VALUES ($1, $2, $3, $4, 'document.save', $5, $6, $7, 'ingestion', $8, 'submitted') RETURNING *`,
        [taskId, current.tenantId, current.id, original.context_id, requestId, payloadHash, request, original.id],
      );
      const retryTask = inserted.rows[0];
      if (!retryTask) throw new Error('RETRY_TASK_INSERT_FAILED');
      await client.query(
        `INSERT INTO pd_task_retries
          (tenant_id, principal_id, source_task_id, request_id, retry_task_id, document_id, version, source_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [current.tenantId, current.id, original.id, requestId, taskId, target.documentId, target.version, target.sha256],
      );
      await this.addTaskResource(client, retryTask, knowledgeBaseId);
      await this.addTaskDocumentResource(client, retryTask, target.documentId);
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         SELECT tenant_id, $3, stage, input_hash, result FROM pd_processing_receipts
         WHERE tenant_id = $1 AND task_id = $2 AND stage IN ('parse', 'embedding')
         ON CONFLICT DO NOTHING`,
        [current.tenantId, original.id, taskId],
      );
      await client.query(
        `INSERT INTO pd_outbox (event_id, tenant_id, task_id, event_type, payload)
         VALUES ($1, $2, $3, 'dispatch', $4)`,
        [randomUUID(), current.tenantId, taskId, { taskId, parentTaskId: original.id, retryOfTaskId: original.id }],
      );
      return serializeTask(retryTask, current);
    });
  }

  async getTask(principal: Principal, id: string): Promise<StoredTask> {
    return inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      const result = await client.query<TaskRow>(
        `SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2`, [current.tenantId, id],
      );
      const row = result.rows[0];
      if (!row || row.principal_id !== current.id) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
      await assertTaskResourcesAccessible(client, row.id, current, 'knowledge:read');
      return serializeTask(row, current);
    });
  }

  async listTaskPage(principal: Principal, input: TaskPageInput): Promise<{ taskIds: string[]; nextCursor?: string; totalSize: number }> {
    return inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      await ensureGlobalScope(current, 'knowledge:read');
      return listPostgresTaskPage(client, current, input);
    });
  }

  async listTasks(principal: Principal, contextId?: string): Promise<StoredTask[]> {
    return inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      const context = contextId?.trim();
      if (context) {
        const contextRow = await client.query<{ principal_id: string }>(
          `SELECT principal_id FROM pd_contexts WHERE tenant_id = $1 AND context_id = $2`,
          [current.tenantId, context],
        );
        if (contextRow.rows[0] && contextRow.rows[0].principal_id !== current.id) return [];
      }
      const rows = await client.query<TaskRow>(
        `SELECT * FROM pd_tasks WHERE tenant_id = $1 AND principal_id = $2 AND ($3::text IS NULL OR context_id = $3)
         ORDER BY created_at DESC, id DESC`,
        [current.tenantId, current.id, context ?? null],
      );
      const visible: StoredTask[] = [];
      for (const row of rows.rows) {
        try {
          await assertTaskResourcesAccessible(client, row.id, current, 'knowledge:read');
          visible.push(serializeTask(row, current));
        } catch (error) {
          if (!(error instanceof DomainError) || !['KNOWLEDGE_BASE_NOT_FOUND', 'DOCUMENT_NOT_FOUND'].includes(error.code)) throw error;
        }
      }
      return visible;
    });
  }

  async pendingTasks(): Promise<StoredTask[]> {
    const naturalSchema = await this.pool.query<{ available: boolean }>(
      `SELECT to_regclass('pd_agent_tasks') IS NOT NULL AND to_regclass('pd_agent_actions') IS NOT NULL AS available`,
    );
    const actionAdmissionBarrier = naturalSchema.rows[0]?.available
      ? `AND NOT EXISTS (
           SELECT 1 FROM pd_agent_actions a
           WHERE t.kind = 'operation'
             AND a.tenant_id = t.tenant_id AND a.principal_id = t.principal_id
             AND a.request_id = t.request_id AND a.operation = t.operation
         )`
      : '';
    const rows = await this.pool.query<TaskRow>(
      `SELECT t.*, p.scopes AS principal_scopes
       FROM pd_tasks t
       JOIN pd_principals p ON p.tenant_id = t.tenant_id AND p.principal_id = t.principal_id
       WHERE t.state IN ('submitted', 'working')
         ${actionAdmissionBarrier}
       ORDER BY t.updated_at, t.created_at, t.id
       LIMIT 100`,
    );
    return rows.rows.map(row => mapTask(row, scopesFromDatabase(row.principal_scopes ?? [])));
  }

  async bindTask(id: string, piTaskId: number, piConversationId: number): Promise<void> {
    await inTransaction(this.pool, async client => {
      const result = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1 FOR UPDATE`, [id]);
      const task = result.rows[0];
      if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
      if (task.pi_task_id !== null && Number(task.pi_task_id) !== piTaskId) {
        throw new DomainError('PI_TASK_BINDING_CONFLICT', 'Task is already bound to a different Pi task.', 409);
      }
      if (task.pi_conversation_id !== null && Number(task.pi_conversation_id) !== piConversationId) {
        throw new DomainError('PI_CONTEXT_BINDING_CONFLICT', 'Task is already bound to a different Pi conversation.', 409);
      }
      await client.query(
        `UPDATE pd_tasks SET pi_task_id = $2, pi_conversation_id = $3, updated_at = now() WHERE id = $1`,
        [id, piTaskId, piConversationId],
      );
      await client.query(
        `UPDATE pd_outbox SET delivered_at = COALESCE(delivered_at, now()) WHERE task_id = $1 AND event_type = 'dispatch'`,
        [id],
      );
    });
  }

  async execute(id: string, signal: AbortSignal, checkpoint?: (step: string) => Promise<void>): Promise<BusinessResult> {
    const selected = await this.pool.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1`, [id]);
    const task = selected.rows[0];
    if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
    const request = parseJson(task.request);
    if (task.kind === 'purge') return this.executePurgeTask(id, signal);
    if (request.operation === 'document.delete') return this.executeDeleteTask(id, signal);
    if (((request.operation === 'document.save' || request.operation === 'document.update') && request.input.source.kind === 'url') ||
      (this.pipeline && (task.kind === 'ingestion' ||
        ((request.operation === 'document.save' || request.operation === 'document.update') && request.input.waitFor === 'indexed') || request.operation === 'document.search'))) {
      return this.executePipelineTask(id, signal, checkpoint);
    }
    if (this.pipeline && request.operation === 'document.get') return this.executePipelineTask(id, signal, checkpoint);
    return this.executeLegacy(id, signal);
  }

  private async executeLegacy(id: string, signal: AbortSignal): Promise<BusinessResult> {
    return inTransaction(this.pool, async client => {
      const identity = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1`, [id]);
      const initialTask = identity.rows[0];
      if (!initialTask) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
      let task: TaskRow = initialTask;
      const request = parseJson(task.request);
      const receiptHash = task.payload_hash;
      if (isTerminal(task.state)) {
        return task.result
          ? parseJson(task.result)
          : failure(request, task.state === 'canceled' ? 'CANCELED' : 'TASK_FAILED', 'Task is already terminal.');
      }
      let childLocked = false;
      try {
        await this.assertNaturalActionDispatchIsCurrent(client, task, request);
        const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1 FOR UPDATE`, [id]);
        const lockedTask = selected.rows[0];
        if (!lockedTask) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
        task = lockedTask;
        childLocked = true;
        const principal = await activePrincipal(client, task.tenant_id, task.principal_id);
        const scope = task.kind === 'ingestion' ? 'knowledge:write' : requiredScope(request);
        const kbId = requestedKnowledgeBaseId(request);
        if (kbId) await ensureKnowledgeBaseAccess(client, principal, kbId, scope);
        await assertTaskResourcesAccessible(client, task.id, principal, scope);

        if (isTerminal(task.state)) {
          return task.result
            ? parseJson(task.result)
            : failure(request, task.state === 'canceled' ? 'CANCELED' : 'TASK_FAILED', 'Task is already terminal.');
        }
        if (signal.aborted) throw new DomainError('CANCELED', 'Task was canceled before execution.', 409);

        const priorReceipt = await client.query<{ result: BusinessResult | string }>(
          `SELECT result FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = 'execute' AND input_hash = $3 FOR UPDATE`,
          [task.tenant_id, task.id, receiptHash],
        );
        if (priorReceipt.rows[0]) {
          const result = parseJson(priorReceipt.rows[0].result);
          const state: TaskState = result.outcome === 'succeeded' ? 'completed' : result.error?.code === 'CANCELED' ? 'canceled' : 'failed';
          await this.finishTask(client, task, state, result);
          return result;
        }
        await client.query(`UPDATE pd_tasks SET state = 'working', updated_at = now() WHERE tenant_id = $1 AND id = $2`, [task.tenant_id, task.id]);

        let result: BusinessResult;
        if (task.kind === 'ingestion') {
          result = failure(request, 'INDEXING_NOT_AVAILABLE', 'This M1 backend stores source content but does not run ingestion or indexing.', false);
        } else {
          result = await this.executeOperation(client, task, request, principal);
        }

        await client.query(
          `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
           VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
          [task.tenant_id, task.id, receiptHash, result],
        );
        const state: TaskState = result.outcome === 'succeeded' ? 'completed' : result.error?.code === 'CANCELED' ? 'canceled' : 'failed';
        await this.finishTask(client, task, state, result);
        return result;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        if (!childLocked) {
          const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1 FOR UPDATE`, [id]);
          const lockedTask = selected.rows[0];
          if (!lockedTask) throw error;
          task = lockedTask;
          childLocked = true;
        }
        if (isTerminal(task.state)) {
          if (task.state === 'canceled') await this.releaseUpdateArtifacts(client, task, request);
          return task.result
            ? parseJson(task.result)
            : failure(request, task.state === 'canceled' ? 'CANCELED' : error.code, error.message, error.retryable);
        }
        await this.releaseUpdateArtifacts(client, task, request);
        const result = failure(request, error.code, error.message, error.retryable);
        await client.query(
          `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
           VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
          [task.tenant_id, task.id, receiptHash, result],
        );
        await this.finishTask(client, task, error.code === 'CANCELED' ? 'canceled' : 'failed', result);
        return result;
      }
    });
  }

  private async assertNaturalActionDispatchIsCurrent(client: Queryable, task: TaskRow, request: DocumentRequest): Promise<void> {
    if (task.kind !== 'operation') return;
    const schema = await client.query<{ available: boolean }>(
      `SELECT to_regclass('pd_agent_actions') IS NOT NULL
         AND to_regclass('pd_agent_contexts') IS NOT NULL
         AND to_regclass('pd_agent_tasks') IS NOT NULL
         AND to_regclass('pd_agent_turns') IS NOT NULL AS available`,
    );
    if (!schema.rows[0]?.available) return;

    const identity = await client.query<{ action_id: string; task_id: string; turn_no: number; context_id: string }>(
      `SELECT action_id, task_id, turn_no, context_id FROM pd_agent_actions
       WHERE tenant_id = $1 AND principal_id = $2 AND request_id = $3 AND operation = $4 AND context_id = $5
       LIMIT 1`,
      [task.tenant_id, task.principal_id, task.request_id, request.operation, task.context_id],
    );
    const actionIdentity = identity.rows[0];
    if (!actionIdentity) return;

    // Keep this order aligned with natural cancellation/closure: context, parent, turn, action, then child task.
    const contextResult = await client.query<{
      active_task_id: string | null; active_turn_no: number | null; closed_at: Date | string | null;
    }>(
      `SELECT active_task_id, active_turn_no, closed_at FROM pd_agent_contexts
       WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 FOR UPDATE`,
      [task.tenant_id, actionIdentity.context_id, task.principal_id],
    );
    const context = contextResult.rows[0];
    const parentResult = await client.query<{ current_turn_no: number; state: TaskState; fence: string | number }>(
      `SELECT current_turn_no, state, fence FROM pd_agent_tasks
       WHERE tenant_id = $1 AND task_id = $2 AND principal_id = $3 AND context_id = $4 FOR UPDATE`,
      [task.tenant_id, actionIdentity.task_id, task.principal_id, actionIdentity.context_id],
    );
    const parent = parentResult.rows[0];
    const turnResult = await client.query<{ state: string }>(
      `SELECT state FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3
         AND principal_id = $4 AND context_id = $5 FOR UPDATE`,
      [task.tenant_id, actionIdentity.task_id, actionIdentity.turn_no, task.principal_id, actionIdentity.context_id],
    );
    const actionResult = await client.query<{
      operation: DocumentRequest['operation']; request_id: string; context_id: string;
      child_task_id: string | null; state: string; fence: string | number;
    }>(
      `SELECT operation, request_id, context_id, child_task_id, state, fence FROM pd_agent_actions
       WHERE tenant_id = $1 AND action_id = $2 FOR UPDATE`,
      [task.tenant_id, actionIdentity.action_id],
    );
    const action = actionResult.rows[0];
    const turn = turnResult.rows[0];
    if (!context || !parent || !turn || !action || context.closed_at !== null
      || parent.state !== 'working' || Number(parent.current_turn_no) !== Number(actionIdentity.turn_no)
      || context.active_task_id !== actionIdentity.task_id || Number(context.active_turn_no) !== Number(actionIdentity.turn_no)
      || turn.state !== 'working' || action.operation !== request.operation || action.request_id !== task.request_id
      || action.context_id !== task.context_id || action.child_task_id !== task.id
      || !['dispatching', 'working'].includes(action.state)
      || Number(action.fence) !== Number(parent.fence)) {
      throw new DomainError('CANCELED', 'The natural-language parent canceled this action before the document operation could execute.', 409);
    }
  }

  private async executePipelineTask(
    id: string, signal: AbortSignal, checkpoint?: (step: string) => Promise<void>,
  ): Promise<BusinessResult> {
    const prepared = await this.preparePipelineTask(id, signal);
    if ('terminal' in prepared) return prepared.terminal!;
    const { task, request, principal } = prepared;
    const remainingBudgetMs = pipelineTaskDeadline(task, this.pipelineTaskDurationMs) - Date.now();
    if (remainingBudgetMs <= 0) {
      return this.failPipelineTask(task, request, pipelineTaskBudgetError());
    }
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => deadlineController.abort(), remainingBudgetMs);
    const executionSignal = AbortSignal.any([signal, deadlineController.signal]);
    let documentRef: IndexDocumentRef | undefined;
    try {
      let result: BusinessResult;
      if (request.operation === 'document.search') {
        result = await this.executeSearchPipeline(task, request, principal, executionSignal);
      } else if (request.operation === 'document.get') {
        result = await this.executeGetPipeline(task, request, principal, executionSignal);
      } else if (task.kind === 'ingestion') {
        documentRef = await this.documentRefFromParent(task);
        result = await this.buildAndPublishGeneration(task, request, principal, documentRef, executionSignal, checkpoint);
      } else if (request.operation === 'document.save' && request.input.source.kind === 'url') {
        const source = await this.getOrFetchUrlSource(task, request, principal, executionSignal, checkpoint);
        const saved = await this.getOrCreateUrlDocument(task, request, principal, source);
        documentRef = saved.document;
        if (saved.finalized) result = saved.result!;
        else {
          await checkpoint?.('source-stored');
          result = await this.buildAndPublishGeneration(task, request, principal, documentRef, executionSignal, checkpoint);
        }
      } else if (request.operation === 'document.update' && request.input.source.kind === 'url') {
        const source = await this.getOrFetchUrlSource(task, request, principal, executionSignal, checkpoint);
        const saved = await this.getOrCreateUpdatedUrl(task, request, principal, source);
        documentRef = saved.document;
        if (saved.finalized) result = saved.result!;
        else {
          await checkpoint?.('source-stored');
          result = await this.buildAndPublishGeneration(task, request, principal, documentRef, executionSignal, checkpoint);
        }
      } else if (request.operation === 'document.update') {
        documentRef = await this.getOrCreateUpdatedDocument(task, request, principal);
        await checkpoint?.('source-stored');
        result = await this.buildAndPublishGeneration(task, request, principal, documentRef, executionSignal, checkpoint);
      } else {
        documentRef = await this.getOrCreateIndexedDocument(task, request as Extract<DocumentRequest, { operation: 'document.save' }>, principal);
        await checkpoint?.('source-stored');
        result = await this.buildAndPublishGeneration(task, request, principal, documentRef, executionSignal, checkpoint);
      }
      if (deadlineController.signal.aborted && !signal.aborted) throw pipelineTaskBudgetError();
      return result;
    } catch (error) {
      const effectiveError = deadlineController.signal.aborted && !signal.aborted ? pipelineTaskBudgetError() : error;
      if (effectiveError instanceof DomainError) return this.failPipelineTask(task, request, effectiveError, documentRef);
      if (request.operation === 'document.search') {
        return this.failPipelineTask(task, request,
          new DomainError('SEARCH_BACKEND_FAILED', 'The search backend could not complete this query.', 500, true), documentRef);
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private async executeDeleteTask(id: string, signal: AbortSignal): Promise<BusinessResult> {
    const prepared = await inTransaction(this.pool, async client => {
      const identity = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1`, [id]);
      const initialTask = identity.rows[0];
      if (!initialTask) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
      let task: TaskRow = initialTask;
      const request = parseJson(task.request);
      if (request.operation !== 'document.delete') throw new DomainError('TASK_OPERATION_INVALID', 'Delete executor received another operation.', 409);
      if (isTerminal(task.state)) {
        return { terminal: task.result ? parseJson(task.result) : failure(request, task.state === 'canceled' ? 'CANCELED' : 'TASK_FAILED', 'Task is already terminal.') };
      }
      let childLocked = false;
      try {
        await this.assertNaturalActionDispatchIsCurrent(client, task, request);
        const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1 FOR UPDATE`, [id]);
        const lockedTask = selected.rows[0];
        if (!lockedTask) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
        task = lockedTask;
        childLocked = true;
        if (isTerminal(task.state)) {
          return { terminal: task.result ? parseJson(task.result) : failure(request, task.state === 'canceled' ? 'CANCELED' : 'TASK_FAILED', 'Task is already terminal.') };
        }
        const principal = await activePrincipal(client, task.tenant_id, task.principal_id);
        await ensureGlobalScope(principal, 'knowledge:delete');
        await ensureKnowledgeBaseAccess(client, principal, request.knowledgeBaseId, 'knowledge:delete');
        await assertTaskResourcesAccessible(client, task.id, principal, 'knowledge:delete');
        if (signal.aborted) throw new DomainError('CANCELED', 'Delete was canceled before execution.', 409);
        const receipt = await client.query<{ result: BusinessResult | string }>(
          `SELECT result FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = 'execute' AND input_hash = $3 FOR UPDATE`,
          [task.tenant_id, task.id, task.payload_hash],
        );
        if (receipt.rows[0]) {
          const result = parseJson(receipt.rows[0].result);
          const state: TaskState = result.outcome === 'succeeded' ? 'completed' : result.error?.code === 'CANCELED' ? 'canceled' : 'failed';
          await this.finishTask(client, task, state, result);
          return { terminal: result };
        }
        await client.query(`UPDATE pd_tasks SET state = 'working', updated_at = now() WHERE tenant_id = $1 AND id = $2`, [task.tenant_id, task.id]);
        return { task: { ...task, state: 'working' }, request, principal };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        if (!childLocked) {
          const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1 FOR UPDATE`, [id]);
          const lockedTask = selected.rows[0];
          if (!lockedTask) throw error;
          task = lockedTask;
          childLocked = true;
        }
        if (isTerminal(task.state)) {
          return { terminal: task.result ? parseJson(task.result) : failure(request, task.state === 'canceled' ? 'CANCELED' : 'TASK_FAILED', 'Task is already terminal.') };
        }
        const result = failure(request, error.code, error.message, error.retryable);
        await this.releaseUpdateArtifacts(client, task, request);
        await client.query(
          `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
           VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
          [task.tenant_id, task.id, task.payload_hash, result],
        );
        await this.finishTask(client, task, error.code === 'CANCELED' ? 'canceled' : 'failed', result);
        return { terminal: result };
      }
    });
    if ('terminal' in prepared) return prepared.terminal!;
    const { task, request, principal } = prepared;
    const result = await inTransaction(this.pool, async client => {
      const identityResult = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2`, [task.tenant_id, task.id]);
      const identity = identityResult.rows[0];
      if (!identity) return failure(request, 'TASK_NOT_FOUND', 'Delete task is no longer available.');
      if (isTerminal(identity.state)) {
        return identity.result
          ? parseJson(identity.result)
          : failure(request, identity.state === 'canceled' ? 'CANCELED' : 'TASK_NOT_WORKING', 'Delete task is no longer active.');
      }
      try {
        await this.assertNaturalActionDispatchIsCurrent(client, identity, request);
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        const currentTaskResult = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [task.tenant_id, task.id]);
        const currentTask = currentTaskResult.rows[0];
        if (!currentTask) return failure(request, 'TASK_NOT_FOUND', 'Delete task is no longer available.');
        if (isTerminal(currentTask.state)) {
          return currentTask.result
            ? parseJson(currentTask.result)
            : failure(request, currentTask.state === 'canceled' ? 'CANCELED' : 'TASK_NOT_WORKING', 'Delete task is no longer active.');
        }
        const canceled = failure(request, error.code, error.message, error.retryable);
        await client.query(
          `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
           VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
          [task.tenant_id, task.id, task.payload_hash, canceled],
        );
        await this.finishTask(client, currentTask, error.code === 'CANCELED' ? 'canceled' : 'failed', canceled);
        return canceled;
      }
      const currentTaskResult = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [task.tenant_id, task.id]);
      const currentTask = currentTaskResult.rows[0];
      if (!currentTask || currentTask.state !== 'working') {
        return currentTask?.result ? parseJson(currentTask.result) : failure(request, currentTask?.state === 'canceled' ? 'CANCELED' : 'TASK_NOT_WORKING', 'Delete task is no longer active.');
      }
      const current = await activePrincipal(client, task.tenant_id, task.principal_id);
      await ensureGlobalScope(current, 'knowledge:delete');
      await ensureKnowledgeBaseAccess(client, current, request.knowledgeBaseId, 'knowledge:delete');
      const documentResult = await client.query<{ active_version: number; revision: string | number }>(
        `SELECT active_version, revision FROM pd_documents
         WHERE tenant_id = $1 AND id = $2 AND knowledge_base_id = $3 AND deleted_at IS NULL FOR UPDATE`,
        [task.tenant_id, request.input.documentId, request.knowledgeBaseId],
      );
      const document = documentResult.rows[0];
      if (!document) {
        const failed = failure(request, 'DOCUMENT_NOT_FOUND', 'Document is not available.');
        await client.query(`INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result) VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
          [task.tenant_id, task.id, task.payload_hash, failed]);
        await this.finishTask(client, currentTask, 'failed', failed);
        return failed;
      }
      if (document.active_version !== request.input.expectedVersion) {
        const failed = failure(request, 'VERSION_CONFLICT', 'The expected document version is no longer active.');
        await client.query(`INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result) VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
          [task.tenant_id, task.id, task.payload_hash, failed]);
        await this.finishTask(client, currentTask, 'failed', failed);
        return failed;
      }
      const reservations = await client.query<{ target_version: number }>(
        `SELECT target_version FROM pd_document_update_reservations WHERE tenant_id = $1 AND document_id = $2 FOR UPDATE`,
        [task.tenant_id, request.input.documentId],
      );
      for (const reservation of reservations.rows) {
        await client.query(
          `DELETE FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND version > $4`,
          [task.tenant_id, request.input.documentId, reservation.target_version, document.active_version],
        );
      }
      await client.query(`DELETE FROM pd_document_update_reservations WHERE tenant_id = $1 AND document_id = $2`,
        [task.tenant_id, request.input.documentId]);
      const tombstone = await client.query(
        this.indexingEnabled
          ? `UPDATE pd_documents SET deleted_at = now(), revision = revision + 1, active_generation_id = NULL,
               active_profile_id = NULL, active_profile_version = NULL, active_dimensions = NULL
             WHERE tenant_id = $1 AND id = $2 AND active_version = $3 AND revision = $4 AND deleted_at IS NULL`
          : `UPDATE pd_documents SET deleted_at = now(), revision = revision + 1
             WHERE tenant_id = $1 AND id = $2 AND active_version = $3 AND revision = $4 AND deleted_at IS NULL`,
        [task.tenant_id, request.input.documentId, request.input.expectedVersion, document.revision],
      );
      if (tombstone.rowCount !== 1) throw new DomainError('VERSION_CONFLICT', 'The document changed before the tombstone could be committed.', 409);
      const purgeTaskId = randomUUID();
      const purgeTask = await client.query<TaskRow>(
        `INSERT INTO pd_tasks
          (id, tenant_id, principal_id, context_id, operation, request_id, payload_hash, request, kind, parent_task_id, state)
         VALUES ($1, $2, $3, $4, 'document.delete', $5, $6, $7, 'purge', $8, 'submitted') RETURNING *`,
        [purgeTaskId, task.tenant_id, task.principal_id, task.context_id, task.request_id, task.payload_hash, request, task.id],
      );
      if (!purgeTask.rows[0]) throw new Error('PURGE_TASK_INSERT_FAILED');
      await this.addTaskResource(client, purgeTask.rows[0], request.knowledgeBaseId);
      await client.query(
        `INSERT INTO pd_outbox (event_id, tenant_id, task_id, event_type, payload)
         VALUES ($1, $2, $3, 'dispatch', $4)`,
        [randomUUID(), task.tenant_id, purgeTaskId, { taskId: purgeTaskId, parentTaskId: task.id }],
      );
      const completed = success(request, { documentId: request.input.documentId, deleted: true, purgeState: 'pending', purgeTaskId });
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, task.payload_hash, completed],
      );
      await this.finishTask(client, currentTask, 'completed', completed);
      return completed;
    });
    if (result.outcome === 'succeeded') await this.injectFault('tombstone-committed');
    return result;
  }

  private async executePurgeTask(id: string, signal: AbortSignal): Promise<BusinessResult> {
    if (signal.aborted) throw new DomainError('CANCELED', 'Purge task is waiting for durable execution.', 409);
    const prepared = await inTransaction(this.pool, async client => {
      const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1 FOR UPDATE`, [id]);
      const task = selected.rows[0];
      if (!task || task.kind !== 'purge') throw new DomainError('TASK_NOT_FOUND', 'Purge task is not available.', 404);
      const request = parseJson(task.request);
      if (request.operation !== 'document.delete') throw new DomainError('TASK_OPERATION_INVALID', 'Purge task does not reference a delete request.', 409);
      if (isTerminal(task.state)) return { terminal: task.result ? parseJson(task.result) : failure(request, 'TASK_FAILED', 'Purge task is already terminal.') };
      const receipt = await client.query<{ result: { paths: string[] } | string }>(
        `SELECT result FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = 'purge-plan' AND input_hash = $3`,
        [task.tenant_id, task.id, task.payload_hash],
      );
      await client.query(`UPDATE pd_tasks SET state = 'working', updated_at = now() WHERE tenant_id = $1 AND id = $2`, [task.tenant_id, task.id]);
      return { task: { ...task, state: 'working' }, request, plan: receipt.rows[0] ? parseJson<{ paths: string[] }>(receipt.rows[0].result) : undefined };
    });
    if ('terminal' in prepared) return prepared.terminal!;
    const { task, request } = prepared;
    let plan = prepared.plan;
    if (!plan) {
      plan = await inTransaction(this.pool, async client => {
        const lockedTask = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [task.tenant_id, task.id]);
        if (lockedTask.rows[0]?.state !== 'working') throw new DomainError('TASK_NOT_WORKING', 'Purge task is no longer active.', 409);
        const prior = await client.query<{ result: { paths: string[] } | string }>(
          `SELECT result FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = 'purge-plan' AND input_hash = $3 FOR UPDATE`,
          [task.tenant_id, task.id, task.payload_hash],
        );
        if (prior.rows[0]) return parseJson<{ paths: string[] }>(prior.rows[0].result);
        const document = await client.query(
          `SELECT 1 FROM pd_documents WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NOT NULL FOR UPDATE`,
          [task.tenant_id, request.input.documentId],
        );
        if (!document.rowCount) throw new DomainError('TOMBSTONE_MISSING', 'The delete tombstone is missing.', 409);
        const content = await client.query<{ sha256: string }>(
          `SELECT sha256 FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2`,
          [task.tenant_id, request.input.documentId],
        );
        await client.query(
          `DELETE FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2`,
          [task.tenant_id, request.input.documentId],
        );
        const paths: string[] = [];
        for (const version of content.rows) {
          const removed = await client.query<{ relative_path: string }>(
            `DELETE FROM pd_blobs b WHERE b.tenant_id = $1 AND b.sha256 = $2
               AND NOT EXISTS (SELECT 1 FROM pd_document_versions v WHERE v.tenant_id = b.tenant_id AND v.sha256 = b.sha256)
               AND NOT EXISTS (SELECT 1 FROM pd_uploads u WHERE u.tenant_id = b.tenant_id AND u.sha256 = b.sha256)
             RETURNING relative_path`,
            [task.tenant_id, version.sha256],
          );
          for (const row of removed.rows) paths.push(row.relative_path);
        }
        await client.query(
          `UPDATE pd_documents SET title = '', tags = '[]'::jsonb WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NOT NULL`,
          [task.tenant_id, request.input.documentId],
        );
        const result = { paths: [...new Set(paths)] };
        await client.query(
          `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
           VALUES ($1, $2, 'purge-plan', $3, $4) ON CONFLICT DO NOTHING`,
          [task.tenant_id, task.id, task.payload_hash, JSON.stringify(result)],
        );
        return result;
      });
    }
    for (const path of plan.paths) await rm(this.resolveBlobPath(path), { force: true });
    return inTransaction(this.pool, async client => {
      const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [task.tenant_id, task.id]);
      const current = selected.rows[0];
      if (!current) throw new DomainError('TASK_NOT_FOUND', 'Purge task is not available.', 404);
      if (isTerminal(current.state)) return current.result ? parseJson(current.result) : failure(request, 'TASK_FAILED', 'Purge task is already terminal.');
      const purgeResult = success(request, { documentId: request.input.documentId, deleted: true, purgeState: 'completed' });
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, task.payload_hash, purgeResult],
      );
      await this.finishTask(client, current, 'completed', purgeResult);
      if (task.parent_task_id) {
        const parent = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [task.tenant_id, task.parent_task_id]);
        const parentTask = parent.rows[0];
        if (parentTask?.result) {
          const parentResult = parseJson<BusinessResult>(parentTask.result);
          const resultBody = { ...(parentResult.result ?? {}), purgeState: 'completed' };
          const updatedParentResult = { ...parentResult, result: resultBody };
          await client.query(`UPDATE pd_tasks SET result = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2`,
            [task.tenant_id, task.parent_task_id, updatedParentResult]);
          await client.query(
            `UPDATE pd_processing_receipts SET result = $4 WHERE tenant_id = $1 AND task_id = $2 AND stage = 'execute' AND input_hash = $3`,
            [task.tenant_id, task.parent_task_id, parentTask.payload_hash, updatedParentResult],
          );
        }
      }
      return purgeResult;
    });
  }

  private async preparePipelineTask(
    id: string, signal: AbortSignal,
  ): Promise<{ task: TaskRow; request: DocumentRequest; principal: Principal } | { terminal: BusinessResult }> {
    return inTransaction(this.pool, async client => {
      const identity = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1`, [id]);
      const initialTask = identity.rows[0];
      if (!initialTask) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
      let task: TaskRow = initialTask;
      const request = parseJson(task.request);
      if (isTerminal(task.state)) {
        return { terminal: task.result ? parseJson(task.result) : failure(request, task.state === 'canceled' ? 'CANCELED' : 'TASK_FAILED', 'Task is already terminal.') };
      }
      let childLocked = false;
      try {
        await this.assertNaturalActionDispatchIsCurrent(client, task, request);
        const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1 FOR UPDATE`, [id]);
        const lockedTask = selected.rows[0];
        if (!lockedTask) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
        task = lockedTask;
        childLocked = true;
        if (isTerminal(task.state)) {
          return { terminal: task.result ? parseJson(task.result) : failure(request, task.state === 'canceled' ? 'CANCELED' : 'TASK_FAILED', 'Task is already terminal.') };
        }
        const principal = await activePrincipal(client, task.tenant_id, task.principal_id);
        const scope: Scope = request.operation === 'document.search' || request.operation === 'document.get'
          ? 'knowledge:read'
          : 'knowledge:write';
        const knowledgeBaseId = requestedKnowledgeBaseId(request);
        if (knowledgeBaseId) await ensureKnowledgeBaseAccess(client, principal, knowledgeBaseId, scope);
        await assertTaskResourcesAccessible(client, task.id, principal, scope);
        if (signal.aborted) throw new DomainError('CANCELED', 'Task was canceled before execution.', 409);
        const priorReceipt = await client.query<{ result: BusinessResult | string }>(
          `SELECT result FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = 'execute' AND input_hash = $3 FOR UPDATE`,
          [task.tenant_id, task.id, task.payload_hash],
        );
        if (priorReceipt.rows[0]) {
          const result = parseJson(priorReceipt.rows[0].result);
          const state: TaskState = result.outcome === 'succeeded' ? 'completed' : result.error?.code === 'CANCELED' ? 'canceled' : 'failed';
          await this.finishTask(client, task, state, result);
          return { terminal: result };
        }
        await client.query(`UPDATE pd_tasks SET state = 'working', updated_at = now() WHERE tenant_id = $1 AND id = $2`, [task.tenant_id, task.id]);
        return { task: { ...task, state: 'working' }, request, principal };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        if (!childLocked) {
          const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1 FOR UPDATE`, [id]);
          const lockedTask = selected.rows[0];
          if (!lockedTask) throw error;
          task = lockedTask;
          childLocked = true;
        }
        if (isTerminal(task.state)) {
          return { terminal: task.result ? parseJson(task.result) : failure(request, task.state === 'canceled' ? 'CANCELED' : 'TASK_FAILED', 'Task is already terminal.') };
        }
        const result = failure(request, error.code, error.message, error.retryable);
        await this.releaseUpdateArtifacts(client, task, request);
        await client.query(
          `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
           VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
          [task.tenant_id, task.id, task.payload_hash, result],
        );
        await this.finishTask(client, task, error.code === 'CANCELED' ? 'canceled' : 'failed', result);
        return { terminal: result };
      }
    });
  }

  private async getOrCreateIndexedDocument(
    task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.save' }>, principal: Principal,
  ): Promise<IndexDocumentRef> {
    return inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal);
      const existing = await client.query<{ id: string; knowledge_base_id: string; active_version: number; sha256: string }>(
        `SELECT d.id, d.knowledge_base_id, d.active_version, v.sha256
         FROM pd_documents d JOIN pd_document_versions v
           ON v.tenant_id = d.tenant_id AND v.document_id = d.id AND v.version = d.active_version
         WHERE d.tenant_id = $1 AND d.created_by_task_id = $2 FOR UPDATE OF d`,
        [task.tenant_id, task.id],
      );
      const row = existing.rows[0];
      if (row) return { documentId: row.id, version: row.active_version, sha256: row.sha256, knowledgeBaseId: row.knowledge_base_id };
      const result = await this.saveDocument(client, task, request, principal);
      if (result.outcome !== 'succeeded' || !result.result) throw new DomainError(result.error?.code ?? 'DOCUMENT_SAVE_FAILED', result.error?.message ?? 'Unable to save the source document.');
      return {
        documentId: String(result.result.documentId),
        version: Number(result.result.version),
        sha256: String(result.result.sha256),
        knowledgeBaseId: String(result.result.knowledgeBaseId),
      };
    });
  }

  private async getOrCreateUpdatedDocument(
    task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.update' }>, principal: Principal,
  ): Promise<IndexDocumentRef> {
    return inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal);
      const existing = await client.query<{
        expected_revision: string | number; target_version: number; sha256: string | null; knowledge_base_id: string;
      }>(
        `SELECT r.expected_revision, r.target_version, v.sha256, d.knowledge_base_id
         FROM pd_document_update_reservations r
         JOIN pd_documents d ON d.tenant_id = r.tenant_id AND d.id = r.document_id
         LEFT JOIN pd_document_versions v ON v.tenant_id = r.tenant_id AND v.document_id = r.document_id AND v.version = r.target_version
         WHERE r.tenant_id = $1 AND r.document_id = $2 AND r.expected_version = $3 AND r.reserved_task_id = $4 FOR UPDATE OF r`,
        [task.tenant_id, request.input.documentId, request.input.expectedVersion, task.id],
      );
      const row = existing.rows[0];
      if (!row) throw new DomainError('VERSION_CONFLICT', 'The document update reservation is no longer active.', 409);
      if (row.sha256) return {
        documentId: request.input.documentId,
        version: row.target_version,
        sha256: row.sha256,
        knowledgeBaseId: row.knowledge_base_id,
        expectedVersion: request.input.expectedVersion,
        expectedRevision: Number(row.expected_revision),
      };
      const result = await this.saveUpdatedDocument(client, task, request, principal);
      if (result.outcome !== 'succeeded' || !result.result) throw new DomainError(result.error?.code ?? 'DOCUMENT_UPDATE_FAILED', result.error?.message ?? 'Unable to save the updated source.');
      return {
        documentId: String(result.result.documentId),
        version: Number(result.result.version),
        sha256: String(result.result.sha256),
        knowledgeBaseId: String(result.result.knowledgeBaseId),
        expectedVersion: request.input.expectedVersion,
        expectedRevision: Number(row.expected_revision),
      };
    });
  }

  private async getOrCreateUpdatedUrl(
    task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.update' }>, principal: Principal, source: FetchedHtml,
  ): Promise<{ document: IndexDocumentRef; finalized: boolean; result?: BusinessResult }> {
    return inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal);
      const reservation = await client.query<{
        expected_revision: string | number; target_version: number; sha256: string | null; knowledge_base_id: string;
      }>(
        `SELECT r.expected_revision, r.target_version, v.sha256, d.knowledge_base_id
         FROM pd_document_update_reservations r
         JOIN pd_documents d ON d.tenant_id = r.tenant_id AND d.id = r.document_id
         LEFT JOIN pd_document_versions v ON v.tenant_id = r.tenant_id AND v.document_id = r.document_id AND v.version = r.target_version
         WHERE r.tenant_id = $1 AND r.document_id = $2 AND r.expected_version = $3 AND r.reserved_task_id = $4 FOR UPDATE OF r`,
        [task.tenant_id, request.input.documentId, request.input.expectedVersion, task.id],
      );
      const row = reservation.rows[0];
      if (!row) throw new DomainError('VERSION_CONFLICT', 'The document update reservation is no longer active.', 409);
      const document: IndexDocumentRef = {
        documentId: request.input.documentId,
        version: row.target_version,
        sha256: row.sha256 ?? '',
        knowledgeBaseId: row.knowledge_base_id,
        expectedVersion: request.input.expectedVersion,
        expectedRevision: Number(row.expected_revision),
      };
      let result: BusinessResult | undefined;
      if (!row.sha256) {
        result = await this.saveUpdatedDocument(client, task, request, principal, {
          bytes: source.bytes, mimeType: source.mimeType, sourceType: 'url', sourceUri: source.sourceUri, fetchedAt: source.fetchedAt,
        });
        if (result.outcome !== 'succeeded' || !result.result) throw new DomainError(result.error?.code ?? 'DOCUMENT_UPDATE_FAILED', result.error?.message ?? 'Unable to save the updated URL source.');
        document.sha256 = String(result.result.sha256);
      } else if (request.input.waitFor !== 'stored') {
        return { document, finalized: false };
      } else {
        throw new DomainError('UPDATE_SOURCE_ALREADY_STORED', 'The stored update is already associated with another task state.', 409);
      }
      if (request.input.waitFor !== 'stored') return { document, finalized: false };
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, task.payload_hash, result],
      );
      await this.finishTask(client, task, 'completed', result!);
      return { document, finalized: true, result };
    });
  }

  private async documentRefFromParent(
    task: TaskRow,
  ): Promise<IndexDocumentRef> {
    if (!task.parent_task_id) throw new DomainError('INGESTION_PARENT_MISSING', 'The ingestion task has no parent save task.');
    const request = parseJson(task.request);
    const retry = await this.pool.query<{
      source_task_id: string; document_id: string; version: number; source_sha256: string;
    }>(
      `SELECT source_task_id, document_id, version, source_sha256
       FROM pd_task_retries WHERE tenant_id = $1 AND retry_task_id = $2`,
      [task.tenant_id, task.id],
    );
    if (retry.rows[0]) {
      const pinned = retry.rows[0];
      if (pinned.source_task_id !== task.parent_task_id || request.operation !== 'document.save') {
        throw new DomainError('RETRY_SOURCE_INVALID', 'The retry task source binding is invalid.', 409);
      }
      const document = await this.pool.query<{ knowledge_base_id: string }>(
        `SELECT knowledge_base_id FROM pd_documents WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [task.tenant_id, pinned.document_id],
      );
      if (!document.rows[0] || document.rows[0].knowledge_base_id !== request.knowledgeBaseId) {
        throw new DomainError('RETRY_SOURCE_STALE', 'The saved source is no longer available for indexing.', 409);
      }
      return {
        documentId: pinned.document_id,
        version: Number(pinned.version),
        sha256: pinned.source_sha256,
        knowledgeBaseId: document.rows[0].knowledge_base_id,
      };
    }
    const parent = await this.pool.query<{ result: BusinessResult | string | null }>(
      `SELECT result FROM pd_tasks WHERE tenant_id = $1 AND id = $2`, [task.tenant_id, task.parent_task_id],
    );
    const result = parent.rows[0]?.result ? parseJson(parent.rows[0].result) : null;
    const saved = result?.result;
    if (!result || result.outcome !== 'succeeded' || !saved || typeof saved.documentId !== 'string' || typeof saved.sha256 !== 'string') {
      throw new DomainError('INGESTION_PARENT_NOT_READY', 'The parent save task has not committed a source document.');
    }
    let updateFence: Pick<IndexDocumentRef, 'expectedVersion' | 'expectedRevision'> = {};
    if (request.operation === 'document.update') {
      const reservation = await this.pool.query<{ expected_revision: string | number }>(
        `SELECT expected_revision FROM pd_document_update_reservations
         WHERE tenant_id = $1 AND document_id = $2 AND expected_version = $3 AND reserved_task_id = $4`,
        [task.tenant_id, saved.documentId, request.input.expectedVersion, task.parent_task_id],
      );
      if (!reservation.rows[0]) throw new DomainError('VERSION_CONFLICT', 'The document update reservation is no longer active.', 409);
      updateFence = { expectedVersion: request.input.expectedVersion, expectedRevision: Number(reservation.rows[0].expected_revision) };
    }
    return {
      documentId: saved.documentId,
      version: Number(saved.version),
      sha256: saved.sha256,
      knowledgeBaseId: String(saved.knowledgeBaseId ?? requestedKnowledgeBaseId(parseJson(task.request)) ?? ''),
      ...updateFence,
    };
  }

  private async getOrFetchUrlSource(
    task: TaskRow, request: SaveOrUpdateRequest, principal: Principal,
    signal: AbortSignal, checkpoint?: (step: string) => Promise<void>,
  ): Promise<FetchedHtml & { relativePath: string }> {
    if (request.input.source.kind !== 'url') throw new DomainError('SOURCE_KIND_INVALID', 'A URL source is required.');
    const inputHash = sha256(canonicalJson({ url: request.input.source.url }));
    const receipt = await inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal);
      const stored = await client.query<{ result: UrlSourceReceipt | string }>(
        `SELECT result FROM pd_processing_receipts
         WHERE tenant_id = $1 AND task_id = $2 AND stage = 'source-fetch' AND input_hash = $3`,
        [task.tenant_id, task.id, inputHash],
      );
      return stored.rows[0] ? parseJson<UrlSourceReceipt>(stored.rows[0].result) : undefined;
    });
    let source: FetchedHtml & { relativePath: string };
    if (receipt) {
      const bytes = await readFile(this.resolveBlobPath(receipt.relativePath));
      if (bytes.byteLength !== receipt.size || sha256(bytes) !== receipt.sha256) {
        throw new DomainError('CONTENT_HASH_MISMATCH', 'The fetched URL source failed its stored integrity check.', 500);
      }
      source = {
        bytes, mimeType: receipt.mimeType as 'text/html', sourceUri: receipt.sourceUri,
        sha256: receipt.sha256, fetchedAt: receipt.fetchedAt, relativePath: receipt.relativePath,
      };
    } else {
      if (signal.aborted) throw new DomainError('CANCELED', 'URL fetching was canceled before it started.', 409);
      let fetched: FetchedHtml;
      try {
        fetched = await fetchPublicHtml(request.input.source.url, signal);
      } catch (error) {
        throw this.toSourceFetchError(error);
      }
      if (signal.aborted) throw new DomainError('CANCELED', 'URL fetching was canceled.', 409);
      const mimeType = normalizeSourceMime(fetched.mimeType);
      if (mimeType !== 'text/html') throw new DomainError('UNSUPPORTED_FORMAT', 'URL sources must have an HTML media type.');
      validateSourceBytes(fetched.bytes, mimeType, 'SOURCE_FETCH_FAILED');
      const digest = sha256(fetched.bytes);
      if (digest !== fetched.sha256) throw new DomainError('CONTENT_HASH_MISMATCH', 'The fetched URL hash does not match its bytes.', 500);
      const relativePath = await this.writeBlob(task.tenant_id, digest, fetched.bytes);
      const value = {
        relativePath,
        sha256: digest,
        mimeType,
        size: fetched.bytes.byteLength,
        sourceUri: fetched.sourceUri,
        fetchedAt: fetched.fetchedAt,
      };
      await inTransaction(this.pool, async client => {
        await this.assertPipelineFence(client, task, request, principal);
        await client.query(
          `INSERT INTO pd_blobs (tenant_id, sha256, relative_path, mime_type, byte_size)
           VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, sha256) DO NOTHING`,
          [task.tenant_id, digest, relativePath, mimeType, fetched.bytes.byteLength],
        );
        const blob = await client.query<{ relative_path: string; mime_type: string; byte_size: string | number }>(
          `SELECT relative_path, mime_type, byte_size FROM pd_blobs WHERE tenant_id = $1 AND sha256 = $2 FOR UPDATE`,
          [task.tenant_id, digest],
        );
        const blobRow = blob.rows[0];
        if (!blobRow || blobRow.relative_path !== relativePath || blobRow.mime_type !== mimeType || Number(blobRow.byte_size) !== fetched.bytes.byteLength) {
          throw new DomainError('BLOB_METADATA_CONFLICT', 'Fetched source metadata does not match its content-addressed blob.', 500);
        }
        await client.query(
          `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
           VALUES ($1, $2, 'source-fetch', $3, $4) ON CONFLICT DO NOTHING`,
          [task.tenant_id, task.id, inputHash, JSON.stringify(value)],
        );
      });
      source = { ...fetched, mimeType: 'text/html', sha256: digest, relativePath };
    }
    await checkpoint?.('source-fetch-receipt');
    return source;
  }

  private toSourceFetchError(error: unknown): DomainError {
    if (error instanceof DomainError) return error;
    const record = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : undefined;
    const code = typeof record?.code === 'string' ? record.code : '';
    if (code === 'ABORTED') return new DomainError('CANCELED', 'URL fetching was canceled.', 409);
    if (code === 'RESPONSE_TOO_LARGE') return new DomainError('SIZE_LIMIT', 'The fetched URL exceeds 50 MiB.', 413);
    const denied = new Set([
      'URL_INVALID', 'URL_SCHEME_UNSUPPORTED', 'URL_CREDENTIALS_OR_FRAGMENT', 'URL_PORT_UNSUPPORTED',
      'URL_HOST_BLOCKED', 'URL_IP_ENCODING', 'IP_NOT_PUBLIC', 'REMOTE_ADDRESS_MISMATCH',
    ]);
    if (denied.has(code)) return new DomainError('SOURCE_FETCH_DENIED', 'The URL was rejected by the public-source security policy.', 400);
    const retryable = new Set(['DNS_LOOKUP_FAILED', 'REQUEST_FAILED', 'TIMEOUT']);
    return new DomainError('SOURCE_FETCH_FAILED', 'The URL source could not be fetched.', 502, retryable.has(code));
  }

  private async getOrCreateUrlDocument(
    task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.save' }>, principal: Principal,
    fetched: FetchedHtml,
  ): Promise<{
    document: { documentId: string; version: number; sha256: string; knowledgeBaseId: string };
    finalized: boolean;
    result?: BusinessResult;
  }> {
    return inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal);
      const existing = await client.query<{ id: string; knowledge_base_id: string; active_version: number; sha256: string }>(
        `SELECT d.id, d.knowledge_base_id, d.active_version, v.sha256
         FROM pd_documents d JOIN pd_document_versions v
           ON v.tenant_id = d.tenant_id AND v.document_id = d.id AND v.version = d.active_version
         WHERE d.tenant_id = $1 AND d.created_by_task_id = $2 FOR UPDATE OF d`,
        [task.tenant_id, task.id],
      );
      const row = existing.rows[0];
      if (row) {
        return {
          document: { documentId: row.id, version: row.active_version, sha256: row.sha256, knowledgeBaseId: row.knowledge_base_id },
          finalized: false,
        };
      }
      const result = await this.saveResolvedDocument(client, task, request, principal, {
        bytes: fetched.bytes,
        mimeType: fetched.mimeType,
        sourceType: 'url',
        sourceUri: fetched.sourceUri,
        fetchedAt: fetched.fetchedAt,
      });
      if (result.outcome !== 'succeeded' || !result.result) {
        throw new DomainError(result.error?.code ?? 'DOCUMENT_SAVE_FAILED', result.error?.message ?? 'Unable to save the fetched source.');
      }
      const document = {
        documentId: String(result.result.documentId),
        version: Number(result.result.version),
        sha256: String(result.result.sha256),
        knowledgeBaseId: String(result.result.knowledgeBaseId),
      };
      if (request.input.waitFor !== 'stored') return { document, finalized: false };
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, task.payload_hash, result],
      );
      await this.finishTask(client, task, 'completed', result);
      return { document, finalized: true, result };
    });
  }

  private async buildAndPublishGeneration(
    task: TaskRow, request: DocumentRequest, principal: Principal,
    document: IndexDocumentRef,
    signal: AbortSignal, checkpoint?: (step: string) => Promise<void>,
  ): Promise<BusinessResult> {
    const pipeline = this.pipeline;
    if (!pipeline) throw new DomainError('INDEXING_NOT_AVAILABLE', 'No document indexing pipeline is configured.');
    if (signal.aborted) throw new DomainError('CANCELED', 'Task was canceled before indexing.', 409);

    const profile = pipeline.profile;
    const generationId = sha256(canonicalJson({ documentId: document.documentId, version: document.version, profileId: profile.id, profileVersion: profile.version })).slice(0, 48);
    const source = await this.readIndexContent(principal, document);
    if (source.sha256 !== document.sha256) throw new DomainError('CONTENT_HASH_MISMATCH', 'The source version changed before indexing.', 409);
    await this.openGeneration(task, request, principal, document, generationId);

    const parseInputHash = sha256(canonicalJson({ sourceSha256: document.sha256, profileId: profile.id, profileVersion: profile.version }));
    let parsed = await this.readPipelineReceipt<{
      chunks: Omit<IndexedChunk, 'embedding'>[]; warnings: string[];
    }>(task, request, principal, document, 'parse', parseInputHash);
    if (!parsed) {
      await this.assertPipelineCanContinue(task, request, principal, document);
      let parsedSource: Awaited<ReturnType<DocumentPipeline['parse']>>;
      try {
        parsedSource = await pipeline.parse(source.bytes, source.mimeType, signal);
      } catch (error) {
        throw this.toPipelineError(error, 'PARSER_FAILED', 'The source parser failed.');
      }
      await this.injectFault('parse-finished');
      if (signal.aborted) throw new DomainError('CANCELED', 'Task was canceled during parsing.', 409);
      if (!parsedSource || typeof parsedSource.text !== 'string' || !Array.isArray(parsedSource.chunks)) {
        throw new DomainError('PARSE_OUTPUT_INVALID', 'The parser returned an invalid result.');
      }
      if (!parsedSource.text.trim()) throw new DomainError('EMPTY_PARSE', 'Parsing produced no normalized text.');
      const chunks = parsedSource.chunks.map((chunk, index) => ({
        ordinal: chunk.ordinal,
        text: chunk.text,
        locator: chunk.locator,
        lexicalTokens: chunk.lexicalTokens,
      }));
      if (!chunks.length || chunks.some((chunk, index) => chunk.ordinal !== index || !chunk.text?.trim() ||
        !Array.isArray(chunk.lexicalTokens) || chunk.lexicalTokens.some(token => typeof token !== 'string') ||
        !chunk.locator || typeof chunk.locator !== 'object' || Array.isArray(chunk.locator))) {
        throw new DomainError('EMPTY_PARSE', 'Parsing produced no valid indexed chunks.');
      }
      parsed = { chunks, warnings: parsedSource.warnings ?? [] };
      await this.persistPipelineReceipt(task, request, principal, document, 'parse', parseInputHash, parsed);
      await checkpoint?.('parse-receipt');
    }
    if (!parsed || !Array.isArray(parsed.chunks) || parsed.chunks.length === 0 || !Array.isArray(parsed.warnings) || parsed.chunks.some((chunk, index) =>
      !chunk || chunk.ordinal !== index || typeof chunk.text !== 'string' || !chunk.text.trim() || !Array.isArray(chunk.lexicalTokens) ||
      chunk.lexicalTokens.some(token => typeof token !== 'string') || !chunk.locator || typeof chunk.locator !== 'object' || Array.isArray(chunk.locator))) {
      throw new DomainError('PARSE_RECEIPT_INVALID', 'The parse receipt does not contain a complete chunk set.');
    }

    const embeddings: number[][] = [];
    const embeddingBatchSize = 8;
    for (let start = 0, batchIndex = 0; start < parsed.chunks.length; start += embeddingBatchSize, batchIndex += 1) {
      const texts = parsed.chunks.slice(start, start + embeddingBatchSize).map(chunk => chunk.text);
      const inputHash = sha256(canonicalJson({
        parseInputHash, batchIndex, texts, profileId: profile.id, profileVersion: profile.version, dimensions: profile.dimensions,
      }));
      let batch = await this.readPipelineReceipt<number[][]>(task, request, principal, document, 'embedding', inputHash);
      if (!batch) {
        await this.assertPipelineCanContinue(task, request, principal, document);
        const contentHashes = texts.map(text => sha256(text));
        const cached = await this.readEmbeddingCache(task, request, principal, document, contentHashes);
        const missing = cached.flatMap((vector, index) => vector ? [] : [index]);
        if (missing.length) {
          let generated: number[][];
          try {
            generated = await pipeline.embed(missing.map(index => texts[index]!), signal);
          } catch (error) {
            throw this.toPipelineError(error, 'EMBEDDING_FAILED', 'The embedding service failed.');
          }
          await this.injectFault('embedding-batch-finished');
          this.validateEmbeddings(generated, missing.length, profile.dimensions);
          for (let index = 0; index < missing.length; index += 1) cached[missing[index]!] = generated[index]!;
        }
        if (signal.aborted) throw new DomainError('CANCELED', 'Task was canceled during embedding.', 409);
        batch = cached as number[][];
        this.validateEmbeddings(batch, texts.length, profile.dimensions);
        await this.persistEmbeddingBatch(task, request, principal, document, inputHash, contentHashes, batch);
        await checkpoint?.(`embedding-batch-${batchIndex}-receipt`);
      } else {
        this.validateEmbeddings(batch, texts.length, profile.dimensions);
      }
      embeddings.push(...batch);
    }

    const indexedChunks: IndexedChunk[] = parsed.chunks.map((chunk, index) => ({ ...chunk, embedding: embeddings[index]! }));
    if (signal.aborted) throw new DomainError('CANCELED', 'Task was canceled before index publication.', 409);
    return this.publishGeneration(task, request, principal, document, generationId, indexedChunks, parsed.warnings);
  }

  private async openGeneration(
    task: TaskRow, request: DocumentRequest, principal: Principal,
    document: IndexDocumentRef, generationId: string,
  ): Promise<void> {
    const pipeline = this.pipeline!;
    await inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal, document);
      const configured = await client.query<{ dimensions: number }>(`SELECT dimensions FROM pd_vector_configuration WHERE singleton = true FOR SHARE`);
      if (!configured.rows[0] || Number(configured.rows[0].dimensions) !== pipeline.profile.dimensions) {
        throw new DomainError('VECTOR_DIMENSION_MISMATCH', 'The configured vector schema does not match the embedding pipeline.', 409);
      }
      await client.query(
        `INSERT INTO pd_index_generations
          (tenant_id, document_id, version, generation_id, profile_id, profile_version, dimensions, source_sha256, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'staging')
         ON CONFLICT (tenant_id, document_id, version, profile_id, profile_version) DO NOTHING`,
        [task.tenant_id, document.documentId, document.version, generationId, pipeline.profile.id,
          pipeline.profile.version, pipeline.profile.dimensions, document.sha256],
      );
      const generation = await client.query<{ generation_id: string; source_sha256: string; state: string }>(
        `SELECT generation_id, source_sha256, state FROM pd_index_generations
         WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND profile_id = $4 AND profile_version = $5 FOR UPDATE`,
        [task.tenant_id, document.documentId, document.version, pipeline.profile.id, pipeline.profile.version],
      );
      if (!generation.rows[0] || generation.rows[0].generation_id !== generationId || generation.rows[0].source_sha256 !== document.sha256) {
        throw new DomainError('INDEX_GENERATION_CONFLICT', 'An incompatible generation already exists for this document version.', 409);
      }
      if (generation.rows[0].state === 'failed') {
        await client.query(
          `UPDATE pd_index_generations SET state = 'staging', ready_at = NULL
           WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND generation_id = $4 AND state = 'failed'`,
          [task.tenant_id, document.documentId, document.version, generationId],
        );
      }
    });
  }

  private async assertPipelineCanContinue(
    task: TaskRow, request: DocumentRequest, principal: Principal,
    document: IndexDocumentRef,
  ): Promise<void> {
    await inTransaction(this.pool, client => this.assertPipelineFence(client, task, request, principal, document));
  }

  private async assertPipelineFence(
    client: Queryable, task: TaskRow, request: DocumentRequest, principal: Principal,
    document?: IndexDocumentRef,
  ): Promise<void> {
    await this.assertNaturalActionDispatchIsCurrent(client, task, request);
    const state = await client.query<{ state: TaskState; created_at: Date | string }>(
      `SELECT state, created_at FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [task.tenant_id, task.id],
    );
    if (state.rows[0]?.state !== 'working') throw new DomainError(state.rows[0]?.state === 'canceled' ? 'CANCELED' : 'TASK_NOT_WORKING', 'The indexing task is no longer active.', 409);
    assertPipelineTaskWithinBudget(state.rows[0]!, this.pipelineTaskDurationMs);
    const current = await activePrincipal(client, task.tenant_id, task.principal_id);
    const scope: Scope = request.operation === 'document.search' || request.operation === 'document.get'
      ? 'knowledge:read'
      : 'knowledge:write';
    const knowledgeBaseId = document?.knowledgeBaseId ?? requestedKnowledgeBaseId(request);
    if (knowledgeBaseId) await ensureKnowledgeBaseAccess(client, current, knowledgeBaseId, scope);
    await assertTaskResourcesAccessible(client, task.id, current, scope);
    if (!document) return;
    const currentVersion = await client.query<{ active_version: number; revision: string | number; deleted_at: Date | string | null; sha256: string | null }>(
      `SELECT d.active_version, d.revision, d.deleted_at, v.sha256
       FROM pd_documents d LEFT JOIN pd_document_versions v
         ON v.tenant_id = d.tenant_id AND v.document_id = d.id AND v.version = $3
       WHERE d.tenant_id = $1 AND d.id = $2
       FOR UPDATE OF d`,
      [task.tenant_id, document.documentId, document.version],
    );
    const row = currentVersion.rows[0];
    const expectedActiveVersion = document.expectedVersion ?? document.version;
    if (!row || row.deleted_at || row.active_version !== expectedActiveVersion || row.sha256 !== document.sha256 ||
      (document.expectedRevision !== undefined && Number(row.revision) !== document.expectedRevision)) {
      throw new DomainError('DOCUMENT_VERSION_STALE', 'The source version is no longer eligible for publication.', 409);
    }
    const retry = task.kind === 'ingestion'
      ? await client.query(
        `SELECT 1 FROM pd_task_retries WHERE tenant_id = $1 AND retry_task_id = $2`,
        [task.tenant_id, task.id],
      )
      : { rowCount: 0 };
    if (retry.rowCount) {
      const reservation = await client.query(
        `SELECT 1 FROM pd_document_update_reservations
         WHERE tenant_id = $1 AND document_id = $2 AND expected_version = $3`,
        [task.tenant_id, document.documentId, document.version],
      );
      if (reservation.rowCount) throw new DomainError('DOCUMENT_VERSION_STALE', 'A document update is in progress for the saved source.', 409);
    }
    if (document.expectedVersion !== undefined) {
      const reservedTaskId = task.kind === 'ingestion' && task.parent_task_id ? task.parent_task_id : task.id;
      const reservation = await client.query(
        `SELECT 1 FROM pd_document_update_reservations WHERE tenant_id = $1 AND document_id = $2
         AND expected_version = $3 AND reserved_task_id = $4`,
        [task.tenant_id, document.documentId, document.expectedVersion, reservedTaskId],
      );
      if (!reservation.rowCount) throw new DomainError('VERSION_CONFLICT', 'The document update reservation is no longer active.', 409);
    }
  }

  private async readPipelineReceipt<T>(
    task: TaskRow, request: DocumentRequest, principal: Principal,
    document: IndexDocumentRef, stage: string, inputHash: string,
  ): Promise<T | undefined> {
    return inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal, document);
      const result = await client.query<{ result: T | string }>(
        `SELECT result FROM pd_processing_receipts WHERE tenant_id = $1 AND task_id = $2 AND stage = $3 AND input_hash = $4`,
        [task.tenant_id, task.id, stage, inputHash],
      );
      return result.rows[0] ? parseJson(result.rows[0].result) : undefined;
    });
  }

  private async persistPipelineReceipt(
    task: TaskRow, request: DocumentRequest, principal: Principal,
    document: IndexDocumentRef, stage: string, inputHash: string, result: unknown,
  ): Promise<void> {
    await inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal, document);
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, stage, inputHash, JSON.stringify(result)],
      );
    });
  }

  private validateEmbeddings(vectors: number[][], count: number, dimensions: number): void {
    if (!Array.isArray(vectors) || vectors.length !== count || vectors.some(vector =>
      !Array.isArray(vector) || vector.length !== dimensions || vector.some(value => typeof value !== 'number' || !Number.isFinite(value)))) {
      throw new DomainError('EMBEDDING_DIMENSION_MISMATCH', `Expected ${count} finite embedding vectors with ${dimensions} dimensions.`);
    }
  }

  private async readEmbeddingCache(
    task: TaskRow, request: DocumentRequest, principal: Principal, document: IndexDocumentRef, contentHashes: string[],
  ): Promise<Array<number[] | undefined>> {
    const pipeline = this.pipeline!;
    return inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal, document);
      const cached = await client.query<{ content_hash: string; embedding_text: string }>(
        `SELECT content_hash, embedding::text AS embedding_text FROM pd_embedding_cache
         WHERE tenant_id = $1 AND profile_id = $2 AND profile_version = $3 AND dimensions = $4
           AND content_hash = ANY($5::text[])`,
        [task.tenant_id, pipeline.profile.id, pipeline.profile.version, pipeline.profile.dimensions, contentHashes],
      );
      const byHash = new Map(cached.rows.map(row => [row.content_hash, row.embedding_text]));
      return contentHashes.map(hash => {
        const text = byHash.get(hash);
        if (!text) return undefined;
        const values = text.slice(1, -1).split(',').map(Number);
        if (values.length !== pipeline.profile.dimensions || values.some(value => !Number.isFinite(value))) {
          throw new DomainError('EMBEDDING_CACHE_CORRUPT', 'A cached embedding failed its dimension check.', 500);
        }
        return values;
      });
    });
  }

  private async persistEmbeddingBatch(
    task: TaskRow, request: DocumentRequest, principal: Principal, document: IndexDocumentRef,
    inputHash: string, contentHashes: string[], embeddings: number[][],
  ): Promise<void> {
    const pipeline = this.pipeline!;
    await inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal, document);
      for (let index = 0; index < embeddings.length; index += 1) {
        await client.query(
          `INSERT INTO pd_embedding_cache (tenant_id, profile_id, profile_version, dimensions, content_hash, embedding)
           VALUES ($1, $2, $3, $4, $5, $6::vector) ON CONFLICT DO NOTHING`,
          [task.tenant_id, pipeline.profile.id, pipeline.profile.version, pipeline.profile.dimensions,
            contentHashes[index], `[${embeddings[index]!.join(',')}]`],
        );
      }
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'embedding', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, inputHash, JSON.stringify(embeddings)],
      );
    });
  }

  private toPipelineError(error: unknown, fallbackCode: string, fallbackMessage: string): DomainError {
    if (error instanceof DomainError) return error;
    if (error && typeof error === 'object') {
      const record = error as { code?: unknown; message?: unknown; status?: unknown };
      if (typeof record.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(record.code)) {
        const message = typeof record.message === 'string' && record.message ? record.message : fallbackMessage;
        const retryable = record.status === 429 || (typeof record.status === 'number' && record.status >= 500) ||
          record.code === 'EMBEDDING_RETRY_EXHAUSTED' || record.code === 'EMBEDDING_TIME_BUDGET_EXCEEDED';
        return new DomainError(record.code, message, 422, retryable);
      }
    }
    return new DomainError(fallbackCode, error instanceof Error && error.message ? error.message : fallbackMessage, 422, false);
  }

  private async publishGeneration(
    task: TaskRow, request: DocumentRequest, principal: Principal,
    document: IndexDocumentRef, generationId: string,
    chunks: IndexedChunk[], warnings: string[],
  ): Promise<BusinessResult> {
    const pipeline = this.pipeline!;
    await inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal, document);
      const generation = await client.query<{ state: string; chunk_count: number }>(
        `SELECT state, chunk_count FROM pd_index_generations
         WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND generation_id = $4 FOR UPDATE`,
        [task.tenant_id, document.documentId, document.version, generationId],
      );
      if (!generation.rows[0]) throw new DomainError('INDEX_GENERATION_MISSING', 'The staging generation is missing.', 409);
      if (generation.rows[0].state !== 'ready') {
        // Thirteen bind parameters per row must stay below PostgreSQL's protocol limit.
        for (let start = 0; start < chunks.length; start += indexedChunkInsertBatchSize) {
          const batch = chunks.slice(start, start + indexedChunkInsertBatchSize);
          const values: string[] = [];
          const params: unknown[] = [];
          for (const chunk of batch) {
            const index = params.length;
            const chunkId = sha256(`${generationId}:${chunk.ordinal}:${sha256(chunk.text)}`).slice(0, 40);
            values.push(`($${index + 1}, $${index + 2}, $${index + 3}, $${index + 4}, $${index + 5}, $${index + 6}, $${index + 7}, $${index + 8}, $${index + 9}, $${index + 10}, to_tsvector('simple'::regconfig, $${index + 11}), $${index + 12}, $${index + 13}::vector)`);
            params.push(task.tenant_id, document.knowledgeBaseId, document.documentId, document.version, generationId,
              chunkId, chunk.ordinal, chunk.text, chunk.locator, chunk.lexicalTokens, chunk.lexicalTokens.join(' '), pipeline.profile.dimensions,
              `[${chunk.embedding.join(',')}]`);
          }
          await client.query(
            `INSERT INTO pd_indexed_chunks
              (tenant_id, knowledge_base_id, document_id, version, generation_id, chunk_id, ordinal, text_content, locator, lexical_tokens, lexical_tsv, dimensions, embedding)
             VALUES ${values.join(', ')} ON CONFLICT (tenant_id, generation_id, chunk_id) DO NOTHING`,
            params,
          );
        }
        const count = await client.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM pd_indexed_chunks WHERE tenant_id = $1 AND generation_id = $2`,
          [task.tenant_id, generationId],
        );
        if (Number(count.rows[0]?.count ?? 0) !== chunks.length) {
          throw new DomainError('INDEX_CHUNK_COUNT_MISMATCH', 'The generation does not contain the complete chunk set.', 500);
        }
        await client.query(
          `UPDATE pd_index_generations SET chunk_count = $5, warnings = $6
           WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND generation_id = $4`,
          [task.tenant_id, document.documentId, document.version, generationId, chunks.length, JSON.stringify(warnings)],
        );
      }
    });
    await this.injectFault('index-staged');

    const result = await inTransaction(this.pool, async client => {
      await this.assertPipelineFence(client, task, request, principal, document);
      const generation = await client.query<{ state: string; chunk_count: number }>(
        `SELECT state, chunk_count FROM pd_index_generations
         WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND generation_id = $4 FOR UPDATE`,
        [task.tenant_id, document.documentId, document.version, generationId],
      );
      if (!generation.rows[0] || Number(generation.rows[0].chunk_count) !== chunks.length) {
        throw new DomainError('INDEX_GENERATION_INCOMPLETE', 'The staged generation is incomplete.', 409);
      }
      if (generation.rows[0].state !== 'ready') {
        await client.query(
          `UPDATE pd_index_generations SET state = 'ready', ready_at = now()
           WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND generation_id = $4 AND state = 'staging'`,
          [task.tenant_id, document.documentId, document.version, generationId],
        );
      }
      let published;
      if (request.operation === 'document.update') {
        const reservationTaskId = task.kind === 'ingestion' && task.parent_task_id ? task.parent_task_id : task.id;
        const reservation = await client.query<{ pending_title: string; pending_tags: unknown; pending_source_type: string }>(
          `SELECT pending_title, pending_tags, pending_source_type FROM pd_document_update_reservations
           WHERE tenant_id = $1 AND document_id = $2 AND expected_version = $3 AND reserved_task_id = $4 FOR UPDATE`,
          [task.tenant_id, document.documentId, document.expectedVersion, reservationTaskId],
        );
        const pending = reservation.rows[0];
        if (!pending || !pending.pending_title || !pending.pending_tags || !pending.pending_source_type) {
          throw new DomainError('VERSION_CONFLICT', 'The document update reservation is no longer publishable.', 409);
        }
        const pendingTagsJson = typeof pending.pending_tags === 'string'
          ? pending.pending_tags
          : JSON.stringify(pending.pending_tags);
        published = await client.query(
          `UPDATE pd_documents SET active_version = $4, title = $5, tags = $6, source_type = $7,
             active_generation_id = $8, active_profile_id = $9, active_profile_version = $10,
             active_dimensions = $11, revision = revision + 1
           WHERE tenant_id = $1 AND id = $2 AND active_version = $3 AND revision = $12 AND deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM pd_tasks budget_task
               WHERE budget_task.tenant_id = $1 AND budget_task.id = $13 AND budget_task.state = 'working'
                 AND budget_task.created_at + ($14 * interval '1 millisecond') > clock_timestamp())`,
          [task.tenant_id, document.documentId, document.expectedVersion, document.version,
            pending.pending_title, pendingTagsJson, pending.pending_source_type, generationId,
            pipeline.profile.id, pipeline.profile.version, pipeline.profile.dimensions, document.expectedRevision,
            task.id, this.pipelineTaskDurationMs],
        );
        if (published.rowCount === 1) {
          await client.query(
            `DELETE FROM pd_document_update_reservations WHERE tenant_id = $1 AND document_id = $2
             AND expected_version = $3 AND reserved_task_id = $4`,
            [task.tenant_id, document.documentId, document.expectedVersion, reservationTaskId],
          );
        }
      } else {
        published = await client.query(
          `UPDATE pd_documents SET active_generation_id = $4, active_profile_id = $5,
             active_profile_version = $6, active_dimensions = $7, revision = revision + 1
           WHERE tenant_id = $1 AND id = $2 AND active_version = $3 AND deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM pd_tasks budget_task
               WHERE budget_task.tenant_id = $1 AND budget_task.id = $8 AND budget_task.state = 'working'
                 AND budget_task.created_at + ($9 * interval '1 millisecond') > clock_timestamp())`,
          [task.tenant_id, document.documentId, document.version, generationId,
            pipeline.profile.id, pipeline.profile.version, pipeline.profile.dimensions, task.id, this.pipelineTaskDurationMs],
        );
      }
      if (published.rowCount !== 1) {
        const deadline = await client.query<{ expired: boolean }>(
          `SELECT created_at + ($3 * interval '1 millisecond') <= clock_timestamp() AS expired
           FROM pd_tasks WHERE tenant_id = $1 AND id = $2`,
          [task.tenant_id, task.id, this.pipelineTaskDurationMs],
        );
        if (deadline.rows[0]?.expired) throw pipelineTaskBudgetError();
        throw new DomainError('VERSION_CONFLICT', 'The document changed before its index could be published.', 409);
      }
      const result = success(request, {
        documentId: document.documentId,
        knowledgeBaseId: document.knowledgeBaseId,
        version: document.version,
        sha256: document.sha256,
        indexState: 'ready',
        generationId,
      });
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, task.payload_hash, result],
      );
      await this.finishTask(client, task, 'completed', result);
      return result;
    });
    await this.injectFault('index-published');
    return result;
  }

  private async failPipelineTask(
    task: TaskRow, request: DocumentRequest, error: DomainError,
    document?: IndexDocumentRef,
  ): Promise<BusinessResult> {
    return inTransaction(this.pool, async client => {
      const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [task.tenant_id, task.id]);
      const current = selected.rows[0];
      if (!current) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
      if (isTerminal(current.state)) {
        if (current.state === 'canceled') await this.releaseUpdateArtifacts(client, current, request);
        if (current.state === 'canceled' && document && this.pipeline) {
          await client.query(
            `UPDATE pd_index_generations SET state = 'canceled'
             WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND source_sha256 = $4 AND state = 'staging'`,
            [task.tenant_id, document.documentId, document.version, document.sha256],
          );
        }
        return current.result ? parseJson(current.result) : failure(request, current.state === 'canceled' ? 'CANCELED' : 'TASK_FAILED', 'Task is already terminal.');
      }
      const result = failure(request, error.code, error.message, error.retryable);
      await this.releaseUpdateArtifacts(client, current, request);
      if (document && this.pipeline) {
        await client.query(
          `UPDATE pd_index_generations SET state = $5
           WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND source_sha256 = $4 AND state = 'staging'`,
          [task.tenant_id, document.documentId, document.version, document.sha256, error.code === 'CANCELED' ? 'canceled' : 'failed'],
        );
      }
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, task.payload_hash, result],
      );
      await this.finishTask(client, current, error.code === 'CANCELED' ? 'canceled' : 'failed', result);
      return result;
    });
  }

  private async executeSearchPipeline(
    task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.search' }>, principal: Principal, signal: AbortSignal,
  ): Promise<BusinessResult> {
    const pipeline = this.pipeline!;
    const mode = request.input.mode ?? 'hybrid';
    const tokens = pipeline.tokenize(request.input.query);
    let queryVector: number[] | undefined;
    let embeddingFailure: DomainError | undefined;
    if (mode !== 'keyword') {
      try {
        const vectors = await pipeline.embed([request.input.query], signal);
        this.validateEmbeddings(vectors, 1, pipeline.profile.dimensions);
        queryVector = vectors[0];
      } catch (error) {
        if (signal.aborted) throw new DomainError('CANCELED', 'Search was canceled during embedding.', 409);
        embeddingFailure = this.toPipelineError(error, 'EMBEDDING_UNAVAILABLE', 'Query embedding failed.');
        if (mode === 'semantic' || !tokens.length) throw embeddingFailure;
      }
    }
    const knowledgeBaseId = request.knowledgeBaseId;
    const filters = request.input.filters ?? {};
    const documentIds = filters.documentIds?.length ? filters.documentIds : null;
    const tags = filters.tags?.length ? filters.tags : null;
    const sourceTypes = filters.sourceTypes?.length ? filters.sourceTypes : null;
    const candidateLimit = 200;
    const lexicalText = lexicalQuery(request.input.query, tokens);
    const lexicalParser = lexicalText.syntax === 'plain' ? 'plainto_tsquery' : 'to_tsquery';
    const contentUriFor = (documentId: string, version: number) => {
      const uri = new URL(`/v1/documents/${encodeURIComponent(documentId)}/content`, this.publicBaseUrl);
      uri.searchParams.set('version', String(version));
      return uri.toString();
    };

    return inTransaction(this.pool, async client => {
      if (signal.aborted) throw new DomainError('CANCELED', 'Search was canceled before retrieval.', 409);
      const currentTask = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [task.tenant_id, task.id]);
      if (currentTask.rows[0]?.state !== 'working') throw new DomainError(currentTask.rows[0]?.state === 'canceled' ? 'CANCELED' : 'TASK_NOT_WORKING', 'Search task is no longer active.', 409);
      assertPipelineTaskWithinBudget(currentTask.rows[0]!, this.pipelineTaskDurationMs);
      const current = await activePrincipal(client, task.tenant_id, task.principal_id);
      await ensureKnowledgeBaseAccess(client, current, knowledgeBaseId, 'knowledge:read');
      await assertTaskResourcesAccessible(client, task.id, current, 'knowledge:read');
      const configured = await client.query<{ dimensions: number }>(`SELECT dimensions FROM pd_vector_configuration WHERE singleton = true`);
      if (!configured.rows[0] || Number(configured.rows[0].dimensions) !== pipeline.profile.dimensions) {
        throw new DomainError('VECTOR_DIMENSION_MISMATCH', 'The configured vector schema does not match the embedding pipeline.', 409);
      }

      const lexicalRows = mode !== 'semantic' && lexicalText.text.length
        ? await client.query<{
          document_id: string; version: number; generation_id: string; chunk_id: string; title: string;
          text_content: string; locator: Record<string, unknown> | string; source_uri: string | null; score: number;
        }>(
          `SELECT d.id AS document_id, c.version, c.generation_id, c.chunk_id, d.title, c.text_content, c.locator, v.source_uri,
             ts_rank_cd(c.lexical_tsv, ${lexicalParser}('simple', $7)) AS score
           FROM pd_indexed_chunks c
           JOIN pd_documents d ON d.tenant_id = c.tenant_id AND d.id = c.document_id
           JOIN pd_document_versions v ON v.tenant_id = c.tenant_id AND v.document_id = c.document_id AND v.version = c.version
           JOIN pd_index_generations g ON g.tenant_id = c.tenant_id AND g.document_id = c.document_id
             AND g.version = c.version AND g.generation_id = c.generation_id
           WHERE c.tenant_id = $1 AND c.knowledge_base_id = $2 AND c.dimensions = $5 AND g.profile_id = $3 AND g.profile_version = $4
             AND g.dimensions = $5 AND g.state = 'ready' AND d.deleted_at IS NULL
             AND d.active_version = c.version AND d.active_generation_id = c.generation_id
             AND d.active_profile_id = $3 AND d.active_profile_version = $4 AND d.active_dimensions = $5
             AND ($6::text[] IS NULL OR d.id = ANY($6::text[]))
             AND ($8::text[] IS NULL OR d.tags ?| $8::text[])
             AND ($9::text[] IS NULL OR d.source_type = ANY($9::text[]))
             AND c.lexical_tsv @@ ${lexicalParser}('simple', $7)
           ORDER BY score DESC, c.chunk_id LIMIT $10`,
          [task.tenant_id, knowledgeBaseId, pipeline.profile.id, pipeline.profile.version, pipeline.profile.dimensions,
            documentIds, lexicalText.text, tags, sourceTypes, candidateLimit],
        )
        : { rows: [] as Array<{ document_id: string; version: number; generation_id: string; chunk_id: string; title: string; text_content: string; locator: Record<string, unknown> | string; source_uri: string | null; score: number }> };

      const vectorRows = mode !== 'keyword' && queryVector
        ? await client.query<{
          document_id: string; version: number; generation_id: string; chunk_id: string; title: string;
          text_content: string; locator: Record<string, unknown> | string; source_uri: string | null; distance: number;
        }>(
          `SELECT d.id AS document_id, c.version, c.generation_id, c.chunk_id, d.title, c.text_content, c.locator, v.source_uri,
             c.embedding <=> $7::vector AS distance
           FROM pd_indexed_chunks c
           JOIN pd_documents d ON d.tenant_id = c.tenant_id AND d.id = c.document_id
           JOIN pd_document_versions v ON v.tenant_id = c.tenant_id AND v.document_id = c.document_id AND v.version = c.version
           JOIN pd_index_generations g ON g.tenant_id = c.tenant_id AND g.document_id = c.document_id
             AND g.version = c.version AND g.generation_id = c.generation_id
           WHERE c.tenant_id = $1 AND c.knowledge_base_id = $2 AND c.dimensions = $5 AND g.profile_id = $3 AND g.profile_version = $4
             AND g.dimensions = $5 AND g.state = 'ready' AND d.deleted_at IS NULL
             AND d.active_version = c.version AND d.active_generation_id = c.generation_id
             AND d.active_profile_id = $3 AND d.active_profile_version = $4 AND d.active_dimensions = $5
             AND ($6::text[] IS NULL OR d.id = ANY($6::text[]))
             AND ($8::text[] IS NULL OR d.tags ?| $8::text[])
             AND ($9::text[] IS NULL OR d.source_type = ANY($9::text[]))
           ORDER BY c.embedding <=> $7::vector, c.chunk_id LIMIT $10`,
          [task.tenant_id, knowledgeBaseId, pipeline.profile.id, pipeline.profile.version, pipeline.profile.dimensions,
            documentIds, `[${queryVector.join(',')}]`, tags, sourceTypes, candidateLimit],
        )
        : { rows: [] as Array<{ document_id: string; version: number; generation_id: string; chunk_id: string; title: string; text_content: string; locator: Record<string, unknown> | string; source_uri: string | null; distance: number }> };

      type Candidate = {
        document_id: string; version: number; generation_id: string; chunk_id: string; title: string;
        text_content: string; locator: Record<string, unknown> | string; source_uri: string | null; score: number;
      };
      const candidateById = new Map<string, Candidate>();
      const lexicalRanking = lexicalRows.rows.map((row, index) => {
        candidateById.set(row.chunk_id, { ...row, score: Number(row.score) });
        return { chunkId: row.chunk_id, rank: index + 1 };
      });
      const vectorRanking = vectorRows.rows.map((row, index) => {
        candidateById.set(row.chunk_id, { ...row, score: 1 - Number(row.distance) });
        return { chunkId: row.chunk_id, rank: index + 1 };
      });
      let ranked: Array<{ chunkId: string; rank: number; score: number; scoreType: 'rrf' | 'cosine' | 'lexical' }>;
      let actualMode = mode;
      if (mode === 'hybrid' && !queryVector) {
        actualMode = 'keyword';
        ranked = lexicalRanking.map((entry, index) => ({ ...entry, rank: index + 1, score: Number(lexicalRows.rows[index]?.score ?? 0), scoreType: 'lexical' as const }));
      } else if (mode === 'hybrid') {
        ranked = rrf([lexicalRanking, vectorRanking]).map(item => ({ ...item, scoreType: 'rrf' as const }));
      } else if (mode === 'semantic') {
        ranked = vectorRanking.map((entry, index) => ({ ...entry, rank: index + 1, score: Number(vectorRows.rows[index]?.distance ?? 0) * -1 + 1, scoreType: 'cosine' as const }));
      } else {
        ranked = lexicalRanking.map((entry, index) => ({ ...entry, rank: index + 1, score: Number(lexicalRows.rows[index]?.score ?? 0), scoreType: 'lexical' as const }));
      }
      const topK = request.input.topK ?? 10;
      const hits = ranked.slice(0, topK).flatMap(item => {
        const row = candidateById.get(item.chunkId);
        if (!row) return [];
        const uri = contentUriFor(row.document_id, row.version);
        return [{
          documentId: row.document_id,
          version: row.version,
          generationId: row.generation_id,
          chunkId: row.chunk_id,
          title: row.title,
          snippet: Array.from(row.text_content).slice(0, 800).join(''),
          locator: parseJson(row.locator),
          rank: item.rank,
          scoreType: item.scoreType,
          score: item.score,
          contentUri: uri,
          ...(row.source_uri ? { sourceUri: row.source_uri } : {}),
        }];
      });
      assertPipelineTaskWithinBudget(currentTask.rows[0]!, this.pipelineTaskDurationMs);
      const reasonParts = ['reranker_not_configured'];
      if (embeddingFailure) reasonParts.unshift(`embedding_unavailable:${embeddingFailure.code}`);
      const result = success(request, {
        query: request.input.query,
        results: hits,
        degraded: true,
        degradationReason: reasonParts.join(';'),
        actualMode,
      });
      for (const hit of hits) await this.addTaskDocumentResource(client, task, String(hit.documentId));
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, task.payload_hash, result],
      );
      await this.finishTask(client, task, 'completed', result);
      return result;
    });
  }

  private async executeGetPipeline(
    task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.get' }>, principal: Principal, signal: AbortSignal,
  ): Promise<BusinessResult> {
    const pipeline = this.pipeline!;
    if (signal.aborted) throw new DomainError('CANCELED', 'Document reading was canceled before parsing.', 409);
    const limit = request.input.limit ?? defaultContentPageSize;
    const position = await inTransaction(this.pool, client => this.contentPosition(client, principal, request, limit));
    const content = await this.readContent(principal, request.input.documentId, position.version);
    let parsed: Awaited<ReturnType<DocumentPipeline['parse']>>;
    try {
      parsed = await pipeline.parse(content.bytes, content.mimeType, signal);
    } catch (error) {
      throw this.toPipelineError(error, 'PARSER_FAILED', 'The source parser failed while reading the document.');
    }
    if (signal.aborted) throw new DomainError('CANCELED', 'Document reading was canceled during parsing.', 409);
    if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim()) {
      throw new DomainError('EMPTY_PARSE', 'The document contains no normalized readable text.');
    }
    return inTransaction(this.pool, async client => {
      const currentTask = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [task.tenant_id, task.id]);
      if (currentTask.rows[0]?.state !== 'working') {
        throw new DomainError(currentTask.rows[0]?.state === 'canceled' ? 'CANCELED' : 'TASK_NOT_WORKING', 'Document read task is no longer active.', 409);
      }
      assertPipelineTaskWithinBudget(currentTask.rows[0]!, this.pipelineTaskDurationMs);
      const current = await activePrincipal(client, task.tenant_id, task.principal_id);
      const document = await client.query<{
        knowledge_base_id: string; title: string; active_version: number; version: number; sha256: string; mime_type: string;
      }>(
        `SELECT d.knowledge_base_id, d.title, d.active_version, v.version, v.sha256, v.mime_type
         FROM pd_documents d JOIN pd_document_versions v
           ON v.tenant_id = d.tenant_id AND v.document_id = d.id AND v.version = $3
         WHERE d.tenant_id = $1 AND d.id = $2 AND d.deleted_at IS NULL`,
        [current.tenantId, request.input.documentId, position.version],
      );
      const row = document.rows[0];
      if (!row) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document is not available.', 404);
      await ensureKnowledgeBaseAccess(client, current, row.knowledge_base_id, 'knowledge:read');
      await assertTaskResourcesAccessible(client, task.id, current, 'knowledge:read');
      const version = row.version;
      if (row.sha256 !== content.sha256 || row.mime_type !== content.mimeType) {
        throw new DomainError('CONTENT_VERSION_CHANGED', 'The document version changed while its readable text was being prepared.', 409);
      }
      await this.addTaskResource(client, task, row.knowledge_base_id);
      await this.addTaskDocumentResource(client, task, request.input.documentId);
      const points = Array.from(parsed.text);
      if (position.offset > points.length) throw new DomainError('INVALID_CURSOR', 'Content cursor offset exceeds the selected version.', 400);
      const end = Math.min(position.offset + limit, points.length);
      const truncated = end < points.length;
      const nextCursor = truncated
        ? await this.createContentCursor(client, current, request.input.documentId, version, position.filterHash, end)
        : undefined;
      const ready = await client.query(`SELECT 1 FROM pd_index_generations WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND state = 'ready'`,
        [current.tenantId, request.input.documentId, version]);
      const downloadUri = new URL(`/v1/documents/${encodeURIComponent(request.input.documentId)}/content`, this.publicBaseUrl);
      downloadUri.searchParams.set('version', String(version));
      const result = success(request, {
        documentId: request.input.documentId,
        version,
        title: row.title,
        indexState: ready.rowCount ? 'ready' : 'stored',
        source: { sha256: content.sha256, mimeType: content.mimeType },
        content: { text: points.slice(position.offset, end).join(''), truncated, ...(nextCursor ? { nextCursor } : {}) },
        downloadUri: downloadUri.toString(),
      });
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'execute', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, task.payload_hash, result],
      );
      await this.finishTask(client, task, 'completed', result);
      return result;
    });
  }

  async failTask(id: string, code: string, message: string, retryable: boolean): Promise<BusinessResult> {
    return inTransaction(this.pool, async client => {
      const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE id = $1 FOR UPDATE`, [id]);
      const task = selected.rows[0];
      if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
      const request = parseJson(task.request);
      if (isTerminal(task.state)) {
        return task.result ? parseJson(task.result) : failure(request, task.state === 'canceled' ? 'CANCELED' : code, task.state === 'canceled' ? 'Task was canceled.' : message, retryable);
      }
      const result = failure(request, code, message, retryable);
      await client.query(
        `INSERT INTO pd_processing_receipts (tenant_id, task_id, stage, input_hash, result)
         VALUES ($1, $2, 'runtime-failure', $3, $4) ON CONFLICT DO NOTHING`,
        [task.tenant_id, task.id, sha256(canonicalJson({ code, message, retryable })), result],
      );
      await this.finishTask(client, task, 'failed', result);
      return result;
    });
  }

  async cancel(principal: Principal, id: string): Promise<StoredTask> {
    const canceled = await inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      const selected = await client.query<TaskRow>(`SELECT * FROM pd_tasks WHERE tenant_id = $1 AND id = $2 FOR UPDATE`, [current.tenantId, id]);
      const task = selected.rows[0];
      if (!task || task.principal_id !== current.id) throw new DomainError('TASK_NOT_FOUND', 'Task is not available.', 404);
      if (task.kind === 'purge') throw new DomainError('TASK_NOT_CANCELABLE', 'A purge task cannot be canceled.', 409);
      const taskRequest = parseJson(task.request);
      await assertTaskResourcesAccessible(client, task.id, current, requiredScope(taskRequest));
      const resource = requestedKnowledgeBaseId(taskRequest);
      const scope = requiredScope(taskRequest);
      if (resource) await ensureKnowledgeBaseAccess(client, current, resource, scope);
      if (task.state === 'canceled') return serializeTask(task, current);
      if (isTerminal(task.state)) throw new DomainError('TASK_NOT_CANCELABLE', 'A terminal task cannot be canceled.', 409);
      await this.releaseUpdateArtifacts(client, task, taskRequest);
      const updated = await client.query<TaskRow>(
        `UPDATE pd_tasks SET state = 'canceled', result = NULL, updated_at = now() WHERE id = $1 RETURNING *`, [id],
      );
      if (!updated.rows[0]) throw new Error('TASK_CANCEL_UPDATE_LOST_LOCKED_ROW');
      await client.query(`UPDATE pd_outbox SET delivered_at = COALESCE(delivered_at, now()) WHERE task_id = $1 AND event_type = 'dispatch'`, [id]);
      return serializeTask(updated.rows[0], current);
    });
    await this.injectFault('cancel-accepted');
    return canceled;
  }

  async readContent(principal: Principal, id: string, version?: number): Promise<{ bytes: Buffer; mimeType: string; sha256: string }> {
    return this.readContentInternal(principal, id, version, false);
  }

  private async readIndexContent(
    principal: Principal, document: IndexDocumentRef,
  ): Promise<{ bytes: Buffer; mimeType: string; sha256: string }> {
    return this.readContentInternal(principal, document.documentId, document.version, document.expectedVersion !== undefined);
  }

  private async readContentInternal(
    principal: Principal, id: string, version: number | undefined, allowInactiveVersion: boolean,
  ): Promise<{ bytes: Buffer; mimeType: string; sha256: string }> {
    return inTransaction(this.pool, async client => {
      const current = await activePrincipal(client, principal.tenantId, principal.id);
      const document = await this.loadDocument(client, current, id, version, 'knowledge:read', allowInactiveVersion);
      const bytes = await readFile(this.resolveBlobPath(document.relative_path));
      const actualHash = sha256(bytes);
      if (actualHash !== document.sha256 || bytes.byteLength !== Number(document.byte_size)) {
        throw new DomainError('CONTENT_HASH_MISMATCH', 'Stored content failed its integrity check.', 500);
      }
      return { bytes, mimeType: document.mime_type, sha256: actualHash };
    });
  }

  private async executeOperation(client: PoolClient, task: TaskRow, request: DocumentRequest, principal: Principal): Promise<BusinessResult> {
    switch (request.operation) {
      case 'knowledge_base.create': return this.createKnowledgeBase(client, task, request, principal);
      case 'knowledge_base.list': return this.listKnowledgeBases(client, task, request, principal);
      case 'document.save': return this.saveDocument(client, task, request, principal);
      case 'document.update': return this.saveUpdatedDocument(client, task, request, principal);
      case 'document.search': return failure(request, 'INDEXING_NOT_AVAILABLE', 'Search requires an indexing pipeline.', false);
      case 'document.get': return this.getDocument(client, task, request, principal);
      case 'document.list': return this.listDocuments(client, task, request, principal);
      default: return failure(request, 'OPERATION_NOT_IMPLEMENTED', `${request.operation} is not implemented by this M1 backend.`);
    }
  }

  private async finishTask(client: PoolClient, task: TaskRow, state: TaskState, result: BusinessResult): Promise<void> {
    await client.query(
      `UPDATE pd_tasks SET state = $2, result = $3, updated_at = now() WHERE tenant_id = $1 AND id = $4`,
      [task.tenant_id, state, result, task.id],
    );
    await client.query(
      `UPDATE pd_outbox SET delivered_at = COALESCE(delivered_at, now()) WHERE tenant_id = $1 AND task_id = $2 AND event_type = 'dispatch'`,
      [task.tenant_id, task.id],
    );
  }

  private async addTaskResource(client: PoolClient, task: TaskRow, knowledgeBaseId: string): Promise<void> {
    await client.query(
      `INSERT INTO pd_task_resources (tenant_id, task_id, knowledge_base_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [task.tenant_id, task.id, knowledgeBaseId],
    );
  }

  private async addTaskDocumentResource(client: PoolClient, task: TaskRow, documentId: string): Promise<void> {
    await client.query(
      `INSERT INTO pd_task_document_resources (tenant_id, task_id, document_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [task.tenant_id, task.id, documentId],
    );
  }

  private async releaseUpdateArtifacts(client: Queryable, task: TaskRow, request: DocumentRequest): Promise<void> {
    if (request.operation !== 'document.update') return;
    const reservationTaskId = task.kind === 'ingestion' && task.parent_task_id ? task.parent_task_id : task.id;
    const reservation = await client.query<{ target_version: number; expected_version: number; document_id: string }>(
      `SELECT target_version, expected_version, document_id FROM pd_document_update_reservations
       WHERE tenant_id = $1 AND reserved_task_id = $2 FOR UPDATE`,
      [task.tenant_id, reservationTaskId],
    );
    const row = reservation.rows[0];
    if (!row) return;
    await client.query(
      `DELETE FROM pd_document_versions v USING pd_documents d
       WHERE v.tenant_id = $1 AND v.document_id = $2 AND v.version = $3
         AND d.tenant_id = v.tenant_id AND d.id = v.document_id
         AND (d.active_version = $4 OR d.deleted_at IS NOT NULL)`,
      [task.tenant_id, row.document_id, row.target_version, row.expected_version],
    );
    await client.query(
      `DELETE FROM pd_document_update_reservations WHERE tenant_id = $1 AND document_id = $2 AND expected_version = $3`,
      [task.tenant_id, row.document_id, row.expected_version],
    );
  }

  private async createKnowledgeBase(
    client: PoolClient, task: TaskRow, request: Extract<DocumentRequest, { operation: 'knowledge_base.create' }>, principal: Principal,
  ): Promise<BusinessResult> {
    await ensureGlobalScope(principal, 'knowledge:write');
    const knowledgeBaseId = randomUUID();
    await client.query(
      `INSERT INTO pd_knowledge_bases (tenant_id, id, name, description, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [principal.tenantId, knowledgeBaseId, request.input.name, request.input.description ?? '', principal.id],
    );
    await client.query(
      `INSERT INTO pd_knowledge_base_members (tenant_id, knowledge_base_id, principal_id, scopes) VALUES ($1, $2, $3, $4)`,
      [principal.tenantId, knowledgeBaseId, principal.id, allKbScopes],
    );
    await this.addTaskResource(client, task, knowledgeBaseId);
    return success(request, { knowledgeBaseId, name: request.input.name });
  }

  private async listKnowledgeBases(
    client: PoolClient, task: TaskRow, request: Extract<DocumentRequest, { operation: 'knowledge_base.list' }>, principal: Principal,
  ): Promise<BusinessResult> {
    await ensureGlobalScope(principal, 'knowledge:read');
    const limit = request.input.limit ?? 20;
    const filterHash = makeCursorFilterHash({ kind: 'knowledge_bases', tenantId: principal.tenantId, principalId: principal.id });
    const cursorState = await this.cursorAfterId(client, principal, 'knowledge_bases', null, filterHash, request.input.cursor);
    const afterId = cursorState?.lastId;
    const snapshotAt = cursorState?.snapshotAt ?? new Date();
    const rows = await client.query<KnowledgeBaseRow>(
      `SELECT kb.id, kb.name
       FROM pd_knowledge_bases kb
       WHERE kb.tenant_id = $1 AND kb.created_at <= $5 AND ($2::text IS NULL OR kb.id > $2)
         AND ($3::boolean OR EXISTS (
           SELECT 1 FROM pd_knowledge_base_members m
           WHERE m.tenant_id = kb.tenant_id AND m.knowledge_base_id = kb.id AND m.principal_id = $4
             AND m.scopes @> ARRAY['knowledge:read']::text[]
         ))
       ORDER BY kb.id LIMIT $6`,
      [principal.tenantId, afterId ?? null, principal.scopes.includes('knowledge:admin'), principal.id, snapshotAt, limit + 1],
    );
    const hasMore = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    for (const row of page) await this.addTaskResource(client, task, row.id);
    const nextCursor = hasMore
      ? await this.createCursor(client, principal, 'knowledge_bases', null, filterHash, page.at(-1)!.id, snapshotAt)
      : undefined;
    return success(request, {
      knowledgeBases: page.map(row => ({ knowledgeBaseId: row.id, name: row.name })),
      ...(nextCursor ? { nextCursor } : {}),
    });
  }

  private async saveDocument(
    client: PoolClient, task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.save' }>, principal: Principal,
  ): Promise<BusinessResult> {
    const indexed = request.input.waitFor === 'indexed';
    if (indexed && !this.pipeline) {
      throw new DomainError('INDEXING_NOT_AVAILABLE', 'No document indexing pipeline is configured.', 400);
    }
    await ensureKnowledgeBaseAccess(client, principal, request.knowledgeBaseId, 'knowledge:write');
    const source = await this.resolveSource(client, task, request, principal);
    return this.saveResolvedDocument(client, task, request, principal, source);
  }

  private async resolveSource(
    client: PoolClient, task: TaskRow, request: SaveOrUpdateRequest, principal: Principal,
  ): Promise<ResolvedSource> {
    let source: ResolvedSource;
    if (request.input.source.kind === 'text') {
      const bytes = Buffer.from(request.input.source.text, 'utf8');
      if (bytes.byteLength > 262_144) throw new DomainError('SIZE_LIMIT', 'Inline text exceeds 256 KiB.', 413);
      source = {
        bytes,
        mimeType: normalizeSourceMime(request.input.source.mimeType ?? 'text/plain'),
        sourceType: 'text',
      };
    } else if (request.input.source.kind === 'upload') {
      const upload = await client.query<{
        sha256: string; mime_type: string; blob_mime_type: string; byte_size: string | number; expires_at: Date | string; relative_path: string;
      }>(
        `SELECT u.sha256, u.mime_type, b.mime_type AS blob_mime_type, u.byte_size, u.expires_at, b.relative_path
         FROM pd_uploads u JOIN pd_blobs b ON b.tenant_id = u.tenant_id AND b.sha256 = u.sha256
         WHERE u.tenant_id = $1 AND u.upload_id = $2 AND u.principal_id = $3 AND u.knowledge_base_id = $4`,
        [principal.tenantId, request.input.source.uploadId, principal.id, request.knowledgeBaseId],
      );
      const row = upload.rows[0];
      if (!row) throw new DomainError('INVALID_UPLOAD', 'The upload is not available to this principal and knowledge base.', 400);
      if (new Date(row.expires_at).getTime() <= Date.now()) throw new DomainError('UPLOAD_EXPIRED', 'The upload has expired.', 400);
      if (row.mime_type !== row.blob_mime_type) throw new DomainError('INVALID_UPLOAD', 'The uploaded source media type failed its integrity check.', 400);
      const mimeType = normalizeSourceMime(row.mime_type);
      const bytes = await readFile(this.resolveBlobPath(row.relative_path));
      if (bytes.byteLength !== Number(row.byte_size) || sha256(bytes) !== row.sha256) {
        throw new DomainError('INVALID_UPLOAD', 'The uploaded source failed its size or hash check.', 400);
      }
      validateSourceBytes(bytes, mimeType);
      source = { bytes, mimeType, sourceType: 'upload', sourceUploadId: request.input.source.uploadId };
    } else {
      throw new DomainError('SOURCE_FETCH_REQUIRED', 'URL sources must be fetched before entering a database transaction.');
    }
    return source;
  }

  private async saveUpdatedDocument(
    client: PoolClient, task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.update' }>, principal: Principal,
    resolvedSource?: ResolvedSource,
  ): Promise<BusinessResult> {
    if (request.input.waitFor === 'indexed' && !this.pipeline) {
      throw new DomainError('INDEXING_NOT_AVAILABLE', 'No document indexing pipeline is configured.', 400);
    }
    await ensureKnowledgeBaseAccess(client, principal, request.knowledgeBaseId, 'knowledge:write');
    const source = resolvedSource ?? await this.resolveSource(client, task, request, principal);
    const current = await client.query<{
      id: string; knowledge_base_id: string; title: string; tags: string[] | string; active_version: number; revision: string | number;
    }>(
      `SELECT id, knowledge_base_id, title, tags, active_version, revision FROM pd_documents
       WHERE tenant_id = $1 AND id = $2 AND knowledge_base_id = $3 AND deleted_at IS NULL FOR UPDATE`,
      [task.tenant_id, request.input.documentId, request.knowledgeBaseId],
    );
    const document = current.rows[0];
    if (!document) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document is not available.', 404);
    if (document.active_version !== request.input.expectedVersion) throw new DomainError('VERSION_CONFLICT', 'The expected document version is no longer active.', 409);
    const reservationTaskId = task.kind === 'ingestion' && task.parent_task_id ? task.parent_task_id : task.id;
    const reservation = await client.query<{
      expected_revision: string | number; target_version: number; reserved_task_id: string;
    }>(
      `SELECT expected_revision, target_version, reserved_task_id FROM pd_document_update_reservations
       WHERE tenant_id = $1 AND document_id = $2 AND expected_version = $3 FOR UPDATE`,
      [task.tenant_id, document.id, request.input.expectedVersion],
    );
    if (!reservation.rows[0] || reservation.rows[0].reserved_task_id !== reservationTaskId ||
      Number(reservation.rows[0].expected_revision) !== Number(document.revision)) {
      throw new DomainError('VERSION_CONFLICT', 'The document update reservation is stale.', 409);
    }
    const targetVersion = Number(reservation.rows[0].target_version);
    const { digest } = await this.storeBlob(client, task, principal.tenantId, source);
    const tags = request.input.tags ?? parseJson(document.tags);
    const title = request.input.title ?? document.title;
    await client.query(
      `INSERT INTO pd_document_versions
        (tenant_id, document_id, version, sha256, mime_type, byte_size, created_by, source_uri, fetched_at, source_upload_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [task.tenant_id, document.id, targetVersion, digest, source.mimeType, source.bytes.byteLength, principal.id,
        source.sourceUri ?? null, source.fetchedAt ? new Date(source.fetchedAt) : null, source.sourceUploadId ?? null],
    );
    await client.query(
      `UPDATE pd_document_update_reservations SET pending_title = $4, pending_tags = $5, pending_source_type = $6
       WHERE tenant_id = $1 AND document_id = $2 AND expected_version = $3`,
      [task.tenant_id, document.id, request.input.expectedVersion, title, JSON.stringify(tags), source.sourceType],
    );
    await this.addTaskResource(client, task, request.knowledgeBaseId);
    await this.addTaskDocumentResource(client, task, document.id);

    let ingestionTaskId: string | undefined;
    if (request.input.waitFor !== 'indexed') {
      ingestionTaskId = randomUUID();
      const child = await client.query<TaskRow>(
        `INSERT INTO pd_tasks
          (id, tenant_id, principal_id, context_id, operation, request_id, payload_hash, request, kind, parent_task_id, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ingestion', $9, 'submitted') RETURNING *`,
        [ingestionTaskId, task.tenant_id, task.principal_id, task.context_id, request.operation, task.request_id,
          task.payload_hash, request, task.id],
      );
      await this.addTaskResource(client, { ...task, id: ingestionTaskId }, request.knowledgeBaseId);
      await this.addTaskDocumentResource(client, { ...task, id: ingestionTaskId }, document.id);
      await client.query(
        `INSERT INTO pd_outbox (event_id, tenant_id, task_id, event_type, payload)
         VALUES ($1, $2, $3, 'dispatch', $4)`,
        [randomUUID(), task.tenant_id, ingestionTaskId, { taskId: ingestionTaskId, parentTaskId: task.id }],
      );
      if (!child.rows[0]) throw new Error('UPDATE_INGESTION_TASK_INSERT_FAILED');
    }
    return success(request, {
      documentId: document.id,
      knowledgeBaseId: document.knowledge_base_id,
      version: targetVersion,
      indexState: ingestionTaskId ? 'stored' : 'indexing',
      sha256: digest,
      ...(ingestionTaskId ? { ingestionTaskId } : {}),
    });
  }

  private async saveResolvedDocument(
    client: PoolClient, task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.save' }>, principal: Principal,
    source: ResolvedSource,
  ): Promise<BusinessResult> {
    const indexed = request.input.waitFor === 'indexed';
    const bytes = source.bytes;
    const mimeType = normalizeSourceMime(source.mimeType);
    validateSourceBytes(bytes, mimeType, source.sourceType === 'upload' ? 'INVALID_UPLOAD' : source.sourceType === 'url' ? 'SOURCE_FETCH_FAILED' : 'INVALID_SOURCE');
    if (source.sourceType === 'text' && bytes.byteLength > 262_144) throw new DomainError('SIZE_LIMIT', 'Inline text exceeds 256 KiB.', 413);
    const { digest } = await this.storeBlob(client, task, principal.tenantId, source);

    const documentId = randomUUID();
    const version = 1;
    const tags = request.input.tags ?? [];
    await client.query(
      `INSERT INTO pd_documents
        (tenant_id, id, knowledge_base_id, title, tags, source_type, active_version, created_by, created_by_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [principal.tenantId, documentId, request.knowledgeBaseId, request.input.title, JSON.stringify(tags), source.sourceType,
        version, principal.id, task.id],
    );
    await client.query(
      `INSERT INTO pd_document_versions
        (tenant_id, document_id, version, sha256, mime_type, byte_size, created_by, source_uri, fetched_at, source_upload_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [principal.tenantId, documentId, version, digest, mimeType, bytes.byteLength, principal.id,
        source.sourceUri ?? null, source.fetchedAt ? new Date(source.fetchedAt) : null, source.sourceUploadId ?? null],
    );
    await this.addTaskResource(client, task, request.knowledgeBaseId);
    await this.addTaskDocumentResource(client, task, documentId);

    let ingestionTaskId: string | undefined;
    if (!indexed) {
      ingestionTaskId = randomUUID();
      const child = await client.query<TaskRow>(
        `INSERT INTO pd_tasks
          (id, tenant_id, principal_id, context_id, operation, request_id, payload_hash, request, kind, parent_task_id, state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ingestion', $9, 'submitted') RETURNING *`,
        [ingestionTaskId, task.tenant_id, task.principal_id, task.context_id, request.operation, task.request_id,
          task.payload_hash, request, task.id],
      );
      if (!child.rows[0]) throw new Error('INGESTION_TASK_INSERT_FAILED');
      await this.addTaskResource(client, child.rows[0], request.knowledgeBaseId);
      await this.addTaskDocumentResource(client, child.rows[0], documentId);
      await client.query(
        `INSERT INTO pd_outbox (event_id, tenant_id, task_id, event_type, payload)
         VALUES ($1, $2, $3, 'dispatch', $4)`,
        [randomUUID(), task.tenant_id, ingestionTaskId, { taskId: ingestionTaskId, parentTaskId: task.id }],
      );
    }
    return success(request, {
      documentId,
      knowledgeBaseId: request.knowledgeBaseId,
      version,
      indexState: indexed ? 'indexing' : 'stored',
      sha256: digest,
      ...(ingestionTaskId ? { ingestionTaskId } : {}),
    });
  }

  private async storeBlob(
    client: PoolClient, task: TaskRow, tenantId: string, source: ResolvedSource,
  ): Promise<{ digest: string; relativePath: string }> {
    const bytes = source.bytes;
    const mimeType = normalizeSourceMime(source.mimeType);
    const digest = sha256(bytes);
    const relativePath = await this.writeBlob(tenantId, digest, bytes);
    await this.injectFault('blob-written');
    await client.query(
      `INSERT INTO pd_blobs (tenant_id, sha256, relative_path, mime_type, byte_size)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, sha256) DO NOTHING`,
      [tenantId, digest, relativePath, mimeType, bytes.byteLength],
    );
    const blob = await client.query<{ relative_path: string; mime_type: string; byte_size: string | number }>(
      `SELECT relative_path, mime_type, byte_size FROM pd_blobs WHERE tenant_id = $1 AND sha256 = $2 FOR UPDATE`,
      [tenantId, digest],
    );
    const row = blob.rows[0];
    if (!row || row.relative_path !== relativePath || row.mime_type !== mimeType || Number(row.byte_size) !== bytes.byteLength) {
      throw new DomainError('BLOB_METADATA_CONFLICT', 'Content-addressed blob metadata does not match.', 500);
    }
    return { digest, relativePath };
  }

  private async getDocument(
    client: PoolClient, task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.get' }>, principal: Principal,
  ): Promise<BusinessResult> {
    const limit = request.input.limit ?? defaultContentPageSize;
    const position = await this.contentPosition(client, principal, request, limit);
    const document = await this.loadDocument(client, principal, request.input.documentId, position.version, 'knowledge:read');
    await this.addTaskResource(client, task, document.knowledge_base_id);
    await this.addTaskDocumentResource(client, task, document.id);
    if (!this.pipeline && !['text/plain', 'text/markdown', 'text/x-markdown', 'text/html'].includes(document.mime_type)) {
      throw new DomainError('INDEXING_NOT_AVAILABLE', 'A parser pipeline is required to return normalized text for this file type.', 409);
    }
    const bytes = await readFile(this.resolveBlobPath(document.relative_path));
    const digest = sha256(bytes);
    if (digest !== document.sha256 || bytes.byteLength !== Number(document.byte_size)) {
      throw new DomainError('CONTENT_HASH_MISMATCH', 'Stored content failed its integrity check.', 500);
    }
    const points = Array.from(bytes.toString('utf8'));
    if (position.offset > points.length) throw new DomainError('INVALID_CURSOR', 'Content cursor offset exceeds the selected version.', 400);
    const end = Math.min(position.offset + limit, points.length);
    const truncated = end < points.length;
    const nextCursor = truncated
      ? await this.createContentCursor(client, principal, document.id, document.version, position.filterHash, end)
      : undefined;
    const contentUri = new URL(`/v1/documents/${encodeURIComponent(document.id)}/content`, this.publicBaseUrl);
    contentUri.searchParams.set('version', String(document.version));
    let indexState = 'stored';
    if (this.pipeline) {
      const active = await client.query(
        `SELECT 1 FROM pd_index_generations WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND state = 'ready'`,
        [principal.tenantId, document.id, document.version],
      );
      if (active.rowCount) indexState = 'ready';
    }
    return success(request, {
      documentId: document.id,
      version: document.version,
      title: document.title,
      indexState,
      source: { sha256: digest, mimeType: document.mime_type },
      content: { text: points.slice(position.offset, end).join(''), truncated, ...(nextCursor ? { nextCursor } : {}) },
      downloadUri: contentUri.toString(),
    });
  }

  private async listDocuments(
    client: PoolClient, task: TaskRow, request: Extract<DocumentRequest, { operation: 'document.list' }>, principal: Principal,
  ): Promise<BusinessResult> {
    await ensureKnowledgeBaseAccess(client, principal, request.knowledgeBaseId, 'knowledge:read');
    const limit = request.input.limit ?? 20;
    const filters = request.input.filters ?? {};
    const filterHash = makeCursorFilterHash({
      kind: 'documents', tenantId: principal.tenantId, principalId: principal.id,
      knowledgeBaseId: request.knowledgeBaseId, filters,
    });
    const cursorState = await this.cursorAfterId(client, principal, 'documents', request.knowledgeBaseId, filterHash, request.input.cursor);
    const afterId = cursorState?.lastId;
    const snapshotAt = cursorState?.snapshotAt ?? new Date();
    const documentIds = filters.documentIds?.length ? filters.documentIds : null;
    const tags = filters.tags?.length ? filters.tags : null;
    const sourceTypes = filters.sourceTypes?.length ? filters.sourceTypes : null;
    const rows = await client.query<{ id: string; title: string; tags: string[] | string; active_version: number; active_generation_id: string | null }>(
      `SELECT id, title, tags, active_version, ${this.pipeline ? 'active_generation_id' : 'NULL::text AS active_generation_id'} FROM pd_documents d
       WHERE tenant_id = $1 AND knowledge_base_id = $2 AND deleted_at IS NULL AND created_at <= $7 AND ($3::text IS NULL OR id > $3)
         AND ($4::text[] IS NULL OR id = ANY($4::text[]))
         AND ($5::text[] IS NULL OR tags ?| $5::text[])
         AND ($6::text[] IS NULL OR source_type = ANY($6::text[]))
       ORDER BY id LIMIT $8`,
      [principal.tenantId, request.knowledgeBaseId, afterId ?? null, documentIds, tags, sourceTypes, snapshotAt, limit + 1],
    );
    const hasMore = rows.rows.length > limit;
    const page = rows.rows.slice(0, limit);
    const nextCursor = hasMore
      ? await this.createCursor(client, principal, 'documents', request.knowledgeBaseId, filterHash, page.at(-1)!.id, snapshotAt)
      : undefined;
    for (const row of page) await this.addTaskDocumentResource(client, task, row.id);
    return success(request, {
      documents: page.map(row => ({
        documentId: row.id,
        version: row.active_version,
        title: row.title,
        indexState: row.active_generation_id ? 'ready' : 'stored',
        tags: parseJson(row.tags),
      })),
      ...(nextCursor ? { nextCursor } : {}),
    });
  }

  private async loadDocument(
    client: Queryable, principal: Principal, documentId: string, version: number | undefined, scope: Scope, allowInactiveVersion = false,
  ): Promise<{ id: string; knowledge_base_id: string; title: string; version: number; sha256: string; mime_type: string; byte_size: string | number; relative_path: string }> {
    const base = await client.query<{ id: string; knowledge_base_id: string; title: string; active_version: number }>(
      `SELECT id, knowledge_base_id, title, active_version FROM pd_documents WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [principal.tenantId, documentId],
    );
    const document = base.rows[0];
    if (!document) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document is not available.', 404);
    await ensureKnowledgeBaseAccess(client, principal, document.knowledge_base_id, scope);
    const selectedVersion = version ?? document.active_version;
    const content = await client.query<{
      version: number; sha256: string; mime_type: string; byte_size: string | number; relative_path: string;
    }>(
      `SELECT v.version, v.sha256, v.mime_type, v.byte_size, b.relative_path
       FROM pd_document_versions v JOIN pd_blobs b ON b.tenant_id = v.tenant_id AND b.sha256 = v.sha256
       JOIN pd_documents d ON d.tenant_id = v.tenant_id AND d.id = v.document_id
       WHERE v.tenant_id = $1 AND v.document_id = $2 AND v.version = $3 AND d.deleted_at IS NULL
         AND ($4::boolean OR v.version <= d.active_version)`,
      [principal.tenantId, documentId, selectedVersion, allowInactiveVersion],
    );
    const versionRow = content.rows[0];
    if (!versionRow) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document version is not available.', 404);
    return { ...document, ...versionRow };
  }

  private resolveBlobPath(relativePath: string): string {
    if (isAbsolute(relativePath)) throw new DomainError('BLOB_PATH_INVALID', 'Blob path is invalid.', 500);
    const target = resolve(this.blobRoot, relativePath);
    const fromRoot = relative(this.blobRoot, target);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new DomainError('BLOB_PATH_INVALID', 'Blob path is outside the configured root.', 500);
    }
    return target;
  }

  private async writeBlob(tenantId: string, digest: string, bytes: Buffer): Promise<string> {
    if (sha256(bytes) !== digest) throw new DomainError('CONTENT_HASH_MISMATCH', 'Content hash changed before storage.', 500);
    const tenantNamespace = sha256(tenantId).slice(0, 32);
    const relativePath = join(tenantNamespace, digest.slice(0, 2), `${digest}.blob`);
    const target = this.resolveBlobPath(relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await access(target);
      const existing = await readFile(target);
      if (sha256(existing) !== digest) throw new DomainError('CONTENT_HASH_MISMATCH', 'Existing content-addressed blob is corrupt.', 500);
      return relativePath.split(sep).join('/');
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const temporary = join(dirname(target), `.${digest}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      if (sha256(await readFile(temporary)) !== digest) throw new DomainError('CONTENT_HASH_MISMATCH', 'Temporary blob failed its hash check.', 500);
      await rename(temporary, target);
      if (sha256(await readFile(target)) !== digest) throw new DomainError('CONTENT_HASH_MISMATCH', 'Stored blob failed its hash check.', 500);
      return relativePath.split(sep).join('/');
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async cursorAfterId(
    client: Queryable, principal: Principal, kind: 'documents' | 'knowledge_bases', knowledgeBaseId: string | null,
    filterHash: string, cursor?: string,
  ): Promise<{ lastId: string; snapshotAt: Date } | undefined> {
    if (!cursor) {
      await pruneExpiredCursorRows(client);
      return undefined;
    }
    const result = await client.query<CursorRow>(
      `SELECT * FROM pd_list_cursors WHERE id = $1 AND tenant_id = $2 AND principal_id = $3`,
      [cursor, principal.tenantId, principal.id],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('INVALID_CURSOR', 'Cursor is invalid for this principal.', 400);
    if (new Date(row.expires_at).getTime() <= Date.now()) throw new DomainError('CURSOR_EXPIRED', 'Cursor has expired; restart the list request.', 400);
    if (row.resource_kind !== kind || row.knowledge_base_id !== knowledgeBaseId || row.filter_hash !== filterHash) {
      throw new DomainError('INVALID_CURSOR', 'Cursor does not match the current list scope or filters.', 400);
    }
    await pruneExpiredCursorRows(client);
    return { lastId: row.last_id, snapshotAt: new Date(row.snapshot_at) };
  }

  private async contentPosition(
    client: Queryable, principal: Principal, request: Extract<DocumentRequest, { operation: 'document.get' }>, limit: number,
  ): Promise<ContentPosition> {
    const document = await client.query<{ knowledge_base_id: string; active_version: number }>(
      `SELECT knowledge_base_id, active_version FROM pd_documents
       WHERE tenant_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [principal.tenantId, request.input.documentId],
    );
    const row = document.rows[0];
    if (!row) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document is not available.', 404);
    await ensureKnowledgeBaseAccess(client, principal, row.knowledge_base_id, 'knowledge:read');
    const filterHash = makeCursorFilterHash({ kind: 'document-content', limit });
    if (request.input.cursor) {
      const result = await client.query<ContentCursorRow>(
        `SELECT version, next_offset, filter_hash, expires_at FROM pd_content_cursors
         WHERE id = $1 AND tenant_id = $2 AND principal_id = $3 AND document_id = $4`,
        [request.input.cursor, principal.tenantId, principal.id, request.input.documentId],
      );
      const cursor = result.rows[0];
      if (!cursor) throw new DomainError('INVALID_CURSOR', 'Content cursor is invalid for this principal and document.', 400);
      if (new Date(cursor.expires_at).getTime() <= Date.now()) throw new DomainError('CURSOR_EXPIRED', 'Content cursor has expired; restart document reading.', 400);
      if (cursor.filter_hash !== filterHash || (request.input.version !== undefined && request.input.version !== cursor.version)) {
        throw new DomainError('INVALID_CURSOR', 'Content cursor does not match the requested version or page size.', 400);
      }
      await pruneExpiredCursorRows(client);
      return { version: cursor.version, offset: cursor.next_offset, filterHash };
    }
    await pruneExpiredCursorRows(client);
    const version = request.input.version ?? row.active_version;
    const available = await client.query(
      `SELECT 1 FROM pd_document_versions WHERE tenant_id = $1 AND document_id = $2 AND version = $3 AND version <= $4`,
      [principal.tenantId, request.input.documentId, version, row.active_version],
    );
    if (!available.rowCount) throw new DomainError('DOCUMENT_NOT_FOUND', 'Document version is not available.', 404);
    return { version, offset: 0, filterHash };
  }

  private async createContentCursor(
    client: PoolClient, principal: Principal, documentId: string, version: number, filterHash: string, nextOffset: number,
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO pd_content_cursors (id, tenant_id, principal_id, document_id, version, filter_hash, next_offset, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, principal.tenantId, principal.id, documentId, version, filterHash, nextOffset, new Date(Date.now() + listCursorLifetimeMs)],
    );
    return id;
  }

  private async createCursor(
    client: Queryable, principal: Principal, kind: 'documents' | 'knowledge_bases', knowledgeBaseId: string | null,
    filterHash: string, lastId: string, snapshotAt: Date,
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO pd_list_cursors (id, tenant_id, principal_id, resource_kind, knowledge_base_id, filter_hash, last_id, snapshot_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, principal.tenantId, principal.id, kind, knowledgeBaseId, filterHash, lastId, snapshotAt, new Date(Date.now() + listCursorLifetimeMs)],
    );
    return id;
  }
}

function isTerminal(state: TaskState): boolean {
  return state === 'completed' || state === 'failed' || state === 'canceled';
}
