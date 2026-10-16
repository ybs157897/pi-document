import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { PARSER_NETWORK_DENY_PROFILE, ParserNetworkIsolationError, parserWorkerCommand } from '../../src/ingestion/parser-sandbox.js';

test('the parser worker uses a verified per-process macOS network deny profile', { skip: process.platform !== 'darwin', timeout: 10_000 }, async () => {
  const server = createServer();
  let connectionAccepted = false;
  server.on('connection', socket => {
    connectionAccepted = true;
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const probe = [
    'const net = require("node:net");',
    `const socket = net.connect({ port: ${address.port}, host: "127.0.0.1" });`,
    'const timer = setTimeout(() => { console.log("NETWORK_UNKNOWN"); process.exit(3); }, 2500);',
    'socket.once("connect", () => { clearTimeout(timer); console.log("NETWORK_ALLOWED"); process.exit(4); });',
    'socket.once("error", error => { clearTimeout(timer); console.log("NETWORK_DENIED:" + error.code); process.exit(error.code === "EPERM" || error.code === "EACCES" ? 0 : 2); });',
  ].join('\n');

  try {
    const invocation = await parserWorkerCommand(process.platform, process.execPath, ['-e', probe]);
    assert.equal(invocation.command, '/usr/bin/sandbox-exec');
    assert.equal(invocation.args[0], '-p');
    assert.equal(invocation.args[1], PARSER_NETWORK_DENY_PROFILE);
    const child = spawn(invocation.command, invocation.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0, stderr);
    assert.match(stdout, /NETWORK_DENIED:(EPERM|EACCES)/);
    assert.equal(connectionAccepted, false);
    assert.equal(signal, null);
    const accepted = once(server, 'connection');
    await new Promise<void>((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1');
      socket.once('connect', () => { socket.end(); resolve(); });
      socket.once('error', reject);
    });
    await accepted;
    assert.equal(connectionAccepted, true, 'the parent process retains its normal loopback access');
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('the parser isolation helper fails closed on platforms without a verified network sandbox', async () => {
  await assert.rejects(parserWorkerCommand('linux', '/usr/bin/node', ['parser-worker.js', 'pdf']),
    (error: unknown) => error instanceof ParserNetworkIsolationError && error.code === 'PARSER_NETWORK_ISOLATION_UNAVAILABLE');
  await assert.rejects(parserWorkerCommand('win32', 'node.exe', ['parser-worker.js', 'docx']),
    (error: unknown) => error instanceof ParserNetworkIsolationError && error.code === 'PARSER_NETWORK_ISOLATION_UNAVAILABLE');
});
