import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { startApp } from '../src/app.js';
import { serviceConfig } from '../src/config/service.js';
import { LocalPostgres } from './support/local-postgres.js';

await mkdir('data/dev', { recursive: true, mode: 0o700 });
async function localSecret(name: string) {
  const path = `data/dev/${name}`;
  try { return (await readFile(path, 'utf8')).trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = randomBytes(32).toString('base64url');
    await writeFile(path, value + '\n', { flag: 'wx', mode: 0o600 });
    return value;
  }
}
const portProbe = createServer();
await new Promise<void>(resolve => portProbe.listen(0, '127.0.0.1', resolve));
const address = portProbe.address();
if (!address || typeof address === 'string') throw new Error('Port allocation failed');
const port = address.port;
await new Promise<void>(resolve => portProbe.close(() => resolve()));
const password = await localSecret('postgres-password');
const token = process.env.AUTH_BOOTSTRAP_TOKEN ?? await localSecret('api-token');
let nativeAvailable = false;
try { await access('.cache/postgres/bin/postgres'); nativeAvailable = true; } catch { /* M1 can run with the bundled database. */ }
if (process.env.EMBEDDING_MODEL_ID && !nativeAvailable) throw new Error('Vector development database is missing; run npm run setup:postgres first');
const native = nativeAvailable ? new LocalPostgres({ dataDir: 'data/dev/postgres-native', port, password }) : undefined;
const embedded = new EmbeddedPostgres({ databaseDir: resolve('data/dev/postgres'), user: 'postgres', password, port, persistent: true,
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => undefined, onError: () => undefined,
});
const stopDatabase = () => native ? native.stop() : embedded.stop();
let app: Awaited<ReturnType<typeof startApp>> | undefined;
try {
  if (native) await native.start();
  else {
    try { await readFile('data/dev/postgres/PG_VERSION', 'utf8'); } catch { await embedded.initialise(); }
    await embedded.start();
  }
  const databaseUrl = native ? native.url : `postgresql://postgres:${encodeURIComponent(password)}@127.0.0.1:${port}/postgres`;
  await writeFile('data/dev/connection.json', JSON.stringify({ databaseUrl }), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { ...process.env, DATABASE_URL: databaseUrl, AUTH_BOOTSTRAP_TOKEN: token };
  app = await startApp(serviceConfig(env));
  console.log(JSON.stringify({ event: 'ready', baseUrl: app.baseUrl, tokenFile: process.env.AUTH_BOOTSTRAP_TOKEN ? null : 'data/dev/api-token', indexing: !!env.EMBEDDING_MODEL_ID }));
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    if (closing) return; closing = true;
    void (async () => { try { await app?.close(); } finally { await stopDatabase(); } })().then(() => process.exit(0));
  });
} catch (error) { await app?.close(); await stopDatabase().catch(() => undefined); throw error; }
