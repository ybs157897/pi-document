import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackup } from './support/backup.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function outputArgument(args: string[]): string {
  const index = args.indexOf('--output');
  if (index < 0 || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error('USAGE: backup.ts --output <new-directory>');
  if (args.filter(arg => arg === '--output').length !== 1 || args.length !== 2) throw new Error('USAGE: backup.ts --output <new-directory>');
  return resolve(args[index + 1]!);
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_:-]*/.exec(message)?.[0] ?? 'BACKUP_FAILED';
}

async function main() {
  const manifest = await createBackup({
    piStoragePath: required('PI_STORAGE_PATH'),
    blobRoot: required('BLOB_ROOT'),
    databaseUrl: required('DATABASE_URL'),
    pgPassword: process.env.PGPASSWORD,
    pgBinDir: process.env.PG_BIN_DIR,
    outputDir: outputArgument(process.argv.slice(2)),
  });
  process.stdout.write(`${JSON.stringify({ status: 'completed', backupDir: resolve(outputArgument(process.argv.slice(2))), manifestSchemaVersion: manifest.schemaVersion, blobCount: manifest.components.blobs.length, piSha256: manifest.components.pi.sha256, postgresSha256: manifest.components.postgres.sha256 })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'failed', code: safeErrorCode(error) })}\n`);
    process.exitCode = 1;
  }
}
