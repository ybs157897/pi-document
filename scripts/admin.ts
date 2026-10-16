import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresDocumentBackend, migrate } from '../src/domain/service.js';
import type { Principal, Scope } from '../src/domain/types.js';

const args = parseArgs({ allowPositionals: true, strict: true, options: {
  tenant: { type: 'string', default: 'local' }, principal: { type: 'string' }, scopes: { type: 'string', default: 'knowledge:read' },
  'knowledge-base': { type: 'string' }, 'token-output': { type: 'string' },
} });
const operation = args.positionals[0];
if (!['principal:create', 'principal:revoke', 'kb:grant', 'kb:revoke'].includes(operation ?? '') || args.positionals.length !== 1 || !args.values.principal) {
  throw new Error('Usage: admin.ts principal:create|principal:revoke|kb:grant|kb:revoke --principal <id> [--tenant local] [--scopes knowledge:read] [--knowledge-base <id>] [--token-output <new-file>]');
}
const databaseUrl = process.env.DATABASE_URL ?? (JSON.parse(await readFile('data/dev/connection.json', 'utf8')) as { databaseUrl: string }).databaseUrl;
const pool = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 5000 });
try {
  await migrate(pool);
  const backend = new PostgresDocumentBackend({ pool, blobRoot: process.env.BLOB_ROOT ?? 'data/service/blobs', publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:4328' });
  const principal: Principal = { tenantId: args.values.tenant!, id: args.values.principal, scopes: args.values.scopes!.split(',') as Scope[] };
  if (operation === 'principal:create') {
    if (!args.values['token-output']) throw new Error('--token-output <new-file> is required; tokens are not printed');
    const token = randomBytes(32).toString('base64url');
    await writeFile(args.values['token-output'], token + '\n', { flag: 'wx', mode: 0o600 });
    await backend.provisionPrincipal({ ...principal, token });
    console.log(JSON.stringify({ operation, principalId: principal.id, tokenFile: args.values['token-output'] }));
  } else if (operation === 'principal:revoke') {
    await pool.query('UPDATE pd_principals SET revoked_at=now(),updated_at=now() WHERE tenant_id=$1 AND principal_id=$2', [principal.tenantId, principal.id]);
    console.log(JSON.stringify({ operation, principalId: principal.id }));
  } else {
    if (!args.values['knowledge-base']) throw new Error('--knowledge-base <id> is required');
    if (operation === 'kb:grant') await backend.grantKnowledgeBase(principal, args.values['knowledge-base'], principal.scopes);
    else await backend.revokeKnowledgeBase(principal, args.values['knowledge-base']);
    console.log(JSON.stringify({ operation, principalId: principal.id, knowledgeBaseId: args.values['knowledge-base'] }));
  }
} finally { await pool.end(); }
