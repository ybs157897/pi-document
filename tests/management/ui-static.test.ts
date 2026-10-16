import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import express from 'express';
import { addManagementUi } from '../../src/ui/static.js';

test('UI serves only its build entry/assets with same-origin security policy and preserves RPC routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-document-ui-static-'));
  const app = express(); const server = createServer(app);
  try {
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>Pi Document</title>');
    await writeFile(join(root, 'assets/app.js'), 'export const ready=true;');
    await writeFile(join(root, '.env'), 'PRIVATE_STATIC_FIXTURE');
    app.post('/a2a', (_request, response) => response.json({ rpc: true }));
    addManagementUi(app, root);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const entry = await fetch(base + '/');
    assert.equal(entry.status, 200); assert.match(await entry.text(), /Pi Document/);
    assert.equal(entry.headers.get('cache-control'), 'no-store');
    assert.match(entry.headers.get('content-security-policy')!, /connect-src 'self'/);
    assert.equal(entry.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(base + '/ui/')).status, 200);
    const asset = await fetch(base + '/ui/assets/app.js');
    assert.equal(asset.status, 200); assert.match(asset.headers.get('cache-control')!, /immutable/);
    assert.equal((await fetch(base + '/ui/.env')).status, 404);
    assert.equal((await fetch(base + '/ui/assets/../.env')).status, 404);
    assert.deepEqual(await (await fetch(base + '/a2a', { method: 'POST' })).json(), { rpc: true });
    await rm(join(root, 'index.html'));
    assert.equal((await fetch(base + '/')).status, 503);
  } finally {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
});
