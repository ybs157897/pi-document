import assert from 'node:assert/strict';
import test from 'node:test';
import { rrf, tokenize } from '../../src/retrieval/lexical.js';

test('Chinese Intl.Segmenter tokenizer has stable word-like tokens', () => {
  assert.deepEqual(tokenize('任务恢复'), ['任务', '恢复']);
  assert.deepEqual(tokenize('合同编号 DOC-42 café 🙂'), ['合同', '编号', 'doc', '42', 'café']);
  assert.deepEqual(tokenize('！！！'), []);
});

test('RRF deduplicates within rankings and sorts score ties by chunkId', () => {
  const fused = rrf([
    [{ chunkId: 'z', rank: 1 }, { chunkId: 'z', rank: 8 }, { chunkId: 'b', rank: 2 }],
    [{ chunkId: 'b', rank: 1 }, { chunkId: 'a', rank: 1 }],
  ]);
  assert.deepEqual(fused.map(item => item.chunkId), ['b', 'a', 'z']);
  assert.equal(fused[0]?.rank, 1);
  assert.ok(fused[0]!.score > fused[1]!.score);
  assert.equal(fused[1]?.score, fused[2]?.score);
  assert.deepEqual(rrf([]), []);
});

test('RRF rejects invalid ranking entries and reciprocal-rank constants', () => {
  assert.throws(() => rrf([[{ chunkId: 'bad', rank: 0 }]]), /RRF_RANKING_INVALID/);
  assert.throws(() => rrf([], 0), /RRF_K_INVALID/);
});
