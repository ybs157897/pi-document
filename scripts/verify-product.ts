import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

await mkdir('evidence/final', { recursive: true });
const startedAt = new Date().toISOString();
const started = performance.now();
const logs: string[] = [];
let timedOut = false;
const result = await new Promise<{ exitCode: number | null; signal: string | null }>(resolve => {
  const child = spawn('npm', ['test'], { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid) {
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGTERM'); } catch { /* already exited */ }
    }
  }, 10 * 60_000);
  const receive = (bytes: Buffer) => { const text = bytes.toString(); logs.push(text); process.stdout.write(text); };
  child.stdout.on('data', receive); child.stderr.on('data', receive);
  child.once('exit', (exitCode, signal) => { clearTimeout(timer); resolve({ exitCode, signal }); });
  child.once('error', error => { clearTimeout(timer); logs.push(error.message); resolve({ exitCode: 1, signal: null }); });
});
await writeFile('evidence/final/product-tests.log', logs.join(''));
await writeFile('evidence/final/product-tests.json', JSON.stringify({ command: 'npm test', startedAt, completedAt: new Date().toISOString(), durationMs: performance.now() - started, timedOut, ...result, status: result.exitCode === 0 && !timedOut ? 'passed' : 'failed', log: 'product-tests.log' }, null, 2) + '\n');
process.exitCode = timedOut ? 1 : result.exitCode ?? 1;
