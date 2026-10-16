import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, readdir, open, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { assertNoSymlinkPath, parseDatabaseTarget, validateBlobRelativePath } from './support/backup.js';

export interface ReconcileOptions {
  piStoragePath: string;
  blobRoot: string;
  databaseUrl: string;
  pgPassword?: string;
}

interface ReconcileIssue {
  code: string;
  resource?: string;
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('BLOB_NOT_REGULAR_FILE');
    const hash = createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return { sha256: hash.digest('hex'), size: info.size };
  } finally { await handle.close(); }
}

async function scanBlobFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error('BLOB_SYMLINK_FOUND');
    if (info.isDirectory()) files.push(...await scanBlobFiles(root, fullPath));
    else if (info.isFile()) files.push(resolve(fullPath).slice(root.length + 1).split(sep).join('/'));
    else throw new Error('BLOB_ENTRY_NOT_REGULAR');
  }
  return files;
}

function quoteSqliteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function runReconciliation(options: ReconcileOptions): Promise<Record<string, unknown>> {
  const issues: ReconcileIssue[] = [];
  const warnings: ReconcileIssue[] = [];
  const piPath = resolve(options.piStoragePath);
  let database: DatabaseSync | undefined;
  let blobRoot: string | undefined;
  let sqliteTasks: Map<number, number> | undefined;
  let sqliteStatus: string = 'not_checked';
  try {
    const info = await lstat(piPath);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('PI_STORAGE_NOT_REGULAR_FILE');
    database = new DatabaseSync(piPath, { readOnly: true });
    const quickCheck = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    sqliteStatus = String(Object.values(quickCheck ?? {})[0] ?? 'unknown');
    if (sqliteStatus !== 'ok') issues.push({ code: 'PI_SQLITE_INTEGRITY_FAILED' });
    const tableRows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    const tables = new Set(tableRows.map(row => row.name));
    if (!tables.has('tasks') || !tables.has('conversations') || !tables.has('durable_metadata')) {
      issues.push({ code: 'PI_STORAGE_SCHEMA_INCOMPLETE' });
    } else {
      const taskRows = database.prepare(`SELECT id, conversation_id FROM ${quoteSqliteIdentifier('tasks')}`).all() as Array<{ id: number | bigint; conversation_id: number | bigint }>;
      sqliteTasks = new Map(taskRows.map(row => [Number(row.id), Number(row.conversation_id)]));
    }
  } catch {
    issues.push({ code: 'PI_STORAGE_UNREADABLE' });
  } finally {
    database?.close();
  }

  try {
    const rootInfo = await lstat(resolve(options.blobRoot));
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('BLOB_ROOT_INVALID');
    blobRoot = await realpath(options.blobRoot);
  } catch {
    issues.push({ code: 'BLOB_ROOT_UNREADABLE' });
  }

  const target = parseDatabaseTarget(options.databaseUrl, options.pgPassword);
  const pool = new Pool({ connectionString: options.databaseUrl, password: target.password, max: 2, connectionTimeoutMillis: 5_000, statement_timeout: 15_000 });
  let documentCount = 0;
  let versionCount = 0;
  let blobCount = 0;
  let taskCount = 0;
  let mappedTaskCount = 0;
  let unmappedPendingTaskCount = 0;
  let sqliteTaskCount = sqliteTasks?.size ?? 0;
  try {
    const blobRows = await pool.query<{ relative_path: string; sha256: string; byte_size: string | number; mime_type: string }>(
      `SELECT relative_path, sha256, byte_size, mime_type FROM pd_blobs ORDER BY relative_path`,
    );
    const expectedFiles = new Set<string>();
    blobCount = blobRows.rows.length;
    for (const blob of blobRows.rows) {
      let relativePath: string;
      try { relativePath = validateBlobRelativePath(blob.relative_path); }
      catch { issues.push({ code: 'BLOB_PATH_INVALID' }); continue; }
      expectedFiles.add(relativePath);
      if (!blobRoot) continue;
      try {
        await assertNoSymlinkPath(blobRoot, relativePath);
        const stored = await hashFile(join(blobRoot, ...relativePath.split('/')));
        if (stored.sha256 !== blob.sha256.trim().toLowerCase() || stored.size !== Number(blob.byte_size)) {
          issues.push({ code: 'BLOB_HASH_MISMATCH', resource: relativePath });
        }
      } catch {
        issues.push({ code: 'BLOB_MISSING_OR_UNSAFE', resource: relativePath });
      }
    }

    if (blobRoot) {
      try {
        const actualFiles = await scanBlobFiles(blobRoot);
        const expected = new Set(expectedFiles);
        for (const path of actualFiles) if (!expected.has(path)) warnings.push({ code: 'UNREFERENCED_BLOB_FILE', resource: path });
        for (const path of expectedFiles) if (!actualFiles.includes(path)) issues.push({ code: 'BLOB_FILE_NOT_PRESENT', resource: path });
      } catch {
        issues.push({ code: 'BLOB_TREE_CONTAINS_UNSAFE_ENTRIES' });
      }
    }

    const versions = await pool.query<{
      tenant_id: string; document_id: string; active_version: number; version: number | null;
      version_sha256: string | null; version_size: string | number | null; blob_sha256: string | null;
      relative_path: string | null; blob_size: string | number | null;
    }>(`
      SELECT d.tenant_id, d.id AS document_id, d.active_version,
             v.version, v.sha256 AS version_sha256, v.byte_size AS version_size,
             b.sha256 AS blob_sha256, b.relative_path, b.byte_size AS blob_size
      FROM pd_documents d
      LEFT JOIN pd_document_versions v ON v.tenant_id = d.tenant_id AND v.document_id = d.id
      LEFT JOIN pd_blobs b ON b.tenant_id = v.tenant_id AND b.sha256 = v.sha256
      ORDER BY d.tenant_id, d.id, v.version
    `);
    const documentVersions = new Map<string, Set<number>>();
    for (const row of versions.rows) {
      documentCount += documentVersions.has(`${row.tenant_id}:${row.document_id}`) ? 0 : 1;
      const key = `${row.tenant_id}:${row.document_id}`;
      const versionsForDocument = documentVersions.get(key) ?? new Set<number>();
      documentVersions.set(key, versionsForDocument);
      if (row.version === null || row.version_sha256 === null || row.relative_path === null) {
        issues.push({ code: 'DOCUMENT_VERSION_OR_BLOB_MISSING' });
        continue;
      }
      versionCount += 1;
      versionsForDocument.add(row.version);
      if (row.version_sha256.trim().toLowerCase() !== row.blob_sha256?.trim().toLowerCase() || Number(row.version_size) !== Number(row.blob_size)) {
        issues.push({ code: 'DOCUMENT_BLOB_METADATA_MISMATCH' });
      }
      if (!versionsForDocument.has(row.active_version)) {
        // The active version can sort after this row; validate after collecting the full set below.
      }
    }
    for (const row of versions.rows) {
      if (row.version !== row.active_version && !(documentVersions.get(`${row.tenant_id}:${row.document_id}`)?.has(row.active_version))) {
        issues.push({ code: 'ACTIVE_DOCUMENT_VERSION_MISSING' });
      }
    }

    const taskRows = await pool.query<{
      id: string; kind: string; state: string; pi_task_id: string | number | null; pi_conversation_id: string | number | null;
    }>(`SELECT id, kind, state, pi_task_id, pi_conversation_id FROM pd_tasks ORDER BY id`);
    taskCount = taskRows.rows.length;
    for (const task of taskRows.rows) {
      const hasTaskId = task.pi_task_id !== null;
      const hasConversationId = task.pi_conversation_id !== null;
      if (!hasTaskId && !hasConversationId && task.state === 'submitted') {
        unmappedPendingTaskCount += 1;
        continue;
      }
      if (hasTaskId !== hasConversationId) {
        issues.push({ code: 'PI_TASK_MAPPING_PARTIAL', resource: task.id });
        continue;
      }
      if (!hasTaskId) {
        if (task.state === 'working' || task.state === 'completed') issues.push({ code: 'PI_TASK_MAPPING_MISSING', resource: task.id });
        continue;
      }
      const piTaskId = Number(task.pi_task_id);
      const piConversationId = Number(task.pi_conversation_id);
      if (!Number.isSafeInteger(piTaskId) || !Number.isSafeInteger(piConversationId)) {
        issues.push({ code: 'PI_TASK_MAPPING_INVALID', resource: task.id });
        continue;
      }
      if (!sqliteTasks) {
        warnings.push({ code: 'PI_TASK_MAPPING_NOT_VERIFIED', resource: task.id });
        continue;
      }
      if (sqliteTasks.get(piTaskId) !== piConversationId) issues.push({ code: 'PI_TASK_MAPPING_NOT_FOUND_IN_PI', resource: task.id });
      else mappedTaskCount += 1;
    }
  } catch {
    issues.push({ code: 'POSTGRES_RECONCILIATION_FAILED' });
  } finally {
    await pool.end();
  }

  return {
    schemaVersion: 1,
    mode: 'read_only',
    generatedAt: new Date().toISOString(),
    snapshot: 'best_effort_across_stores; stop the service for a coherent offline check',
    repairPerformed: false,
    fullRecoveryClaim: false,
    limits: {
      documents: documentCount,
      versions: versionCount,
      blobs: blobCount,
      postgresTasks: taskCount,
      piTasks: sqliteTaskCount,
      mappedTasks: mappedTaskCount,
      unmappedPendingTasks: unmappedPendingTaskCount,
    },
    checks: { piSqlite: sqliteStatus, issues, warnings },
    limitations: [
      'This command only reports observations; it does not dispatch tasks, replay receipts, rebuild indexes, repair blobs, or alter database rows.',
      'Reads across SQLite, PostgreSQL, and the blob directory are not one distributed snapshot; stop the service before relying on the report.',
      'It checks PostgreSQL Pi task IDs against SQLite task and conversation IDs, but does not prove all Pi scheduler checkpoints can resume.',
    ],
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const report = await runReconciliation({
      piStoragePath: required('PI_STORAGE_PATH'),
      blobRoot: required('BLOB_ROOT'),
      databaseUrl: required('DATABASE_URL'),
      pgPassword: process.env.PGPASSWORD,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    const checks = report.checks as { issues: ReconcileIssue[] };
    if (checks.issues.length > 0) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    process.stderr.write(`${JSON.stringify({ mode: 'read_only', status: 'failed', code: /^[A-Z][A-Z0-9_:-]*/.exec(message)?.[0] ?? 'RECONCILIATION_FAILED', repairPerformed: false })}\n`);
    process.exitCode = 1;
  }
}
