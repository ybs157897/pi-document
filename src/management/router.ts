import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type Express, type Request, type RequestHandler, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { DomainError, type GatewayRuntime, type Principal, type Scope } from '../domain/types.js';
import type { DocumentBackend } from '../domain/types.js';

export type ManagementOptions = { naturalEnabled: boolean; publicBaseUrl?: string };

type AuthenticatedRequest = Request & { managementPrincipal?: Principal; managementTokenHash?: Buffer };
type PrincipalRow = { principal_id: string; scopes: Scope[] | string; revoked_at: Date | string | null; created_at: Date | string };
type MemberRow = { principal_id: string; scopes: Scope[] | string };
type Queryable = Pick<PoolClient, 'query'>;

const principalScopes = new Set<Scope>(['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin']);
const knowledgeBaseScopes = ['knowledge:read', 'knowledge:write', 'knowledge:delete'] as const;
type KnowledgeBaseScope = typeof knowledgeBaseScopes[number];

class ManagementError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}

function fail(code: string, message: string, status: number): never {
  throw new ManagementError(code, message, status);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_BODY', 'A JSON object is required.', 400);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some(key => !allowed.has(key))) fail('INVALID_BODY', 'The request contains unsupported fields.', 400);
  if (keys.some(key => !Object.hasOwn(value, key))) fail('INVALID_BODY', 'The request is missing required fields.', 400);
}

function readPrincipalInput(value: unknown): { id: string; scopes: Scope[] } {
  const body = asRecord(value);
  exactKeys(body, ['id', 'scopes']);
  if (typeof body.id !== 'string' || !validIdentifier(body.id)) fail('INVALID_PRINCIPAL_ID', 'id must be a non-empty identifier of at most 200 characters.', 400);
  return { id: body.id, scopes: readScopes(body.scopes, true) as Scope[] };
}

function readMemberInput(value: unknown): KnowledgeBaseScope[] {
  const body = asRecord(value);
  exactKeys(body, ['scopes']);
  return readScopes(body.scopes, false) as KnowledgeBaseScope[];
}

function readScopes(value: unknown, allowAdmin: boolean): Scope[] {
  const allowed = allowAdmin ? principalScopes : new Set<Scope>(knowledgeBaseScopes);
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || !allowed.has(item as Scope)) || new Set(value).size !== value.length) {
    fail('INVALID_SCOPES', allowAdmin
      ? 'scopes must be a non-empty array of supported principal scopes.'
      : 'scopes must be a non-empty array of knowledge:read, knowledge:write, or knowledge:delete.', 400);
  }
  const order: readonly Scope[] = allowAdmin
    ? ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin']
    : knowledgeBaseScopes;
  return order.filter(scope => (value as string[]).includes(scope));
}

function validIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}

function dateIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? new Date(0).toISOString() : date.toISOString();
}

function parseScopes(value: Scope[] | string): Scope[] {
  let scopes: unknown = value;
  if (typeof value === 'string') {
    try { scopes = JSON.parse(value) as unknown; } catch { scopes = []; }
  }
  if (!Array.isArray(scopes)) return [];
  const accepted = new Set(scopes.filter((scope): scope is Scope => typeof scope === 'string' && principalScopes.has(scope as Scope)));
  const order: readonly Scope[] = ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'];
  return order.filter(scope => accepted.has(scope));
}

function parseMemberScopes(value: Scope[] | string): KnowledgeBaseScope[] {
  return parseScopes(value).filter((scope): scope is KnowledgeBaseScope => knowledgeBaseScopes.includes(scope as KnowledgeBaseScope));
}

function sendError(response: Response, status: number, code: string, message: string): void {
  if (status === 401) response.set('WWW-Authenticate', 'Bearer');
  response.status(status).json({ error: { code, message } });
}

function principalFromRequest(request: Request): Principal {
  const principal = (request as AuthenticatedRequest).managementPrincipal;
  if (!principal) fail('UNAUTHENTICATED', 'A valid Bearer token is required.', 401);
  return principal;
}

function requireAdmin(principal: Principal): void {
  if (!principal.scopes.includes('knowledge:admin')) fail('FORBIDDEN', 'Tenant administrator scope is required.', 403);
}

function stringParam(value: string | string[] | undefined, label: string): string {
  if (typeof value !== 'string' || !validIdentifier(value)) fail(`INVALID_${label.toUpperCase()}`, `${label} is invalid.`, 400);
  return value;
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function lockCurrentAdmin(client: Queryable, principal: Principal, tokenHash: Buffer): Promise<void> {
  const result = await client.query<{ scopes: Scope[] | string; revoked_at: Date | null; token_hash: Buffer }>(
    `SELECT scopes, revoked_at, token_hash FROM pd_principals WHERE tenant_id = $1 AND principal_id = $2 FOR SHARE`,
    [principal.tenantId, principal.id],
  );
  const row = result.rows[0];
  if (!row || row.revoked_at || !timingSafeEqual(row.token_hash, tokenHash)) fail('UNAUTHENTICATED', 'The Bearer token is no longer active.', 401);
  if (!parseScopes(row.scopes).includes('knowledge:admin')) fail('FORBIDDEN', 'Tenant administrator scope is required.', 403);
}

async function requireKnowledgeBase(client: Queryable, tenantId: string, knowledgeBaseId: string): Promise<void> {
  const result = await client.query('SELECT 1 FROM pd_knowledge_bases WHERE tenant_id = $1 AND id = $2', [tenantId, knowledgeBaseId]);
  if (result.rowCount === 0) fail('KNOWLEDGE_BASE_NOT_FOUND', 'Knowledge base not found.', 404);
}

const authenticate: (backend: DocumentBackend) => RequestHandler = backend => async (request, response, next) => {
  try {
    const match = /^Bearer\s+(\S+)$/i.exec(request.headers.authorization ?? '');
    const principal = match ? await backend.authenticate(match[1]!) : undefined;
    if (!principal) { sendError(response, 401, 'UNAUTHENTICATED', 'A valid Bearer token is required.'); return; }
    (request as AuthenticatedRequest).managementPrincipal = principal;
    (request as AuthenticatedRequest).managementTokenHash = createHash('sha256').update(match![1]!).digest();
    next();
  } catch (error) { next(error); }
};

function trustedOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('MANAGEMENT_PUBLIC_BASE_URL_INVALID');
  }
  return url.origin;
}

const sameOrigin = (configuredOrigin?: string): RequestHandler => (request, response, next) => {
  const origin = request.get('origin');
  if (!origin) { next(); return; }
  try {
    const received = new URL(origin);
    const host = request.get('host');
    if (!configuredOrigin && !host) throw new Error('missing host');
    const expectedOrigin = configuredOrigin ?? new URL(`${request.protocol}://${host}`).origin;
    if (received.origin !== expectedOrigin || received.username || received.password || received.pathname !== '/' || received.search || received.hash) {
      sendError(response, 403, 'ORIGIN_FORBIDDEN', 'Cross-origin requests are not allowed.');
      return;
    }
    next();
  } catch {
    sendError(response, 403, 'ORIGIN_FORBIDDEN', 'Cross-origin requests are not allowed.');
  }
};

const route = (action: (request: Request, response: Response) => Promise<void>): RequestHandler => (request, response, next) => {
  void action(request, response).catch(next);
};

/** Mount the tenant-scoped management API on an Express application. */
export function addManagementRoutes(
  app: Express,
  pool: Pool,
  backend: DocumentBackend,
  runtime: GatewayRuntime,
  options: ManagementOptions,
): void {
  const router = express.Router();
  const managementBackend = runtime.backend;
  const configuredOrigin = trustedOrigin(options.publicBaseUrl);
  router.use((_request, response, next) => { response.set('Cache-Control', 'no-store'); next(); });
  router.use(authenticate(backend));
  router.use(sameOrigin(configuredOrigin));
  router.use(express.json({ limit: '16kb', strict: true }));

  router.get('/me', route(async (request, response) => {
    const principal = principalFromRequest(request);
    response.json({
      principal: { id: principal.id, tenantId: principal.tenantId, scopes: parseScopes(principal.scopes) },
      capabilities: {
        indexing: managementBackend.indexingEnabled === true,
        natural: options.naturalEnabled,
        uploads: typeof managementBackend.createUpload === 'function',
      },
    });
  }));

  router.get('/principals', route(async (request, response) => {
    const principal = principalFromRequest(request);
    requireAdmin(principal);
    const result = await pool.query<PrincipalRow>(
      `SELECT principal_id, scopes, revoked_at, created_at FROM pd_principals WHERE tenant_id = $1 ORDER BY principal_id`,
      [principal.tenantId],
    );
    response.json({ principals: result.rows.map(row => ({
      id: row.principal_id, scopes: parseScopes(row.scopes), revoked: row.revoked_at !== null, createdAt: dateIso(row.created_at),
    })) });
  }));

  router.post('/principals', route(async (request, response) => {
    const actor = principalFromRequest(request);
    const actorTokenHash = (request as AuthenticatedRequest).managementTokenHash!;
    requireAdmin(actor);
    const input = readPrincipalInput(request.body);
    const token = randomBytes(32).toString('base64url');
    const newTokenHash = createHash('sha256').update(token).digest();
    const created = await withTransaction(pool, async client => {
      await lockCurrentAdmin(client, actor, actorTokenHash);
      const result = await client.query<PrincipalRow>(
        `INSERT INTO pd_principals (tenant_id, principal_id, scopes, token_hash, revoked_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, now())
         ON CONFLICT (tenant_id, principal_id) DO NOTHING
         RETURNING principal_id, scopes, revoked_at, created_at`,
        [actor.tenantId, input.id, input.scopes, newTokenHash],
      );
      if (!result.rows[0]) fail('PRINCIPAL_EXISTS', 'A principal with this id already exists in the tenant.', 409);
      return result.rows[0];
    });
    response.status(201).json({ principal: {
      id: created.principal_id, tenantId: actor.tenantId, scopes: parseScopes(created.scopes), revoked: false, createdAt: dateIso(created.created_at),
    }, token });
  }));

  router.post('/principals/:id/rotate', route(async (request, response) => {
    const actor = principalFromRequest(request);
    const actorTokenHash = (request as AuthenticatedRequest).managementTokenHash!;
    requireAdmin(actor);
    const id = stringParam(request.params.id, 'principal_id');
    if (id === actor.id) fail('SELF_CREDENTIAL_CHANGE', 'Use the admin CLI to rotate the current principal credential.', 409);
    const token = randomBytes(32).toString('base64url');
    const newTokenHash = createHash('sha256').update(token).digest();
    const changed = await withTransaction(pool, async client => {
      await lockCurrentAdmin(client, actor, actorTokenHash);
      const target = await client.query(
        `UPDATE pd_principals SET token_hash = $3, updated_at = now()
         WHERE tenant_id = $1 AND principal_id = $2 AND revoked_at IS NULL RETURNING principal_id`,
        [actor.tenantId, id, newTokenHash],
      );
      if (target.rowCount) return true;
      const exists = await client.query('SELECT 1 FROM pd_principals WHERE tenant_id = $1 AND principal_id = $2', [actor.tenantId, id]);
      if (exists.rowCount === 0) fail('PRINCIPAL_NOT_FOUND', 'Principal not found.', 404);
      fail('PRINCIPAL_REVOKED', 'A revoked principal cannot be rotated.', 409);
    });
    if (changed) response.json({ token });
  }));

  router.post('/principals/:id/revoke', route(async (request, response) => {
    const actor = principalFromRequest(request);
    const tokenHash = (request as AuthenticatedRequest).managementTokenHash!;
    requireAdmin(actor);
    const id = stringParam(request.params.id, 'principal_id');
    if (id === actor.id) fail('SELF_CREDENTIAL_CHANGE', 'Use the admin CLI to revoke the current principal.', 409);
    await withTransaction(pool, async client => {
      await lockCurrentAdmin(client, actor, tokenHash);
      const result = await client.query(
        `UPDATE pd_principals SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
         WHERE tenant_id = $1 AND principal_id = $2 RETURNING principal_id`, [actor.tenantId, id],
      );
      if (!result.rowCount) fail('PRINCIPAL_NOT_FOUND', 'Principal not found.', 404);
    });
    response.json({ principal: { id, revoked: true } });
  }));

  router.post('/tasks/:id/retry', route(async (request, response) => {
    const principal = principalFromRequest(request);
    const taskId = stringParam(request.params.id, 'task_id');
    const body = asRecord(request.body);
    exactKeys(body, ['requestId']);
    if (typeof body.requestId !== 'string' || Array.from(body.requestId).length < 1 || Array.from(body.requestId).length > 128) {
      fail('INVALID_REQUEST_ID', 'requestId must be a string from 1 through 128 characters.', 400);
    }
    const retry = backend.retryFailedTask;
    if (typeof retry !== 'function') { fail('RETRY_UNAVAILABLE', 'Task retry is not available.', 501); }
    const retried = await retry.call(backend, principal, taskId, body.requestId);
    response.status(202).json({ taskId: retried.id, contextId: retried.contextId, retryOfTaskId: taskId });
  }));

  router.get('/knowledge-bases/:id/members', route(async (request, response) => {
    const actor = principalFromRequest(request);
    requireAdmin(actor);
    const knowledgeBaseId = stringParam(request.params.id, 'knowledge_base_id');
    await requireKnowledgeBase(pool, actor.tenantId, knowledgeBaseId);
    const result = await pool.query<MemberRow>(
      `SELECT m.principal_id, m.scopes
       FROM pd_knowledge_base_members m
       JOIN pd_principals p ON p.tenant_id = m.tenant_id AND p.principal_id = m.principal_id
       WHERE m.tenant_id = $1 AND m.knowledge_base_id = $2 AND p.revoked_at IS NULL
       ORDER BY m.principal_id`, [actor.tenantId, knowledgeBaseId],
    );
    response.json({ members: result.rows.map(row => ({ principalId: row.principal_id, scopes: parseMemberScopes(row.scopes) })) });
  }));

  router.put('/knowledge-bases/:id/members/:principalId', route(async (request, response) => {
    const actor = principalFromRequest(request);
    const actorTokenHash = (request as AuthenticatedRequest).managementTokenHash!;
    requireAdmin(actor);
    const knowledgeBaseId = stringParam(request.params.id, 'knowledge_base_id');
    const principalId = stringParam(request.params.principalId, 'principal_id');
    const scopes = readMemberInput(request.body);
    await withTransaction(pool, async client => {
      await lockCurrentAdmin(client, actor, actorTokenHash);
      await requireKnowledgeBase(client, actor.tenantId, knowledgeBaseId);
      const target = await client.query(
        'SELECT 1 FROM pd_principals WHERE tenant_id = $1 AND principal_id = $2 AND revoked_at IS NULL',
        [actor.tenantId, principalId],
      );
      if (!target.rowCount) fail('PRINCIPAL_NOT_FOUND', 'Active principal not found in the tenant.', 404);
      await client.query(
        `INSERT INTO pd_knowledge_base_members (tenant_id, knowledge_base_id, principal_id, scopes)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, knowledge_base_id, principal_id) DO UPDATE SET scopes = EXCLUDED.scopes`,
        [actor.tenantId, knowledgeBaseId, principalId, scopes],
      );
    });
    response.json({ member: { principalId, scopes } });
  }));

  router.delete('/knowledge-bases/:id/members/:principalId', route(async (request, response) => {
    const actor = principalFromRequest(request);
    const actorTokenHash = (request as AuthenticatedRequest).managementTokenHash!;
    requireAdmin(actor);
    const knowledgeBaseId = stringParam(request.params.id, 'knowledge_base_id');
    const principalId = stringParam(request.params.principalId, 'principal_id');
    await withTransaction(pool, async client => {
      await lockCurrentAdmin(client, actor, actorTokenHash);
      await requireKnowledgeBase(client, actor.tenantId, knowledgeBaseId);
      const target = await client.query(
        'SELECT 1 FROM pd_principals WHERE tenant_id = $1 AND principal_id = $2', [actor.tenantId, principalId],
      );
      if (!target.rowCount) fail('PRINCIPAL_NOT_FOUND', 'Principal not found in the tenant.', 404);
      await client.query(
        'DELETE FROM pd_knowledge_base_members WHERE tenant_id = $1 AND knowledge_base_id = $2 AND principal_id = $3',
        [actor.tenantId, knowledgeBaseId, principalId],
      );
    });
    response.status(204).end();
  }));

  router.get('/knowledge-bases/:id/permissions', route(async (request, response) => {
    const actor = principalFromRequest(request);
    const knowledgeBaseId = stringParam(request.params.id, 'knowledge_base_id');
    await requireKnowledgeBase(pool, actor.tenantId, knowledgeBaseId);
    if (actor.scopes.includes('knowledge:admin')) {
      response.json({ knowledgeBaseId, scopes: [...knowledgeBaseScopes] });
      return;
    }
    const result = await pool.query<MemberRow>(
      `SELECT m.principal_id, m.scopes FROM pd_knowledge_base_members m
       JOIN pd_principals p ON p.tenant_id = m.tenant_id AND p.principal_id = m.principal_id AND p.revoked_at IS NULL
       WHERE m.tenant_id = $1 AND m.knowledge_base_id = $2 AND m.principal_id = $3`,
      [actor.tenantId, knowledgeBaseId, actor.id],
    );
    const row = result.rows[0];
    if (!row) fail('KNOWLEDGE_BASE_NOT_FOUND', 'Knowledge base not found.', 404);
    const grantedScopes = parseMemberScopes(row.scopes);
    const effectiveScopes = grantedScopes.filter(scope => actor.scopes.includes(scope));
    if (effectiveScopes.length === 0) fail('KNOWLEDGE_BASE_NOT_FOUND', 'Knowledge base not found.', 404);
    response.json({ knowledgeBaseId, scopes: effectiveScopes });
  }));

  router.use((_request, response) => sendError(response, 404, 'NOT_FOUND', 'Management endpoint not found.'));
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    if (error instanceof ManagementError) { sendError(response, error.status, error.code, error.message); return; }
    if (error instanceof DomainError) { sendError(response, error.status, error.code, error.message); return; }
    if (error && typeof error === 'object' && 'status' in error) {
      const status = Number((error as { status?: unknown }).status);
      if (status === 400) { sendError(response, 400, 'INVALID_JSON', 'Request body must be valid JSON.'); return; }
      if (status === 413) { sendError(response, 413, 'BODY_TOO_LARGE', 'Request body exceeds 16 KiB.'); return; }
    }
    sendError(response, 503, 'MANAGEMENT_UNAVAILABLE', 'Management request could not be completed.');
  };
  router.use(errorHandler);
  app.use('/api/manage', router);
}
