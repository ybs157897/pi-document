import assert from 'node:assert/strict';
import test from 'node:test';
import { Limiter } from '../../src/runtime/limiter.js';

test('limits actual concurrent work and releases permits after failures', async () => {
  const limiter = new Limiter(3);
  const signal = new AbortController().signal;
  let running = 0, peak = 0;
  const settled = await Promise.allSettled(Array.from({ length: 15 }, (_, index) => limiter.run(signal, async () => {
    running++; peak = Math.max(peak, running);
    try { await new Promise(resolve => setTimeout(resolve, 5)); if (index === 4) throw new Error('expected'); }
    finally { running--; }
  })));
  assert.equal(peak, 3); assert.equal(running, 0);
  assert.equal(settled.filter(item => item.status === 'rejected').length, 1);
  assert.equal(await limiter.run(signal, async () => 'available'), 'available');
});

test('an aborted queued operation never enters and does not consume a permit', async () => {
  const limiter = new Limiter(1);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = limiter.run(new AbortController().signal, () => gate);
  const canceled = new AbortController();
  let entered = false;
  const queued = limiter.run(canceled.signal, async () => { entered = true; });
  canceled.abort(new Error('cancelled before admission'));
  await assert.rejects(queued, /cancelled before admission/);
  release(); await first;
  assert.equal(entered, false);
  assert.equal(await limiter.run(new AbortController().signal, async () => 1), 1);
});
