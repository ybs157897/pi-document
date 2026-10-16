import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import type { Express } from 'express';
import type { DocumentBackend } from '../domain/types.js';

export async function migrateObservability(pool: Pool) {
  const sql = await readFile(new URL('../../migrations/006_observability.sql', import.meta.url), 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pi-document-observability'))");
    await client.query(sql); await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
const label = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
export function addMetrics(app: Express, pool: Pool, backend: DocumentBackend) {
  app.get('/metrics', async (request, response) => {
    try {
      const match = /^Bearer (\S+)$/i.exec(request.headers.authorization ?? '');
      const principal = match ? await backend.authenticate(match[1]!) : undefined;
      if (!principal) { response.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'UNAUTHENTICATED' }); return; }
      if (!principal.scopes.includes('knowledge:admin')) { response.status(403).json({ error: 'FORBIDDEN' }); return; }
      const tasks = await pool.query<{ operation: string; state: string; count: string; seconds: number }>(
        `SELECT operation, state, count(*)::text AS count, COALESCE(sum(extract(epoch from (updated_at-created_at))),0)::float8 AS seconds
         FROM pd_tasks WHERE tenant_id=$1 GROUP BY operation,state ORDER BY operation,state`, [principal.tenantId]);
      const audit = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM pd_audit_log WHERE tenant_id=$1', [principal.tenantId]);
      const lines = ['# TYPE pi_document_tasks gauge', '# TYPE pi_document_task_elapsed_seconds gauge'];
      for (const row of tasks.rows) {
        const labels = `operation="${label(row.operation)}",state="${label(row.state)}"`;
        lines.push(`pi_document_tasks{${labels}} ${row.count}`, `pi_document_task_elapsed_seconds{${labels}} ${row.seconds}`);
      }
      lines.push('# TYPE pi_document_audit_events counter', `pi_document_audit_events ${audit.rows[0]!.count}`, '');
      response.type('text/plain; version=0.0.4').send(lines.join('\n'));
    } catch { response.status(503).json({ error: 'METRICS_UNAVAILABLE' }); }
  });
}
