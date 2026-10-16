import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Pool } from 'pg';
import { LocalPostgres } from '../../scripts/support/local-postgres.js';
import { addManagementRoutes } from '../../src/management/router.js';
import { PostgresDocumentBackend, migrate } from '../../src/domain/service.js';
import { DomainError, type GatewayRuntime, type Principal, type Scope } from '../../src/domain/types.js';

type Environment = {
  root: string;
  postgres: LocalPostgres;
  pool: Pool;
  backend: PostgresDocumentBackend;
  baseUrl: string;
  server: ReturnType<typeof createHttpServer>;
};

let environment: Environment;

async function reservePort(): Promise<number> {
  const socket = createNetServer();
  await new Promise<void>((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>(resolve => socket.close(() => resolve()));
  return address.port;
}

async function setup(): Promise<Environment> {
  const root = await mkdtemp(join(tmpdir(), 'pi-document-management-'));
  const postgres = new LocalPostgres({ dataDir: join(root, 'postgres'), port: await reservePort(), password: randomBytes(24).toString('hex') });
  let pool: Pool | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    await postgres.start();
    pool = new Pool({ connectionString: postgres.url, max: 6 });
    await migrate(pool);
    const backend = new PostgresDocumentBackend({ pool, blobRoot: join(root, 'blobs'), publicBaseUrl: 'http://127.0.0.1' });
    const app = express();
    app.disable('x-powered-by');
    const runtime: GatewayRuntime = {
      backend,
      async submit() { throw new Error('not used by management routes'); },
      async cancel() { throw new Error('not used by management routes'); },
    };
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    addManagementRoutes(app, pool, backend, runtime, { naturalEnabled: false, publicBaseUrl: baseUrl });
    server = createHttpServer(app);
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(port, '127.0.0.1', resolve); });
    return { root, postgres, pool, backend, baseUrl, server };
  } catch (error) {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await pool?.end().catch(() => undefined);
    await postgres.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

before(async () => { environment = await setup(); });
after(async () => {
  await new Promise<void>(resolve => environment.server.close(() => resolve()));
  await environment.pool.end();
  await environment.postgres.stop();
  await rm(environment.root, { recursive: true, force: true });
});

type ApiResponse = { status: number; headers: Headers; body: Record<string, unknown> | undefined };

async function api(method: string, path: string, token: string, body?: unknown, origin?: string): Promise<ApiResponse> {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (origin) headers.set('Origin', origin);
  const response = await fetch(environment.baseUrl + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) as Record<string, unknown> : undefined };
}

async function provision(tenantId: string, id: string, scopes: Scope[]) {
  const token = randomBytes(32).toString('base64url');
  await environment.backend.provisionPrincipal({ tenantId, id, scopes, token });
  return token;
}

function errorCode(response: ApiResponse): string | undefined {
  return (response.body?.error as { code?: string } | undefined)?.code;
}

test('management API enforces tenant, credential, scope, and same-origin boundaries on PostgreSQL', { timeout: 60_000 }, async t => {
  const adminToken = await provision('tenant-a', 'admin', ['knowledge:admin', 'knowledge:read', 'knowledge:write', 'knowledge:delete']);
  const readOnlyToken = await provision('tenant-a', 'reader', ['knowledge:read']);
  const otherTenantAdminToken = await provision('tenant-b', 'admin', ['knowledge:admin']);
  const foreignPrincipalToken = await provision('tenant-b', 'foreign', ['knowledge:read']);
  const knowledgeBaseId = 'kb-a';
  const foreignKnowledgeBaseId = 'kb-b';
  await environment.pool.query(
    `INSERT INTO pd_knowledge_bases (tenant_id, id, name, created_by) VALUES
     ('tenant-a', $1, 'Tenant A KB', 'admin'), ('tenant-b', $2, 'Tenant B KB', 'admin')`,
    [knowledgeBaseId, foreignKnowledgeBaseId],
  );
  await environment.pool.query(
    `INSERT INTO pd_knowledge_base_members (tenant_id, knowledge_base_id, principal_id, scopes)
     VALUES ('tenant-a', $1, 'admin', ARRAY['knowledge:read','knowledge:write','knowledge:delete']::text[])`,
    [knowledgeBaseId],
  );

  await t.test('me is fresh, no-store, capability-aware, and same-origin only', async () => {
    const own = await api('GET', '/api/manage/me', adminToken);
    assert.equal(own.status, 200);
    assert.deepEqual(own.body?.principal, { id: 'admin', tenantId: 'tenant-a', scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'] });
    assert.deepEqual(own.body?.capabilities, { indexing: false, natural: false, uploads: true });
    assert.equal(own.headers.get('cache-control'), 'no-store');
    const allowedOrigin = await api('GET', '/api/manage/me', adminToken, undefined, environment.baseUrl);
    assert.equal(allowedOrigin.status, 200);
    const rejectedOrigin = await api('GET', '/api/manage/me', adminToken, undefined, 'https://other.example');
    assert.equal(rejectedOrigin.status, 403);
    assert.equal(errorCode(rejectedOrigin), 'ORIGIN_FORBIDDEN');
    assert.equal(rejectedOrigin.headers.get('cache-control'), 'no-store');
    assert.equal(rejectedOrigin.headers.get('access-control-allow-origin'), null);
    const unauthenticated = await fetch(environment.baseUrl + '/api/manage/me');
    assert.equal(unauthenticated.status, 401);
    assert.equal(unauthenticated.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await unauthenticated.json(), { error: { code: 'UNAUTHENTICATED', message: 'A valid Bearer token is required.' } });
  });

  await t.test('principal creation is strict, tenant-scoped, and returns a one-time token', async () => {
    const created = await api('POST', '/api/manage/principals', adminToken, { id: 'managed', scopes: ['knowledge:read', 'knowledge:write'] });
    assert.equal(created.status, 201);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    const principal = created.body?.principal as { id: string; tenantId: string; scopes: Scope[]; revoked: boolean; createdAt: string };
    const token = created.body?.token as string;
    assert.equal(principal.id, 'managed');
    assert.equal(principal.tenantId, 'tenant-a');
    assert.deepEqual(principal.scopes, ['knowledge:read', 'knowledge:write']);
    assert.equal(principal.revoked, false);
    assert.ok(Number.isFinite(Date.parse(principal.createdAt)));
    assert.equal(Buffer.from(token, 'base64url').byteLength, 32);
    const stored = await environment.pool.query<{ token_hash: Buffer }>(
      'SELECT token_hash FROM pd_principals WHERE tenant_id=$1 AND principal_id=$2', ['tenant-a', 'managed'],
    );
    assert.deepEqual(stored.rows[0]?.token_hash, createHash('sha256').update(token).digest());
    assert.equal(JSON.stringify(created.body).includes(stored.rows[0]!.token_hash.toString('hex')), false);

    const duplicate = await api('POST', '/api/manage/principals', adminToken, { id: 'managed', scopes: ['knowledge:read'] });
    assert.equal(duplicate.status, 409);
    assert.equal(errorCode(duplicate), 'PRINCIPAL_EXISTS');
    const additional = await api('POST', '/api/manage/principals', adminToken, { id: 'bad-extra', scopes: ['knowledge:read'], tenantId: 'tenant-b' });
    assert.equal(additional.status, 400);
    assert.equal(errorCode(additional), 'INVALID_BODY');
    const invalidScope = await api('POST', '/api/manage/principals', adminToken, { id: 'bad-scope', scopes: ['document:admin'] });
    assert.equal(invalidScope.status, 400);
    assert.equal(errorCode(invalidScope), 'INVALID_SCOPES');
    const noAdmin = await api('GET', '/api/manage/principals', readOnlyToken);
    assert.equal(noAdmin.status, 403);
    assert.equal(errorCode(noAdmin), 'FORBIDDEN');
    const listed = await api('GET', '/api/manage/principals', adminToken);
    const listedIds = (listed.body?.principals as { id: string }[]).map(entry => entry.id);
    assert.ok(listedIds.includes('admin'));
    assert.ok(!listedIds.includes('foreign'));
    assert.equal(JSON.stringify(listed.body).includes(token), false);
    const otherTenantListed = await api('GET', '/api/manage/principals', otherTenantAdminToken);
    assert.deepEqual((otherTenantListed.body?.principals as { id: string }[]).map(entry => entry.id), ['admin', 'foreign']);
  });

  await t.test('KB membership grants and permissions stay within the caller tenant', async () => {
    const created = await api('POST', '/api/manage/principals', adminToken, { id: 'kb-reader', scopes: ['knowledge:read'] });
    assert.equal(created.status, 201);
    const memberToken = created.body?.token as string;
    const grant = await api('PUT', `/api/manage/knowledge-bases/${knowledgeBaseId}/members/kb-reader`, adminToken, { scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete'] });
    assert.equal(grant.status, 200);
    assert.deepEqual(grant.body?.member, { principalId: 'kb-reader', scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete'] });
    const memberList = await api('GET', `/api/manage/knowledge-bases/${knowledgeBaseId}/members`, adminToken);
    assert.equal(memberList.status, 200);
    assert.deepEqual(memberList.body?.members, [
      { principalId: 'admin', scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete'] },
      { principalId: 'kb-reader', scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete'] },
    ]);
    const ownPermissions = await api('GET', `/api/manage/knowledge-bases/${knowledgeBaseId}/permissions`, memberToken);
    assert.equal(ownPermissions.status, 200);
    assert.deepEqual(ownPermissions.body, { knowledgeBaseId, scopes: ['knowledge:read'] });
    const adminPermissions = await api('GET', `/api/manage/knowledge-bases/${knowledgeBaseId}/permissions`, adminToken);
    assert.equal(adminPermissions.status, 200);
    assert.deepEqual(adminPermissions.body, { knowledgeBaseId, scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete'] });

    const writeOnly = await api('POST', '/api/manage/principals', adminToken, { id: 'global-write-only', scopes: ['knowledge:write'] });
    assert.equal(writeOnly.status, 201);
    const writeOnlyToken = writeOnly.body?.token as string;
    const writeOnlyGrant = await api('PUT', `/api/manage/knowledge-bases/${knowledgeBaseId}/members/global-write-only`, adminToken, {
      scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete'],
    });
    assert.equal(writeOnlyGrant.status, 200);
    const writeOnlyPermissions = await api('GET', `/api/manage/knowledge-bases/${knowledgeBaseId}/permissions`, writeOnlyToken);
    assert.equal(writeOnlyPermissions.status, 200);
    assert.deepEqual(writeOnlyPermissions.body, { knowledgeBaseId, scopes: ['knowledge:write'] });
    const writeOnlyPrincipal = await environment.backend.authenticate(writeOnlyToken);
    assert.ok(writeOnlyPrincipal);
    await assert.rejects(environment.backend.admit(writeOnlyPrincipal, {
      schemaVersion: '1.0', operation: 'document.list', requestId: 'global-write-no-read', knowledgeBaseId, input: { limit: 1 },
    }), error => error instanceof DomainError && error.code === 'FORBIDDEN');

    const adminMemberGrant = await api('PUT', `/api/manage/knowledge-bases/${knowledgeBaseId}/members/reader`, adminToken, { scopes: ['knowledge:admin'] });
    assert.equal(adminMemberGrant.status, 400);
    assert.equal(errorCode(adminMemberGrant), 'INVALID_SCOPES');
    const crossTenantPrincipal = await api('PUT', `/api/manage/knowledge-bases/${knowledgeBaseId}/members/foreign`, adminToken, { scopes: ['knowledge:read'] });
    assert.equal(crossTenantPrincipal.status, 404);
    assert.equal(errorCode(crossTenantPrincipal), 'PRINCIPAL_NOT_FOUND');
    const crossTenantKb = await api('GET', `/api/manage/knowledge-bases/${foreignKnowledgeBaseId}/members`, adminToken);
    assert.equal(crossTenantKb.status, 404);
    assert.equal(errorCode(crossTenantKb), 'KNOWLEDGE_BASE_NOT_FOUND');
    const hiddenPermission = await api('GET', `/api/manage/knowledge-bases/${foreignKnowledgeBaseId}/permissions`, memberToken);
    assert.equal(hiddenPermission.status, 404);
    const revokeMember = await api('DELETE', `/api/manage/knowledge-bases/${knowledgeBaseId}/members/kb-reader`, adminToken);
    assert.equal(revokeMember.status, 204);
    assert.equal(revokeMember.body, undefined);
    const noLongerAllowed = await api('GET', `/api/manage/knowledge-bases/${knowledgeBaseId}/permissions`, memberToken);
    assert.equal(noLongerAllowed.status, 404);
    const regrant = await api('PUT', `/api/manage/knowledge-bases/${knowledgeBaseId}/members/kb-reader`, adminToken, { scopes: ['knowledge:admin'] });
    assert.equal(regrant.status, 400);
  });

  await t.test('rotation and revocation invalidate old tokens and self changes require CLI', async () => {
    const created = await api('POST', '/api/manage/principals', adminToken, { id: 'rotate-me', scopes: ['knowledge:read'] });
    const oldToken = created.body?.token as string;
    const rotateSelf = await api('POST', '/api/manage/principals/admin/rotate', adminToken);
    assert.equal(rotateSelf.status, 409);
    assert.equal(errorCode(rotateSelf), 'SELF_CREDENTIAL_CHANGE');
    const revokeSelf = await api('POST', '/api/manage/principals/admin/revoke', adminToken);
    assert.equal(revokeSelf.status, 409);
    assert.equal(errorCode(revokeSelf), 'SELF_CREDENTIAL_CHANGE');

    const rotated = await api('POST', '/api/manage/principals/rotate-me/rotate', adminToken);
    assert.equal(rotated.status, 200);
    const newToken = rotated.body?.token as string;
    assert.equal((await api('GET', '/api/manage/me', oldToken)).status, 401);
    assert.equal((await api('GET', '/api/manage/me', newToken)).status, 200);
    const revoke = await api('POST', '/api/manage/principals/rotate-me/revoke', adminToken);
    assert.equal(revoke.status, 200);
    assert.deepEqual(revoke.body, { principal: { id: 'rotate-me', revoked: true } });
    assert.equal((await api('GET', '/api/manage/me', newToken)).status, 401);
    const listed = await api('GET', '/api/manage/principals', adminToken);
    const row = (listed.body?.principals as { id: string; revoked: boolean }[]).find(item => item.id === 'rotate-me');
    assert.equal(row?.revoked, true);
    const revokedRotation = await api('POST', '/api/manage/principals/rotate-me/rotate', adminToken);
    assert.equal(revokedRotation.status, 409);
    assert.equal(errorCode(revokedRotation), 'PRINCIPAL_REVOKED');
    const missing = await api('POST', '/api/manage/principals/missing/revoke', adminToken);
    assert.equal(missing.status, 404);
    const foreignCredential = await api('GET', '/api/manage/me', foreignPrincipalToken);
    assert.equal(foreignCredential.status, 200);
    assert.deepEqual(foreignCredential.body?.principal, { id: 'foreign', tenantId: 'tenant-b', scopes: ['knowledge:read'] });
  });

  await t.test('retry request schema is strict and an unavailable backend reports 501', async () => {
    const invalidExtra = await api('POST', '/api/manage/tasks/task-one/retry', adminToken, { requestId: 'retry-1', tenantId: 'tenant-b' });
    assert.equal(invalidExtra.status, 400);
    assert.equal(errorCode(invalidExtra), 'INVALID_BODY');
    const invalidRequestId = await api('POST', '/api/manage/tasks/task-one/retry', adminToken, { requestId: '' });
    assert.equal(invalidRequestId.status, 400);
    assert.equal(errorCode(invalidRequestId), 'INVALID_REQUEST_ID');

    const app = express();
    const noRetryBackend = {
      authenticate: (token: string) => environment.backend.authenticate(token),
    } as unknown as typeof environment.backend;
    const runtime: GatewayRuntime = {
      backend: noRetryBackend,
      async submit() { throw new Error('not used by management routes'); },
      async cancel() { throw new Error('not used by management routes'); },
    };
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    addManagementRoutes(app, environment.pool, noRetryBackend, runtime, { naturalEnabled: false, publicBaseUrl: baseUrl });
    const server = createHttpServer(app);
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      const response = await fetch(`${baseUrl}/api/manage/tasks/task-one/retry`, { method: 'POST', headers: {
        Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ requestId: 'retry-1' }) });
      assert.equal(response.status, 501);
      assert.deepEqual(await response.json(), { error: { code: 'RETRY_UNAVAILABLE', message: 'Task retry is not available.' } });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  await t.test('retry forwards authenticated owner identity without requiring tenant admin', async () => {
    const writerToken = await provision('tenant-a', 'writer', ['knowledge:write']);
    let received: { tenantId: string; principalId: string; taskId: string; requestId: string } | undefined;
    const retryBackend = {
      authenticate: (token: string) => environment.backend.authenticate(token),
      retryFailedTask: async (principal: Principal, taskId: string, requestId: string) => {
        received = { tenantId: principal.tenantId, principalId: principal.id, taskId, requestId };
        return { id: 'retry-task-id', contextId: 'retry-context-id' };
      },
    } as unknown as typeof environment.backend;
    const app = express();
    const runtime: GatewayRuntime = {
      backend: retryBackend,
      async submit() { throw new Error('not used by management routes'); },
      async cancel() { throw new Error('not used by management routes'); },
    };
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    addManagementRoutes(app, environment.pool, retryBackend, runtime, { naturalEnabled: false, publicBaseUrl: baseUrl });
    const server = createHttpServer(app);
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      const response = await fetch(`${baseUrl}/api/manage/tasks/failed-index-task/retry`, { method: 'POST', headers: {
        Authorization: `Bearer ${writerToken}`, 'Content-Type': 'application/json',
      }, body: JSON.stringify({ requestId: 'stable-retry-request' }) });
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { taskId: 'retry-task-id', contextId: 'retry-context-id', retryOfTaskId: 'failed-index-task' });
      assert.deepEqual(received, { tenantId: 'tenant-a', principalId: 'writer', taskId: 'failed-index-task', requestId: 'stable-retry-request' });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
