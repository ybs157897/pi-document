import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context, withCancel } from '@earendil-works/chord/context';
import { openProbe } from './probe-task.js';

test('real Pi SQLite survives SIGKILL after external receipt and reuses one task/effect', { timeout: 20_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-durable-crash-'));
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/runtime/crash-child.ts', directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error(`child did not reach effect: ${stderr}`)), 10_000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('EFFECT_COMMITTED')) { clearTimeout(timer); resolve(); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`child exited ${code}: ${stderr}`)); });
    });
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const probe = await openProbe(directory);
    const taskId = await probe.admit('crash-key');
    try {
      probe.harness.resume();
      const settled = await probe.harness.waitForTask(taskId, context);
      assert.equal(settled.state.outcome.status, 'completed');
      assert.equal(probe.count(), 1);
      assert.equal(probe.attempts(), 1);
      for (let i = 0; i < 20; i++) assert.equal(await probe.admit('crash-key'), taskId);
      await assert.rejects(probe.admit('crash-key', 'different'), /IDEMPOTENCY_CONFLICT/);
    } finally { await probe.close(); }
    const reopened = await openProbe(directory);
    try {
      assert.equal(await reopened.admit('crash-key'), taskId);
      assert.equal((await reopened.harness.waitForTask(taskId, context)).state.outcome.status, 'completed');
      assert.equal(reopened.attempts(), 0);
      assert.equal(reopened.count(), 1);
    } finally { await reopened.close(); }
    const db = new DatabaseSync(`${directory}/pi.sqlite`);
    assert.equal((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'wal');
    db.close();
    await mkdir('evidence/m0', { recursive: true });
    await writeFile('evidence/m0/pi-durable.json', JSON.stringify({
      status: 'passed', node: process.version, pi: '1.3.0', journalMode: 'wal', adapterSynchronous: 'NORMAL',
      crashWindow: 'external receipt committed, Pi terminal checkpoint not committed',
      signal: 'SIGKILL', receiptCount: 1, taskIdStableAcross20Retries: true, terminalReopenReexecutionCount: 0,
      limitation: 'Probe receipt uses separate SQLite. PostgreSQL outbox and host-power-loss durability are not proven here.',
    }, null, 2) + '\n');
  } finally { child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});

test('canceling a waiter leaves the durable task running; explicit abort settles separately', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-wait-cancel-'));
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let enteredAbort!: () => void;
  const abortEntered = new Promise<void>(resolve => { enteredAbort = resolve; });
  const probe = await openProbe(directory, async (key, signal) => {
    if (key === 'wait-key') return blocked;
    enteredAbort();
    await new Promise<void>((_resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  try {
    const taskId = await probe.admit('wait-key');
    const waiter = withCancel(context);
    const waiting = probe.harness.waitForTask(taskId, waiter.context);
    waiter.cancel();
    await assert.rejects(waiting);
    assert.notEqual((await probe.harness.getTask(taskId, context))?.state.status, 'terminal');
    release();
    assert.equal((await probe.harness.waitForTask(taskId, context)).state.outcome.status, 'completed');
    const abortId = await probe.admit('abort-key');
    await abortEntered;
    await probe.harness.abortTask(abortId, context);
    assert.equal((await probe.harness.waitForTask(abortId, context)).state.outcome.status, 'aborted');
  } finally { release(); await probe.close(); await rm(directory, { recursive: true, force: true }); }
});
