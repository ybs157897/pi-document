import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreBackup } from './support/backup.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function argument(args: string[], name: string): string {
  const matches = args.flatMap((value, index) => value === name ? [args[index + 1]] : []);
  if (matches.length !== 1 || !matches[0] || matches[0]!.startsWith('--')) throw new Error(`USAGE: restore.ts --backup <backup-directory> --pi-target <new-file> --blob-target <new-directory>`);
  return resolve(matches[0]!);
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z][A-Z0-9_:-]*/.exec(message)?.[0] ?? 'RESTORE_FAILED';
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 6) throw new Error('USAGE: restore.ts --backup <backup-directory> --pi-target <new-file> --blob-target <new-directory>');
  const manifest = await restoreBackup({
    backupDir: argument(args, '--backup'),
    piStoragePath: argument(args, '--pi-target'),
    blobRoot: argument(args, '--blob-target'),
    databaseUrl: required('DATABASE_URL'),
    pgPassword: process.env.PGPASSWORD,
    pgBinDir: process.env.PG_BIN_DIR,
  });
  process.stdout.write(`${JSON.stringify({ status: 'restored', backupSchemaVersion: manifest.schemaVersion, blobCount: manifest.components.blobs.length, piStoragePath: resolve(argument(args, '--pi-target')), blobRoot: resolve(argument(args, '--blob-target')) })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'failed', code: safeErrorCode(error) })}\n`);
    process.exitCode = 1;
  }
}
