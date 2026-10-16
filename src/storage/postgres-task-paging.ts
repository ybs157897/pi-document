import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DomainError, type Principal } from '../domain/types.js';

export type TaskPageInput = {
  contextId?: string;
  states?: string[];
  updatedAfter?: string;
  limit: number;
  cursor?: string;
  includeArtifacts?: boolean;
  includeNatural?: boolean;
};

export type TaskPage = { taskIds: string[]; nextCursor?: string; totalSize: number };

type CursorRow = {
  filter_hash: string;
  snapshot_at: string;
  last_created_at: string;
  last_task_id: string;
  visibility_hash: string;
  expires_at: Date | string;
};

type PageRow = {
  task_id: string | null;
  created_at: string | null;
  total_size: string | number;
  visibility_hash: string;
  has_more: boolean;
};

const pageCursorLifetimeMs = 60 * 60 * 1000;
const maximumTaskPageSize = 100;
const taskStates = new Set(['submitted', 'working', 'input_required', 'cancel_requested', 'completed', 'failed', 'canceled']);

export async function pruneExpiredCursorRows(client: Pick<PoolClient, 'query'>): Promise<void> {
  for (const table of ['pd_task_page_cursors', 'pd_list_cursors', 'pd_content_cursors'] as const) {
    await client.query(
      `WITH expired AS (
         SELECT id FROM ${table} WHERE expires_at <= clock_timestamp()
         ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
       )
       DELETE FROM ${table} cursor USING expired WHERE cursor.id = expired.id`,
    );
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function filterHash(input: {
  contextId?: string; states: string[]; updatedAfter?: string; limit: number; includeArtifacts: boolean; includeNatural: boolean;
}): string {
  return createHash('sha256').update(stableJson(input)).digest('hex');
}

function normalizeInput(input: TaskPageInput) {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > maximumTaskPageSize) {
    throw new DomainError('INVALID_PAGE_SIZE', `Task page size must be an integer from 1 through ${maximumTaskPageSize}.`, 400);
  }
  const contextId = input.contextId?.trim() || undefined;
  const states = [...new Set((input.states ?? []).map(state => state.trim()).filter(Boolean))].sort();
  if (states.some(state => !taskStates.has(state))) {
    throw new DomainError('INVALID_TASK_STATE', 'Task page filter contains an unsupported state.', 400);
  }
  let updatedAfter: string | undefined;
  if (input.updatedAfter !== undefined) {
    const timestamp = Date.parse(input.updatedAfter);
    if (!Number.isFinite(timestamp)) throw new DomainError('INVALID_TIMESTAMP', 'Task updatedAfter must be a valid timestamp.', 400);
    updatedAfter = new Date(timestamp).toISOString();
  }
  const includeArtifacts = input.includeArtifacts === true;
  const includeNatural = input.includeNatural !== false;
  return { contextId, states, updatedAfter, limit: input.limit, includeArtifacts, includeNatural };
}

function taskAcl(alias: string, principalAlias: string): string {
  const skipDocumentAcl = `(${alias}.operation = 'document.delete' OR ${alias}.kind = 'purge')`;
  return `
    NOT EXISTS (
      SELECT 1 FROM pd_task_resources tr
      WHERE tr.tenant_id = ${alias}.tenant_id AND tr.task_id = ${alias}.id
        AND NOT EXISTS (
          SELECT 1 FROM pd_knowledge_bases kb
          WHERE kb.tenant_id = tr.tenant_id AND kb.id = tr.knowledge_base_id
            AND (
              'knowledge:admin' = ANY(${principalAlias}.scopes)
              OR EXISTS (
                SELECT 1 FROM pd_knowledge_base_members m
                WHERE m.tenant_id = kb.tenant_id AND m.knowledge_base_id = kb.id
                  AND m.principal_id = ${alias}.principal_id AND 'knowledge:read' = ANY(m.scopes)
              )
            )
        )
    )
    AND (
      ${skipDocumentAcl}
      OR NOT EXISTS (
        SELECT 1 FROM pd_task_document_resources dr
        JOIN pd_documents d ON d.tenant_id = dr.tenant_id AND d.id = dr.document_id
        WHERE dr.tenant_id = ${alias}.tenant_id AND dr.task_id = ${alias}.id
          AND (
            d.deleted_at IS NOT NULL
            OR NOT EXISTS (
              SELECT 1 FROM pd_knowledge_base_members m
              WHERE m.tenant_id = d.tenant_id AND m.knowledge_base_id = d.knowledge_base_id
                AND m.principal_id = ${alias}.principal_id
                AND ('knowledge:read' = ANY(m.scopes) OR 'knowledge:admin' = ANY(${principalAlias}.scopes))
            )
          )
      )
    )`;
}

function documentReferenceHidden(
  actionAlias: string,
  principalAlias: string,
  documentId: string,
  version: string,
): string {
  return `NOT EXISTS (
    SELECT 1 FROM pd_documents d
    JOIN pd_document_versions v ON v.tenant_id = d.tenant_id AND v.document_id = d.id
      AND v.version = COALESCE(${version}, d.active_version)
    WHERE d.tenant_id = ${actionAlias}.tenant_id AND d.id = ${documentId}
      AND d.deleted_at IS NULL AND v.version <= d.active_version
      AND (
        'knowledge:admin' = ANY(${principalAlias}.scopes)
        OR EXISTS (
          SELECT 1 FROM pd_knowledge_base_members m
          WHERE m.tenant_id = d.tenant_id AND m.knowledge_base_id = d.knowledge_base_id
            AND m.principal_id = ${actionAlias}.principal_id AND 'knowledge:read' = ANY(m.scopes)
        )
      )
  )`;
}

function naturalActionReferencesHidden(actionAlias: string, principalAlias: string): string {
  const requestedDocument = documentReferenceHidden(
    actionAlias, principalAlias,
    `${actionAlias}.request->'input'->>'documentId'`,
    `COALESCE(NULLIF(${actionAlias}.request->'input'->>'version', '')::integer,
      NULLIF(${actionAlias}.request->'input'->>'expectedVersion', '')::integer)`,
  );
  const savedDocument = documentReferenceHidden(
    actionAlias, principalAlias,
    `${actionAlias}.result->'result'->>'documentId'`,
    `NULLIF(${actionAlias}.result->'result'->>'version', '')::integer`,
  );
  const searchResultDocument = documentReferenceHidden(
    actionAlias, principalAlias,
    `search_hit->>'documentId'`,
    `NULLIF(search_hit->>'version', '')::integer`,
  );
  return `(
    (${actionAlias}.request->>'operation' IN ('document.get', 'document.update', 'document.delete') AND ${requestedDocument})
    OR (${actionAlias}.request->>'operation' = 'document.save'
      AND ${actionAlias}.result->'result'->>'documentId' IS NOT NULL AND ${savedDocument})
    OR (${actionAlias}.request->>'operation' = 'document.search' AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(${actionAlias}.result->'result'->'results') = 'array'
          THEN ${actionAlias}.result->'result'->'results' ELSE '[]'::jsonb END
      ) search_hit
      WHERE search_hit->>'documentId' IS NOT NULL AND ${searchResultDocument}
    ))
  )`;
}

function visibleCtes(includeNatural: boolean): string {
  const businessAcl = taskAcl('t', 'p');
  const naturalChildAcl = taskAcl('child', 'p');
  const naturalCte = includeNatural
    ? `,
    visible_natural AS (
      SELECT 'natural'::text AS task_kind, n.task_id, n.created_at, n.updated_at
      FROM pd_agent_tasks n
      JOIN active_principal p ON p.tenant_id = n.tenant_id AND p.principal_id = n.principal_id
      WHERE n.tenant_id = $1 AND n.principal_id = $2
        AND ($3::text IS NULL OR n.context_id = $3)
        AND (cardinality($4::text[]) = 0 OR n.state = ANY($4::text[]))
        AND ($5::timestamptz IS NULL OR n.updated_at >= $5::timestamptz)
        AND NOT EXISTS (
          SELECT 1 FROM pd_agent_actions a
          WHERE a.tenant_id = n.tenant_id AND a.principal_id = n.principal_id AND a.context_id = n.context_id
            AND (
              NOT (
                'knowledge:admin' = ANY(p.scopes)
                OR CASE a.request->>'operation'
                  WHEN 'knowledge_base.create' THEN 'knowledge:write'
                  WHEN 'document.save' THEN 'knowledge:write'
                  WHEN 'document.update' THEN 'knowledge:write'
                  WHEN 'document.delete' THEN 'knowledge:delete'
                  ELSE 'knowledge:read'
                END = ANY(p.scopes)
              )
              OR ${naturalActionReferencesHidden('a', 'p')}
              OR (
                a.child_task_id IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM pd_tasks child
                  WHERE child.tenant_id = a.tenant_id AND child.id = a.child_task_id
                    AND child.principal_id = a.principal_id AND ${naturalChildAcl}
                )
              )
            )
        )
    )`
    : '';
  return `
    active_principal AS (
      SELECT tenant_id, principal_id, scopes
      FROM pd_principals
      WHERE tenant_id = $1 AND principal_id = $2 AND revoked_at IS NULL
        AND ('knowledge:read' = ANY(scopes) OR 'knowledge:admin' = ANY(scopes))
    ),
    visible_business AS (
      SELECT 'business'::text AS task_kind, t.id AS task_id, t.created_at, t.updated_at
      FROM pd_tasks t
      JOIN active_principal p ON p.tenant_id = t.tenant_id AND p.principal_id = t.principal_id
      WHERE t.tenant_id = $1 AND t.principal_id = $2
        AND ($3::text IS NULL OR t.context_id = $3)
        AND (cardinality($4::text[]) = 0 OR t.state = ANY($4::text[]))
        AND ($5::timestamptz IS NULL OR t.updated_at >= $5::timestamptz)
        AND ${businessAcl}
    )${naturalCte},
    visible_tasks AS (
      SELECT task_kind, task_id, created_at, updated_at FROM visible_business
      ${includeNatural ? 'UNION ALL SELECT task_kind, task_id, created_at, updated_at FROM visible_natural' : ''}
    ),
    snapshot_visible AS (
      SELECT task_kind, task_id, created_at
      FROM visible_tasks
      WHERE created_at <= $6::timestamptz AND updated_at <= $6::timestamptz
    )`;
}

export async function listPostgresTaskPage(client: PoolClient, principal: Principal, input: TaskPageInput): Promise<TaskPage> {
  const normalized = normalizeInput(input);
  const hash = filterHash(normalized);
  let cursor: CursorRow | undefined;
  if (input.cursor) {
    const result = await client.query<CursorRow>(
      `SELECT filter_hash, snapshot_at::text AS snapshot_at, last_created_at::text AS last_created_at,
              last_task_id, visibility_hash, expires_at
       FROM pd_task_page_cursors WHERE id = $1 AND tenant_id = $2 AND principal_id = $3`,
      [input.cursor, principal.tenantId, principal.id],
    );
    cursor = result.rows[0];
    if (!cursor) throw new DomainError('INVALID_CURSOR', 'Task page cursor is invalid for this principal.', 400);
    if (new Date(cursor.expires_at).getTime() <= Date.now()) {
      throw new DomainError('CURSOR_EXPIRED', 'Task page cursor has expired; restart the list request.', 400);
    }
    if (cursor.filter_hash !== hash) throw new DomainError('INVALID_CURSOR', 'Task page cursor does not match the current filters.', 400);
  }
  await pruneExpiredCursorRows(client);

  const natural = await client.query<{ available: boolean }>(
    `SELECT to_regclass('pd_agent_tasks') IS NOT NULL AND to_regclass('pd_agent_actions') IS NOT NULL AS available`,
  );
  const includeNatural = normalized.includeNatural && natural.rows[0]?.available === true;
  const snapshotAt = cursor?.snapshot_at ?? (await client.query<{ snapshot_at: string }>(`SELECT transaction_timestamp()::text AS snapshot_at`)).rows[0]!.snapshot_at;
  const sql = `
    WITH${visibleCtes(includeNatural)},
    metrics AS (
      SELECT count(*)::bigint AS total_size,
        md5(count(*)::text || ':' ||
          COALESCE(sum(hashtextextended(task_kind || ':' || task_id, 0)::numeric)::text, '0') || ':' ||
          COALESCE(sum(hashtextextended(task_kind || ':' || task_id, 714025)::numeric)::text, '0')) AS visibility_hash
      FROM snapshot_visible
    ),
    page AS (
      SELECT task_kind, task_id, created_at
      FROM snapshot_visible
      WHERE ($7::boolean = false OR (created_at, task_id) > ($8::timestamptz, $9::text))
      ORDER BY created_at, task_id
      LIMIT $10
    ),
    page_last AS (
      SELECT created_at, task_id FROM page ORDER BY created_at DESC, task_id DESC LIMIT 1
    ),
    page_meta AS (
      SELECT EXISTS (
        SELECT 1 FROM snapshot_visible rest
        WHERE (rest.created_at, rest.task_id) > (page_last.created_at, page_last.task_id)
      ) AS has_more
      FROM page_last
      UNION ALL
      SELECT false WHERE NOT EXISTS (SELECT 1 FROM page_last)
      LIMIT 1
    )
    SELECT page.task_id, page.created_at::text AS created_at, metrics.total_size, metrics.visibility_hash, page_meta.has_more
    FROM metrics CROSS JOIN page_meta LEFT JOIN page ON true
    ORDER BY page.created_at, page.task_id`;
  const rows = await client.query<PageRow>(sql,
    [principal.tenantId, principal.id, normalized.contextId ?? null, normalized.states,
      normalized.updatedAfter ?? null, snapshotAt, Boolean(cursor), cursor?.last_created_at ?? null,
      cursor?.last_task_id ?? null, normalized.limit]);
  const first = rows.rows[0];
  if (!first) throw new Error('TASK_PAGE_METRICS_MISSING');
  const visibilityHash = first.visibility_hash;
  if (cursor && cursor.visibility_hash !== visibilityHash) {
    throw new DomainError('CURSOR_EXPIRED', 'Task visibility changed; restart the list request.', 409);
  }
  const page = rows.rows.filter((row): row is PageRow & { task_id: string; created_at: string } => row.task_id !== null);
  const taskIds = page.map(row => row.task_id);
  const hasMore = first.has_more;
  let nextCursor: string | undefined;
  if (hasMore && page.length > 0) {
    nextCursor = randomUUID();
    const last = page.at(-1)!;
    await client.query(
      `INSERT INTO pd_task_page_cursors
        (id, tenant_id, principal_id, filter_hash, snapshot_at, last_created_at, last_task_id, visibility_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 * interval '1 millisecond'))`,
      [nextCursor, principal.tenantId, principal.id, hash, snapshotAt, last.created_at, last.task_id, visibilityHash, pageCursorLifetimeMs],
    );
  }
  return { taskIds, ...(nextCursor ? { nextCursor } : {}), totalSize: Number(first.total_size) };
}
