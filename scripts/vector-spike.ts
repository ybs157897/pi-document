import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import assert from 'node:assert/strict';
import { LocalPostgres } from './support/local-postgres.js';
const directory = await mkdtemp(join(tmpdir(), 'pi-document-pgvector-'));
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const address = probe.address(); assert.ok(address && typeof address !== 'string');
await new Promise<void>(resolve => probe.close(() => resolve()));
const pg = new LocalPostgres({ dataDir: join(directory, 'data'), port: address.port, password: randomBytes(24).toString('hex') });
let client: Client | undefined;
try {
  await pg.start(); client = new Client({ connectionString: pg.url }); await client.connect();
  await client.query('CREATE EXTENSION vector');
  const versions = await client.query("SELECT version() AS postgres, extversion AS pgvector FROM pg_extension WHERE extname='vector'");
  await client.query('CREATE TEMP TABLE vectors (id text PRIMARY KEY, embedding vector(3))');
  await client.query("INSERT INTO vectors VALUES ('near', '[1,0,0]'), ('far', '[0,1,0]')");
  const rows = await client.query("SELECT id, embedding <=> '[1,0,0]'::vector AS distance FROM vectors ORDER BY distance");
  assert.equal(rows.rows[0]?.id, 'near'); assert.equal(rows.rows[0]?.distance, 0);
  await mkdir('evidence/m0', { recursive: true });
  await writeFile('evidence/m0/pgvector.json', JSON.stringify({ status: 'passed', ...versions.rows[0], rows: rows.rows, source: { postgres: '25c49f3a4a742ba283f5cc43cc7f1d361552e917', pgvector: 'cab9da72c04353f143bb06b42ab70a403daac64a' }, limitation: 'Native PostgreSQL + cosine operator; not full retrieval evaluation.' }, null, 2) + '\n');
  console.log('Native PostgreSQL + pgvector cosine query passed.');
} finally { await client?.end(); await pg.stop(); await rm(directory, { recursive: true, force: true }); }
