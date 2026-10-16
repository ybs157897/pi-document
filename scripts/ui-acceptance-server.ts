import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalPostgres } from './support/local-postgres.js';
import { startApp } from '../src/app.js';
import { serviceConfig } from '../src/config/service.js';

const root = await mkdtemp(join(tmpdir(), 'pi-document-ui-acceptance-'));
const portProbe = createServer();
await new Promise<void>(done => portProbe.listen(0, '127.0.0.1', done));
const address = portProbe.address();
if (!address || typeof address === 'string') throw new Error('No PostgreSQL port');
await new Promise<void>(done => portProbe.close(() => done()));
const postgres = new LocalPostgres({ dataDir: join(root, 'postgres'), port: address.port, password: randomBytes(24).toString('hex') });
const token = randomBytes(32).toString('base64url');
const originalFetch = globalThis.fetch;
let injectedFailures = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (process.env.EMBEDDING_BASE_URL && url.origin === new URL(process.env.EMBEDDING_BASE_URL).origin && url.pathname.endsWith('/embeddings')) {
    const faultFile = resolve('.cache/ui-acceptance/embedding-fault.json');
    let fault: { remaining: number; match: string } | undefined;
    try { fault = JSON.parse(await readFile(faultFile, 'utf8')); } catch { /* No fault armed. */ }
    if (fault && Number.isInteger(fault.remaining) && fault.remaining > 0 && typeof init?.body === 'string' && init.body.includes(fault.match)) {
      await writeFile(faultFile, JSON.stringify({ ...fault, remaining: fault.remaining - 1 }), { mode: 0o600 });
      injectedFailures++;
      await writeFile('.cache/ui-acceptance/fault-receipt.json', JSON.stringify({ injectedFailures, reason: 'deterministic 503 fixture before real embedding recovery' }), { mode: 0o600 });
      return new Response('{}', { status: 503, headers: { 'Content-Type': 'application/json', 'Retry-After': '0' } });
    }
  }
  return originalFetch(input, init);
};
let app: Awaited<ReturnType<typeof startApp>> | undefined;
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => {
  globalThis.fetch = originalFetch;
  try { await app?.close(); } finally {
    await postgres.stop(); await rm(root, { recursive: true, force: true });
  }
})();
try {
  await postgres.start();
  app = await startApp(serviceConfig({ ...process.env, DATABASE_URL: postgres.url, PORT: process.env.UI_ACCEPTANCE_PORT ?? '4330',
    PI_STORAGE_PATH: join(root, 'pi.sqlite'), BLOB_ROOT: join(root, 'blobs'),
    AUTH_BOOTSTRAP_TOKEN: token, AUTH_TENANT_ID: 'ui-acceptance', AUTH_PRINCIPAL_ID: 'ui-admin', LOG_LEVEL: 'silent',
  }));
  await mkdir('.cache/ui-acceptance', { recursive: true, mode: 0o700 });
  const file = resolve('.cache/ui-acceptance/session.json');
  await writeFile(file, JSON.stringify({ baseUrl: app.baseUrl, token }), { mode: 0o600 });
  console.log(JSON.stringify({ event: 'ready', baseUrl: app.baseUrl, tokenFile: file, data: 'isolated temporary database; removed on shutdown' }));
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void close().then(() => process.exit(0)); });
} catch (error) { await close(); throw error; }
