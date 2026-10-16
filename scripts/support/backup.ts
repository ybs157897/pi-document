import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { Pool } from 'pg';
import { BACKGROUND_CONTEXT as backgroundContext } from '@earendil-works/chord/context';
import { openOwnedStorage } from '../../src/runtime/owned-storage.js';

const execFileAsync = promisify(execFile);
const defaultPgBinDir = resolve('.cache/postgres/bin');
const manifestName = 'manifest.json';
const piSnapshotName = 'pi.sqlite';
const pgSnapshotName = 'postgres.dump';

export interface BackupOptions {
  piStoragePath: string;
  blobRoot: string;
  databaseUrl: string;
  outputDir: string;
  pgPassword?: string;
  pgBinDir?: string;
}

export interface RestoreOptions {
  backupDir: string;
  piStoragePath: string;
  blobRoot: string;
  databaseUrl: string;
  pgPassword?: string;
  pgBinDir?: string;
}

export interface BlobManifestEntry {
  relativePath: string;
  sha256: string;
  size: number;
  mimeType: string;
}

export interface BackupManifest {
  schemaVersion: 1;
  generatedAt: string;
  components: {
    pi: { file: typeof piSnapshotName; sha256: string; size: number; sqliteBackupPages: number };
    postgres: { file: typeof pgSnapshotName; format: 'custom'; sha256: string; size: number; pgDumpVersion: string };
    blobs: BlobManifestEntry[];
  };
}

interface PgTarget {
  host: string;
  port: number;
  user: string;
  database: string;
  password: string;
  sslmode?: string;
}

export function parseDatabaseTarget(databaseUrl: string, passwordOverride?: string): PgTarget {
  let url: URL;
  try { url = new URL(databaseUrl); }
  catch { throw new Error('DATABASE_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.pathname || url.pathname === '/') {
    throw new Error('DATABASE_URL_INVALID');
  }
  const sslmode = url.searchParams.get('sslmode') ?? undefined;
  if (url.searchParams.size > (sslmode ? 1 : 0)) throw new Error('DATABASE_URL_OPTIONS_UNSUPPORTED');
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DATABASE_URL_INVALID');
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    user: decodeURIComponent(url.username),
    database: decodeURIComponent(url.pathname.slice(1)),
    password: passwordOverride ?? decodeURIComponent(url.password),
    ...(sslmode ? { sslmode } : {}),
  };
}

function pgArguments(target: PgTarget): string[] {
  return ['--host', target.host, '--port', String(target.port), '--username', target.user, '--dbname', target.database, '--no-password'];
}

function pgEnvironment(target: PgTarget): NodeJS.ProcessEnv {
  return { ...process.env, PGPASSWORD: target.password, ...(target.sslmode ? { PGSSLMODE: target.sslmode } : {}) };
}

async function pgToolPaths(pgBinDir = defaultPgBinDir): Promise<{ dump: string; restore: string; dumpVersion: string }> {
  const binDir = resolve(pgBinDir);
  const dump = join(binDir, 'pg_dump');
  const restore = join(binDir, 'pg_restore');
  try {
    await Promise.all([access(dump, fsConstants.X_OK), access(restore, fsConstants.X_OK)]);
  } catch {
    throw new Error('POSTGRES_TOOLS_MISSING: expected pg_dump and pg_restore under .cache/postgres/bin');
  }
  let dumpVersion: string;
  let restoreVersion: string;
  try {
    [{ stdout: dumpVersion }, { stdout: restoreVersion }] = await Promise.all([
      execFileAsync(dump, ['--version'], { timeout: 10_000 }),
      execFileAsync(restore, ['--version'], { timeout: 10_000 }),
    ]);
  } catch {
    throw new Error('POSTGRES_TOOLS_UNAVAILABLE');
  }
  if (!/^pg_dump \(PostgreSQL\) 17\.(?:1[0-9]|[2-9][0-9])(?:\.\d+)?$/.test(dumpVersion.trim())
    || !/^pg_restore \(PostgreSQL\) 17\.(?:1[0-9]|[2-9][0-9])(?:\.\d+)?$/.test(restoreVersion.trim())) {
    throw new Error('POSTGRES_TOOLS_VERSION_UNSUPPORTED: pg_dump and pg_restore 17.10+ are required');
  }
  return { dump, restore, dumpVersion: dumpVersion.trim() };
}

function runPgTool(binary: string, args: string[], env: NodeJS.ProcessEnv, errorCode: string, timeoutMs = 10 * 60_000): Promise<void> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(binary, args, { env, stdio: 'ignore', windowsHide: true });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 250).unref();
      rejectRun(new Error(`${errorCode}_TIMEOUT`));
    }, timeoutMs);
    child.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectRun(new Error(errorCode));
    });
    child.once('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolveRun();
      else rejectRun(new Error(errorCode));
    });
  });
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('BACKUP_COMPONENT_NOT_REGULAR');
    const hash = createHash('sha256');
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return { sha256: hash.digest('hex'), size: info.size };
  } finally {
    await handle.close();
  }
}

export function validateBlobRelativePath(path: string): string {
  if (!path || path.includes('\\') || path.includes('\0') || isAbsolute(path) || posix.isAbsolute(path)) {
    throw new Error('BLOB_PATH_INVALID');
  }
  const parts = path.split('/');
  if (parts.length !== 3 || parts.some(part => !part || part === '.' || part === '..')
    || !/^[a-f0-9]{32}$/.test(parts[0]!) || !/^[a-f0-9]{2}$/.test(parts[1]!)
    || !/^[a-f0-9]{64}\.blob$/.test(parts[2]!)) {
    throw new Error('BLOB_PATH_INVALID');
  }
  const digest = parts[2]!.slice(0, 64);
  if (parts[1] !== digest.slice(0, 2)) throw new Error('BLOB_PATH_INVALID');
  return parts.join('/');
}

export async function assertNoSymlinkPath(root: string, relativePath: string): Promise<void> {
  const safe = validateBlobRelativePath(relativePath);
  let current = root;
  for (const component of safe.split('/')) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('SYMLINK_NOT_ALLOWED');
  }
}

async function readRegularFileNoFollow(path: string): Promise<Buffer> {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('BACKUP_COMPONENT_NOT_REGULAR');
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertExistingRegularFile(path: string): Promise<{ path: string; dev: number; ino: number }> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('INPUT_NOT_REGULAR_FILE');
  return { path: await realpath(absolute), dev: info.dev, ino: info.ino };
}

async function assertExistingDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('INPUT_NOT_DIRECTORY');
  return realpath(absolute);
}

async function assertAbsent(path: string): Promise<void> {
  try {
    await lstat(path);
    throw new Error('TARGET_MUST_BE_NEW');
  } catch (error) {
    if (error instanceof Error && error.message === 'TARGET_MUST_BE_NEW') throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function normalizeDigest(value: string): string {
  const digest = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('SHA256_INVALID');
  return digest;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

async function queryBlobManifest(databaseUrl: string, password?: string): Promise<BlobManifestEntry[]> {
  const pool = new Pool({ connectionString: databaseUrl, password });
  try {
    const result = await pool.query<{ relative_path: string; sha256: string; byte_size: string | number; mime_type: string }>(
      `SELECT relative_path, sha256, byte_size, mime_type FROM pd_blobs ORDER BY relative_path`,
    );
    return result.rows.map(row => ({
      relativePath: validateBlobRelativePath(row.relative_path),
      sha256: normalizeDigest(row.sha256),
      size: Number(row.byte_size),
      mimeType: row.mime_type,
    }));
  } finally {
    await pool.end();
  }
}

async function copyBlobFromSource(blobRoot: string, backupBlobRoot: string, blob: BlobManifestEntry): Promise<void> {
  await assertNoSymlinkPath(blobRoot, blob.relativePath);
  const source = join(blobRoot, ...blob.relativePath.split('/'));
  const bytes = await readRegularFileNoFollow(source);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== blob.sha256 || bytes.byteLength !== blob.size) throw new Error('BLOB_HASH_MISMATCH');
  const target = join(backupBlobRoot, ...blob.relativePath.split('/'));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
}

async function snapshotPiDatabase(sourcePath: string, targetPath: string): Promise<number> {
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    validatePiDatabase(source);
    const pages = await sqliteBackup(source, targetPath);
    const snapshot = new DatabaseSync(targetPath);
    try {
      snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      const journalMode = snapshot.prepare('PRAGMA journal_mode = DELETE').get() as Record<string, unknown> | undefined;
      if (Object.values(journalMode ?? {})[0] !== 'delete') throw new Error('PI_SQLITE_BACKUP_JOURNAL_MODE_INVALID');
      validatePiDatabase(snapshot);
    } finally {
      snapshot.close();
    }
    return pages;
  } finally {
    source.close();
  }
}

function validatePiDatabase(database: DatabaseSync): void {
  const check = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
  if (Object.values(check ?? {})[0] !== 'ok') throw new Error('PI_SQLITE_INTEGRITY_FAILED');
  const tables = new Set((database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(row => row.name));
  if (!tables.has('durable_metadata') || !tables.has('tasks') || !tables.has('conversations')) throw new Error('PI_STORAGE_SCHEMA_INVALID');
}

async function dumpPostgres(databaseUrl: string, password: string | undefined, pgBinDir: string, destination: string): Promise<string> {
  const target = parseDatabaseTarget(databaseUrl, password);
  const tools = await pgToolPaths(pgBinDir);
  const args = ['--format=custom', '--no-owner', '--no-privileges', '--file', destination, ...pgArguments(target)];
  await runPgTool(tools.dump, args, pgEnvironment(target), 'PG_DUMP_FAILED');
  return tools.dumpVersion;
}

export async function createBackup(options: BackupOptions): Promise<BackupManifest> {
  const piSource = await assertExistingRegularFile(options.piStoragePath);
  const blobRoot = await assertExistingDirectory(options.blobRoot);
  const outputDir = resolve(options.outputDir);
  await assertAbsent(outputDir);
  if (pathsOverlap(outputDir, blobRoot) || pathsOverlap(outputDir, piSource.path)) throw new Error('BACKUP_TARGET_OVERLAPS_SOURCE');
  const databaseTarget = parseDatabaseTarget(options.databaseUrl, options.pgPassword);
  const storage = await openOwnedStorage(piSource.path);
  let backupDirectoryCreated = false;
  try {
    const afterLock = await lstat(piSource.path);
    if (!afterLock.isFile() || afterLock.dev !== piSource.dev || afterLock.ino !== piSource.ino) throw new Error('PI_STORAGE_CHANGED');
    await mkdir(dirname(outputDir), { recursive: true, mode: 0o700 });
    await mkdir(outputDir, { mode: 0o700 });
    backupDirectoryCreated = true;
    const piPath = join(outputDir, piSnapshotName);
    const pgPath = join(outputDir, pgSnapshotName);
    const blobSnapshotRoot = join(outputDir, 'blobs');
    await mkdir(blobSnapshotRoot, { mode: 0o700 });

    const pgPassword = databaseTarget.password;
    const blobs = await queryBlobManifest(options.databaseUrl, pgPassword);
    const seenPaths = new Set<string>();
    for (const blob of blobs) {
      if (seenPaths.has(blob.relativePath)) throw new Error('BLOB_PATH_DUPLICATE');
      seenPaths.add(blob.relativePath);
      await copyBlobFromSource(blobRoot, blobSnapshotRoot, blob);
    }
    const sqliteBackupPages = await snapshotPiDatabase(piSource.path, piPath);
    const pgDumpVersion = await dumpPostgres(options.databaseUrl, pgPassword, options.pgBinDir ?? defaultPgBinDir, pgPath);
    const [piHash, pgHash, ...blobHashes] = await Promise.all([
      hashFile(piPath), hashFile(pgPath),
      ...blobs.map(blob => hashFile(join(blobSnapshotRoot, ...blob.relativePath.split('/')))),
    ]);
    const manifest: BackupManifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      components: {
        pi: { file: piSnapshotName, ...piHash, sqliteBackupPages },
        postgres: { file: pgSnapshotName, format: 'custom', ...pgHash, pgDumpVersion },
        blobs: blobs.map((blob, index) => ({ ...blob, sha256: blobHashes[index]!.sha256, size: blobHashes[index]!.size })),
      },
    };
    await writeFile(join(outputDir, manifestName), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return manifest;
  } catch (error) {
    if (backupDirectoryCreated) await rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await storage.close(backgroundContext);
  }
}

async function walkFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const fullPath = join(current, entry.name);
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) throw new Error('SYMLINK_NOT_ALLOWED');
    if (info.isDirectory()) result.push(...await walkFiles(root, fullPath));
    else if (info.isFile()) result.push(relative(root, fullPath).split(sep).join('/'));
    else throw new Error('BACKUP_COMPONENT_NOT_REGULAR');
  }
  return result;
}

function validateManifest(value: unknown): BackupManifest {
  if (!value || typeof value !== 'object') throw new Error('BACKUP_MANIFEST_INVALID');
  const manifest = value as Partial<BackupManifest>;
  if (manifest.schemaVersion !== 1 || !manifest.components || !Array.isArray(manifest.components.blobs)) throw new Error('BACKUP_MANIFEST_INVALID');
  if (manifest.components.pi?.file !== piSnapshotName || manifest.components.postgres?.file !== pgSnapshotName || manifest.components.postgres.format !== 'custom') {
    throw new Error('BACKUP_MANIFEST_INVALID');
  }
  const componentFiles = [
    manifest.components.pi,
    manifest.components.postgres,
    ...manifest.components.blobs,
  ] as Array<{ sha256: string; size: number; relativePath?: string }>;
  for (const component of componentFiles) {
    normalizeDigest(component.sha256);
    if (!Number.isSafeInteger(component.size) || component.size < 0) throw new Error('BACKUP_MANIFEST_INVALID');
  }
  const blobPaths = new Set<string>();
  for (const blob of manifest.components.blobs) {
    const safe = validateBlobRelativePath(blob.relativePath);
    if (safe !== blob.relativePath || blobPaths.has(safe) || typeof blob.mimeType !== 'string' || !blob.mimeType) throw new Error('BACKUP_MANIFEST_INVALID');
    blobPaths.add(safe);
  }
  return manifest as BackupManifest;
}

export async function verifyBackupDirectory(backupDir: string, pgBinDir = defaultPgBinDir): Promise<BackupManifest> {
  const root = await assertExistingDirectory(backupDir);
  const manifestPath = join(root, manifestName);
  const manifestInfo = await lstat(manifestPath);
  if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile()) throw new Error('BACKUP_MANIFEST_INVALID');
  let manifest: BackupManifest;
  try { manifest = validateManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown); }
  catch { throw new Error('BACKUP_MANIFEST_INVALID'); }

  const expectedFiles = new Set<string>([manifestName, piSnapshotName, pgSnapshotName]);
  const piPath = join(root, piSnapshotName);
  const pgPath = join(root, pgSnapshotName);
  const piDigest = await hashFile(piPath);
  const pgDigest = await hashFile(pgPath);
  if (piDigest.sha256 !== manifest.components.pi.sha256 || piDigest.size !== manifest.components.pi.size
    || pgDigest.sha256 !== manifest.components.postgres.sha256 || pgDigest.size !== manifest.components.postgres.size) {
    throw new Error('BACKUP_HASH_MISMATCH');
  }
  for (const blob of manifest.components.blobs) {
    const safe = validateBlobRelativePath(blob.relativePath);
    const blobRoot = join(root, 'blobs');
    await assertNoSymlinkPath(blobRoot, safe);
    const filePath = join(blobRoot, ...safe.split('/'));
    const digest = await hashFile(filePath);
    if (digest.sha256 !== blob.sha256 || digest.size !== blob.size) throw new Error('BACKUP_HASH_MISMATCH');
    expectedFiles.add(`blobs/${safe}`);
  }
  const actualFiles = await walkFiles(root);
  if (actualFiles.length !== expectedFiles.size || actualFiles.some(path => !expectedFiles.has(path))) throw new Error('BACKUP_FILE_SET_MISMATCH');
  const tools = await pgToolPaths(pgBinDir);
  await runPgTool(tools.restore, ['--list', pgPath], process.env, 'PG_ARCHIVE_INVALID', 30_000);
  const piCheck = new DatabaseSync(piPath, { readOnly: true });
  try {
    validatePiDatabase(piCheck);
  } finally { piCheck.close(); }
  return manifest;
}

async function assertDatabaseEmpty(databaseUrl: string, password: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, password });
  try {
    const result = await pool.query<{ relation_count: number; schema_count: number }>(`
      SELECT
        (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg_toast%'
           AND c.relkind IN ('r','p','S','v','m','f')) AS relation_count,
        (SELECT count(*)::int FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public') AND nspname NOT LIKE 'pg_%') AS schema_count
    `);
    if (result.rows[0]?.relation_count !== 0 || result.rows[0]?.schema_count !== 0) throw new Error('RESTORE_DATABASE_NOT_EMPTY');
  } finally { await pool.end(); }
}

async function assertRestoredBlobs(databaseUrl: string, password: string, expected: BlobManifestEntry[]): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, password });
  try {
    const result = await pool.query<{ relative_path: string; sha256: string; byte_size: string | number; mime_type: string }>(
      `SELECT relative_path, sha256, byte_size, mime_type FROM pd_blobs ORDER BY relative_path`,
    );
    const actual = result.rows.map(row => ({
      relativePath: row.relative_path,
      sha256: normalizeDigest(row.sha256),
      size: Number(row.byte_size),
      mimeType: row.mime_type,
    }));
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('RESTORED_BLOB_METADATA_MISMATCH');
  } finally { await pool.end(); }
}

async function copyBackupBlobs(backupDir: string, targetRoot: string, blobs: BlobManifestEntry[]): Promise<void> {
  await mkdir(targetRoot, { mode: 0o700 });
  for (const blob of blobs) {
    const safe = validateBlobRelativePath(blob.relativePath);
    const sourceRoot = join(backupDir, 'blobs');
    await assertNoSymlinkPath(sourceRoot, safe);
    const source = join(sourceRoot, ...safe.split('/'));
    const bytes = await readRegularFileNoFollow(source);
    if (createHash('sha256').update(bytes).digest('hex') !== blob.sha256 || bytes.byteLength !== blob.size) throw new Error('BACKUP_HASH_MISMATCH');
    const destination = join(targetRoot, ...safe.split('/'));
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
  }
}

export async function restoreBackup(options: RestoreOptions): Promise<BackupManifest> {
  const pgBinDir = options.pgBinDir ?? defaultPgBinDir;
  const manifest = await verifyBackupDirectory(options.backupDir, pgBinDir);
  const piTarget = resolve(options.piStoragePath);
  const blobTarget = resolve(options.blobRoot);
  await Promise.all([assertAbsent(piTarget), assertAbsent(blobTarget)]);
  const backupRoot = await realpath(options.backupDir);
  if (pathsOverlap(piTarget, blobTarget) || pathsOverlap(piTarget, backupRoot) || pathsOverlap(blobTarget, backupRoot)) throw new Error('RESTORE_TARGETS_OVERLAP');
  const database = parseDatabaseTarget(options.databaseUrl, options.pgPassword);
  await assertDatabaseEmpty(options.databaseUrl, database.password);
  const tools = await pgToolPaths(pgBinDir);
  const piSnapshot = join(backupRoot, piSnapshotName);
  const pgSnapshot = join(backupRoot, pgSnapshotName);

  await mkdir(dirname(piTarget), { recursive: true, mode: 0o700 });
  await mkdir(dirname(blobTarget), { recursive: true, mode: 0o700 });
  const piBytes = await readRegularFileNoFollow(piSnapshot);
  if (createHash('sha256').update(piBytes).digest('hex') !== manifest.components.pi.sha256 || piBytes.byteLength !== manifest.components.pi.size) {
    throw new Error('BACKUP_HASH_MISMATCH');
  }
  await writeFile(piTarget, piBytes, { flag: 'wx', mode: 0o600 });
  try {
    const piCheck = new DatabaseSync(piTarget, { readOnly: true });
    try {
      validatePiDatabase(piCheck);
    } finally { piCheck.close(); }
    await copyBackupBlobs(backupRoot, blobTarget, manifest.components.blobs);
    const pgArgs = ['--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', ...pgArguments(database), pgSnapshot];
    await runPgTool(tools.restore, pgArgs, pgEnvironment(database), 'PG_RESTORE_FAILED');
    await assertRestoredBlobs(options.databaseUrl, database.password, manifest.components.blobs);
    return manifest;
  } catch (error) {
    // Targets are required to be new; leave any created files in place for explicit operator inspection.
    throw error;
  }
}
