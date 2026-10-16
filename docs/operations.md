# Offline backup, restore, and reconciliation

This procedure protects the three durable stores used by Pi Document: Pi Durable's SQLite file, PostgreSQL metadata and task rows, and the content-addressed blob tree. The backup contains a SQLite snapshot, a PostgreSQL custom-format dump, a copy of every blob referenced by `pd_blobs`, and a SHA-256 manifest. The restore command verifies the manifest and component hashes before it writes to the requested targets.

## Requirements and write controls

- Use Node.js 24 and PostgreSQL 17.x tools at version 17.10 or later; keep `pg_dump` and `pg_restore` on that same major version. Set `PG_BIN_DIR` if the binaries are not under `.cache/postgres/bin`.
- Stop the Pi Document service and every other writer to its PostgreSQL database or blob directory. Wait for in-flight saves to finish. The backup takes the Pi SQLite owner lock and refuses to run while a Pi runtime owns that file, but the three stores do not share a distributed transaction.
- Keep PostgreSQL running for `pg_dump`. Do not run application writes while the SQLite snapshot, PostgreSQL dump, and blob copy are being made.
- Inject database credentials through a protected environment or secrets manager. Do not put passwords in command arguments, shell history, backup paths, or the manifest. `PGPASSWORD` may supply the password separately from `DATABASE_URL`; the script passes it to PostgreSQL clients through their environment. The scripts do not load `.env` files.
- Store backups on a separate protected volume. Restrict access: the archive contains the complete document contents and database metadata.

Run the end-to-end acceptance test from the repository with `node --import tsx --test tests/ops/backup-restore.test.ts`. It starts temporary PostgreSQL 17 instances with the configured local binaries and writes a sanitized result to `evidence/m4/backup-restore.json`.

Provide the required environment for each command:

```sh
export PI_STORAGE_PATH=/var/lib/pi-document/pi.sqlite
export BLOB_ROOT=/var/lib/pi-document/blobs
export DATABASE_URL='postgresql://pi_document_backup@db.internal:5432/pi_document?sslmode=require'
export PGPASSWORD='injected-by-your-secret-manager'
export PG_BIN_DIR=/opt/postgresql/17/bin
```

The example password value is a placeholder. In production, inject the variable without writing a literal secret into a script or shell history. If the database URL itself is managed by a secret provider, it may contain the credential; keep it out of logs and reports.

## Create a backup

Choose a new output directory for each backup. The command fails if that directory already exists.

```sh
node --import tsx scripts/backup.ts --output /backup/pi-document/2026-10-16T0300Z
```

Success prints a small JSON summary with the manifest version, blob count, and component hashes. The directory contains `manifest.json`, `pi.sqlite`, `postgres.dump`, and the referenced files under `blobs/`. Preserve the whole directory as one backup unit; do not edit its manifest or components.

## Restore into replacement stores

Stop all writers first. Prepare a new empty PostgreSQL database and new, absent target paths for the Pi SQLite file and blob directory. Do not run migrations against the target database before restoring; `pg_restore` restores the schema and rows from the dump. The restore refuses a non-empty PostgreSQL database or existing Pi/blob targets.

```sh
node --import tsx scripts/restore.ts \
  --backup /backup/pi-document/2026-10-16T0300Z \
  --pi-target /var/lib/pi-document-recovered/pi.sqlite \
  --blob-target /var/lib/pi-document-recovered/blobs
```

The command verifies the manifest, SQLite integrity, PostgreSQL archive, blob hashes, and exact backup file set before restoring. PostgreSQL restore runs in a single transaction and stops on the first error. If restore fails after it has started writing targets, it deliberately leaves those paths for operator inspection. Do not retry over partial targets: preserve them for diagnosis, then prepare fresh empty targets before another attempt.

Point the service configuration to the restored Pi file, blob directory, and PostgreSQL database. Before accepting traffic, run the reconciliation check against those paths:

```sh
node --import tsx scripts/reconcile.ts
```

It reads `PI_STORAGE_PATH`, `BLOB_ROOT`, `DATABASE_URL`, and optional `PGPASSWORD` from the environment. A clean report has no `checks.issues`; warnings still require review. Reconciliation is read-only and reports `repairPerformed: false` and `fullRecoveryClaim: false`. It checks SQLite integrity and Pi task mappings, document/version-to-blob metadata, and blob file hashes, but it cannot prove every Pi scheduler checkpoint can resume. If validating state after the first runtime restart, stop the service again before running reconciliation so the read spans a quiet maintenance window.

After a clean report, start Pi Document and verify a known task and source document through the normal authenticated API before reopening writes broadly.

## Limits

This is an offline application backup and logical PostgreSQL restore, not a point-in-time recovery system. SQLite, PostgreSQL, and blobs are not captured by one cross-store transaction; a coherent backup depends on stopping all writers. This procedure and its acceptance test do not prove zero data loss during host power loss, storage-controller failure, or a crash concurrent with an unflushed PostgreSQL commit. Keep independent backup copies and test restores periodically.
