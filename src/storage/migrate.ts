import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';

const migrationUrls = [
  new URL('../../migrations/001_document_backend.sql', import.meta.url),
  new URL('../../migrations/003_source_access.sql', import.meta.url),
  new URL('../../migrations/005_document_lifecycle.sql', import.meta.url),
  new URL('../../migrations/008_task_paging.sql', import.meta.url),
  new URL('../../migrations/009_task_retry.sql', import.meta.url),
];

/** Apply the idempotent base, source-access, lifecycle, paging, and retry schemas. */
export async function migrate(pool: Pool): Promise<void> {
  const migrations = await Promise.all(migrationUrls.map(url => readFile(url, 'utf8')));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pi-document-m1-schema'))");
    for (const sql of migrations) await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
