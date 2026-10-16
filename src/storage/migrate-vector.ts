import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { DomainError } from '../domain/types.js';
import { migrate } from './migrate.js';

const migrationUrl = new URL('../../migrations/002_vector_index.sql', import.meta.url);
const cacheMigrationUrl = new URL('../../migrations/007_embedding_cache.sql', import.meta.url);

/** Apply pgvector tables only for a deployment that configured an embedding pipeline. */
export async function migrateVector(pool: Pool, dimensions: number): Promise<void> {
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0 || dimensions > 2000) {
    throw new DomainError('EMBEDDING_DIMENSION_INVALID', 'pgvector dimensions must be an integer from 1 through 2000.');
  }
  await migrate(pool);
  const sql = (await readFile(migrationUrl, 'utf8')).replaceAll('__VECTOR_DIMENSIONS__', String(dimensions));
  const cacheSql = await readFile(cacheMigrationUrl, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pi-document-m2-vector-schema'))");
    await client.query(sql);
    await client.query(
      `INSERT INTO pd_vector_configuration (singleton, dimensions) VALUES (true, $1)
       ON CONFLICT (singleton) DO NOTHING`,
      [dimensions],
    );
    const configured = await client.query<{ dimensions: number }>(
      `SELECT dimensions FROM pd_vector_configuration WHERE singleton = true FOR UPDATE`,
    );
    if (!configured.rows[0] || configured.rows[0].dimensions !== dimensions) {
      throw new DomainError('VECTOR_DIMENSION_MISMATCH', 'Configured pgvector dimensions differ from the existing index schema.', 409);
    }
    await client.query(cacheSql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
