import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { Pool } from 'pg';
import { promisify } from 'node:util';
import { DocumentRuntime } from '../../src/runtime/document-runtime.js';
import { PostgresDocumentBackend, migrate } from '../../src/domain/service.js';
import type { DocumentRequest, Principal, StoredTask } from '../../src/domain/types.js';
import { LocalPostgres } from '../../scripts/support/local-postgres.js';
import { createBackup, verifyBackupDirectory } from '../../scripts/support/backup.js';
import { runReconciliation } from '../../scripts/reconcile.js';

const pgBinDir = resolve('.cache/postgres/bin');
const execFileAsync = promisify(execFile);
const scopes: Principal['scopes'] = ['knowledge:read', 'knowledge:write', 'knowledge:delete'];
const startedPostgres: LocalPostgres[] = [];
const openPools: Pool[] = [];

after(async () => {
  for (const pool of openPools.splice(0)) await pool.end().catch(() => undefined);
  for (const postgres of startedPostgres.splice(0)) await postgres.stop().catch(() => undefined);
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

async function startPostgres(root: string, name: string, password: string): Promise<LocalPostgres> {
  const postgres = new LocalPostgres({ dataDir: join(root, name), binDir: pgBinDir, port: await freePort(), password });
  await postgres.start();
  startedPostgres.push(postgres);
  return postgres;
}

function makePool(postgres: LocalPostgres): Pool {
  const pool = new Pool({ connectionString: postgres.url, max: 8, connectionTimeoutMillis: 5_000 });
  openPools.push(pool);
  return pool;
}

async function waitForTask(backend: PostgresDocumentBackend, principal: Principal, id: string): Promise<StoredTask> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const task = await backend.getTask(principal, id);
    if (task.state === 'completed' || task.state === 'failed' || task.state === 'canceled') return task;
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
  throw new Error('M4_TASK_TIMEOUT');
}

async function submitAndWait(
  runtime: DocumentRuntime, backend: PostgresDocumentBackend, principal: Principal, request: DocumentRequest,
): Promise<StoredTask> {
  const submitted = await runtime.submit(principal, request);
  return waitForTask(backend, principal, submitted.id);
}

function rejectionCode(error: unknown): string {
  return error instanceof Error ? error.message.split(':')[0]! : '';
}

function cliEnvironment(postgres: LocalPostgres, piStoragePath: string, blobRoot: string): NodeJS.ProcessEnv {
  const databaseUrl = new URL(postgres.url);
  databaseUrl.password = '';
  return {
    ...process.env,
    PI_STORAGE_PATH: piStoragePath,
    BLOB_ROOT: blobRoot,
    DATABASE_URL: databaseUrl.toString(),
    PGPASSWORD: postgres.options.password,
    PG_BIN_DIR: pgBinDir,
  };
}

function runOpsScript(script: string, args: string[], postgres: LocalPostgres, piStoragePath: string, blobRoot: string) {
  return execFileAsync(process.execPath, ['--import', 'tsx', script, ...args], {
    env: cliEnvironment(postgres, piStoragePath, blobRoot), timeout: 120_000,
  });
}

async function expectCliFailure(command: Promise<{ stdout: string; stderr: string }>, code: string): Promise<void> {
  await assert.rejects(command, error => {
    const stderr = (error as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '';
    assert.match(stderr, new RegExp(`"code":"${code}"`));
    return true;
  });
}

test('offline backup restores Pi, PostgreSQL, and source bytes and rejects unsafe restore inputs', { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-document-m4-'));
  const password = randomBytes(24).toString('hex');
  const sourceRoot = join(root, 'source');
  const targetRoot = join(root, 'restored');
  const backupDir = join(root, 'backup');
  let sourcePg: LocalPostgres | undefined;
  let targetPg: LocalPostgres | undefined;
  let sourcePool: Pool | undefined;
  const sourcePi = join(sourceRoot, 'pi.sqlite');
  const sourceBlobs = join(sourceRoot, 'blobs');
  const targetPi = join(targetRoot, 'pi.sqlite');
  const targetBlobs = join(targetRoot, 'blobs');
  const token = `m4-${randomBytes(24).toString('hex')}`;
  const principal: Principal = { tenantId: 'm4-tenant', id: 'm4-operator', scopes };
  let sourceRuntime: DocumentRuntime | undefined;
  let restoredRuntime: DocumentRuntime | undefined;
  let reportWritten = false;

  try {
    sourcePg = await startPostgres(root, 'source-pg', password);
    targetPg = await startPostgres(root, 'target-pg', password);
    sourcePool = makePool(sourcePg);
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 });
    await migrate(sourcePool);
    const sourceBackend = new PostgresDocumentBackend({ pool: sourcePool, blobRoot: sourceBlobs, publicBaseUrl: 'https://documents.example.test' });
    await sourceBackend.provisionPrincipal({ ...principal, token });
    sourceRuntime = await DocumentRuntime.open(sourceBackend, sourcePi);

    const kbTask = await submitAndWait(sourceRuntime, sourceBackend, principal, {
      schemaVersion: '1.0', operation: 'knowledge_base.create', requestId: `m4-kb-${randomUUID()}`,
      input: { name: 'M4 restore acceptance', description: 'offline backup and restore fixture' },
    });
    assert.equal(kbTask.state, 'completed');
    const knowledgeBaseId = kbTask.result?.result?.knowledgeBaseId;
    assert.equal(typeof knowledgeBaseId, 'string');

    const originalText = '# M4 恢复验收 😀\n保存后需原样读取。\n';
    const savedTask = await submitAndWait(sourceRuntime, sourceBackend, principal, {
      schemaVersion: '1.0', operation: 'document.save', requestId: `m4-save-${randomUUID()}`,
      knowledgeBaseId: knowledgeBaseId as string,
      input: { title: 'M4 原文', source: { kind: 'text', text: originalText, mimeType: 'text/markdown' }, waitFor: 'stored' },
    });
    assert.equal(savedTask.state, 'completed');
    assert.ok(savedTask.piTaskId !== null && savedTask.piConversationId !== null);
    assert.equal(savedTask.result?.result?.indexState, 'stored');
    const documentId = savedTask.result?.result?.documentId;
    assert.equal(typeof documentId, 'string');

    let runningOwnerRejected = false;
    try {
      await createBackup({ piStoragePath: sourcePi, blobRoot: sourceBlobs, databaseUrl: sourcePg.url,
        pgBinDir, outputDir: join(root, 'must-not-be-created') });
    } catch (error) {
      runningOwnerRejected = rejectionCode(error) === 'PI_STORAGE_ALREADY_OWNED';
      assert.equal(runningOwnerRejected, true, String(error));
    }
    assert.equal(runningOwnerRejected, true);

    await sourceRuntime.close();
    sourceRuntime = undefined;
    await sourcePool.end();
    const sourcePoolIndex = openPools.indexOf(sourcePool);
    if (sourcePoolIndex >= 0) openPools.splice(sourcePoolIndex, 1);

    const backupOutput = await runOpsScript('scripts/backup.ts', ['--output', backupDir], sourcePg, sourcePi, sourceBlobs);
    const backupSummary = JSON.parse(backupOutput.stdout) as { status: string; blobCount: number };
    assert.equal(backupSummary.status, 'completed');
    const manifest = await verifyBackupDirectory(backupDir, pgBinDir);
    assert.equal(manifest.components.blobs.length, 1);
    assert.equal(backupSummary.blobCount, manifest.components.blobs.length);
    assert.equal(manifest.components.postgres.format, 'custom');

    sourcePool = makePool(sourcePg);
    const changedBackend = new PostgresDocumentBackend({ pool: sourcePool, blobRoot: sourceBlobs, publicBaseUrl: 'https://documents.example.test' });
    sourceRuntime = await DocumentRuntime.open(changedBackend, sourcePi);
    const afterBackupTask = await submitAndWait(sourceRuntime, changedBackend, principal, {
      schemaVersion: '1.0', operation: 'document.save', requestId: `m4-not-in-backup-${randomUUID()}`,
      knowledgeBaseId: knowledgeBaseId as string,
      input: { title: '备份后新增', source: { kind: 'text', text: 'This write occurred after the snapshot.' }, waitFor: 'stored' },
    });
    assert.equal(afterBackupTask.state, 'completed');
    await sourceRuntime.close(); sourceRuntime = undefined;
    await appendFile(join(sourceBlobs, ...manifest.components.blobs[0]!.relativePath.split('/')), '\nsource changed after backup\n');

    const restoreOutput = await runOpsScript('scripts/restore.ts', ['--backup', backupDir, '--pi-target', targetPi,
      '--blob-target', targetBlobs], targetPg, targetPi, targetBlobs);
    const restoreSummary = JSON.parse(restoreOutput.stdout) as { status: string; blobCount: number };
    assert.equal(restoreSummary.status, 'restored');
    assert.equal(restoreSummary.blobCount, manifest.components.blobs.length);
    const targetPool = makePool(targetPg);
    const restoredBackend = new PostgresDocumentBackend({ pool: targetPool, blobRoot: targetBlobs, publicBaseUrl: 'https://documents.example.test' });
    const restoredPrincipal = await restoredBackend.authenticate(token);
    assert.deepEqual(restoredPrincipal, principal);
    await assert.rejects(restoredBackend.getTask(principal, afterBackupTask.id), error => (error as { code?: string }).code === 'TASK_NOT_FOUND');
    assert.equal((await targetPool.query('SELECT count(*)::int AS count FROM pd_documents')).rows[0].count, 1);

    const reconciliation = await runReconciliation({ piStoragePath: targetPi, blobRoot: targetBlobs, databaseUrl: targetPg.url });
    const checks = reconciliation.checks as { issues: Array<{ code: string }> };
    assert.deepEqual(checks.issues, []);
    assert.equal(reconciliation.repairPerformed, false);
    assert.equal(reconciliation.fullRecoveryClaim, false);

    const restoredTask = await restoredBackend.getTask(restoredPrincipal!, savedTask.id);
    assert.equal(restoredTask.state, 'completed');
    assert.equal(restoredTask.piTaskId, savedTask.piTaskId);
    assert.equal(restoredTask.piConversationId, savedTask.piConversationId);
    const restoredContent = await restoredBackend.readContent(restoredPrincipal!, documentId as string, 1);
    assert.equal(restoredContent.bytes.toString('utf8'), originalText);
    assert.equal(restoredContent.mimeType, 'text/markdown');

    restoredRuntime = await DocumentRuntime.open(restoredBackend, targetPi);
    const secondTask = await submitAndWait(restoredRuntime, restoredBackend, restoredPrincipal!, {
      schemaVersion: '1.0', operation: 'document.save', requestId: `m4-after-restore-${randomUUID()}`,
      knowledgeBaseId: knowledgeBaseId as string,
      input: { title: '恢复后新写入', source: { kind: 'text', text: 'restored runtime accepts a new write', mimeType: 'text/markdown' }, waitFor: 'stored' },
    });
    assert.equal(secondTask.state, 'completed');
    assert.ok(secondTask.piTaskId !== null && secondTask.piConversationId !== null);
    await restoredRuntime.close();
    restoredRuntime = undefined;

    const nonEmptyRejectedPi = join(root, 'nonempty-target/pi.sqlite');
    const nonEmptyRejectedBlobs = join(root, 'nonempty-target/blobs');
    await expectCliFailure(runOpsScript('scripts/restore.ts', ['--backup', backupDir, '--pi-target', nonEmptyRejectedPi,
      '--blob-target', nonEmptyRejectedBlobs], targetPg, nonEmptyRejectedPi, nonEmptyRejectedBlobs), 'RESTORE_DATABASE_NOT_EMPTY');

    const blob = manifest.components.blobs[0]!;
    await appendFile(join(backupDir, 'blobs', ...blob.relativePath.split('/')), '\ncorruption\n');
    await assert.rejects(verifyBackupDirectory(backupDir, pgBinDir), error => rejectionCode(error) === 'BACKUP_HASH_MISMATCH');
    const tamperedPi = join(root, 'tampered-target/pi.sqlite');
    const tamperedBlobs = join(root, 'tampered-target/blobs');
    await expectCliFailure(runOpsScript('scripts/restore.ts', ['--backup', backupDir, '--pi-target', tamperedPi,
      '--blob-target', tamperedBlobs], targetPg, tamperedPi, tamperedBlobs), 'BACKUP_HASH_MISMATCH');

    await mkdir('evidence/m4', { recursive: true });
    await writeFile('evidence/m4/backup-restore.json', `${JSON.stringify({
      schemaVersion: 1,
      status: 'passed',
      generatedAt: new Date().toISOString(),
      node: process.version,
      postgresTools: manifest.components.postgres.pgDumpVersion,
      test: 'real Pi Durable SQLite + M1 PostgreSQL/blob backup and restore',
      results: {
        livePiOwnerRefusesBackup: runningOwnerRejected,
        backupAndRestoreCliCommandsPassed: true,
        backupManifestVerifiedBeforeRestore: true,
        sourceChangedAfterBackupWithoutChangingSnapshot: true,
        postBackupTaskAbsentFromRestoredStores: true,
        backupBlobCount: manifest.components.blobs.length,
        restoredPostgresTasksAndDocumentMetadata: true,
        restoredPiTaskMapping: true,
        restoredOriginalBytesAndMimeType: true,
        newWriteAfterRestore: true,
        reconcileIssueCount: checks.issues.length,
        reconcileReadOnly: reconciliation.mode === 'read_only' && reconciliation.repairPerformed === false,
        nonEmptyPostgresTargetRejected: true,
        modifiedBlobBackupRejectedByVerifyAndRestore: true,
      },
      limitation: 'This test validates an offline logical backup and restore flow; it does not prove zero data loss during host power loss.',
    }, null, 2)}\n`, { mode: 0o600 });
    reportWritten = true;
  } finally {
    await sourceRuntime?.close().catch(() => undefined);
    await restoredRuntime?.close().catch(() => undefined);
    for (const pool of openPools.splice(0)) await pool.end().catch(() => undefined);
    for (const postgres of startedPostgres.splice(0)) await postgres.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(reportWritten, true);
});
