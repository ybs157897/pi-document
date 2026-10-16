import { mkdir, open, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

/** A separate SQLite exclusive transaction provides a process-lifetime OS lock, released even after SIGKILL. */
export async function openOwnedStorage(filename: string) {
  await mkdir(dirname(resolve(filename)), { recursive: true });
  const file = await open(filename, 'a', 0o600);
  await file.close();
  const canonical = await realpath(filename);
  const ownership = new DatabaseSync(`${canonical}.owner.sqlite`);
  try {
    ownership.exec('PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE;');
  } catch (cause) {
    ownership.close();
    const sqliteCode = (cause as { errcode?: number }).errcode;
    if (sqliteCode === 5 || sqliteCode === 6) throw new Error('PI_STORAGE_ALREADY_OWNED: another process owns this Pi storage', { cause });
    throw cause;
  }
  try {
    const storage = await openNodeSqliteStorage(canonical);
    const close = storage.close.bind(storage);
    let closed = false;
    storage.close = async context => {
      if (closed) return;
      closed = true;
      try { await close(context); } finally { ownership.close(); }
    };
    return storage;
  } catch (error) { ownership.close(); throw error; }
}
