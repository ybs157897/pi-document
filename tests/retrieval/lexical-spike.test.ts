import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildTsQuery, runLexicalSpike, tokenize } from '../../scripts/lexical-spike.js';

type QueryFixture = {
  id: string;
  kind: 'exact_terms' | 'identifier' | 'synonym_probe';
  query: string;
  expectedDocumentIds: string[];
  note?: string;
};
const fixturePath = fileURLToPath(new URL('../../fixtures/retrieval/lexical-cases.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as { queries: QueryFixture[] };

test('fixed lexical fixture covers at least 20 exact-term and identifier cases', () => {
  const lexicalCases = fixture.queries.filter(item => item.kind !== 'synonym_probe');
  assert.ok(lexicalCases.length >= 20);
  const hanQueries = fixture.queries.filter(item => /[\p{Script=Han}]/u.test(item.query));
  assert.ok(hanQueries.length >= 20, `expected at least 20 Chinese query expressions, got ${hanQueries.length}`);
  assert.ok(lexicalCases.some(item => item.kind === 'identifier'));
  assert.ok(lexicalCases.some(item => /[\p{Script=Han}]/u.test(item.query)));
  assert.ok(fixture.queries.every(item => item.expectedDocumentIds.length > 0 || item.kind === 'synonym_probe'));
});

test('synonym probes are explicit no-hit observations, not semantic acceptance cases', () => {
  const probes = fixture.queries.filter(item => item.kind === 'synonym_probe');
  assert.ok(probes.length >= 3);
  assert.ok(probes.every(item => item.expectedDocumentIds.length === 0 && item.note?.length));
});

test('Chinese tokenizer and tsquery builder use the same stable token sequence', () => {
  const tokens = tokenize('任务恢复');
  assert.deepEqual(tokens, ['任务', '恢复']);
  assert.equal(buildTsQuery(tokens), "'任务' & '恢复'");
  assert.throws(() => buildTsQuery(['safe & injected']), /unsupported text-search token/);
});

test('temporary PostgreSQL 17 executes the real lexical corpus and records evidence', { timeout: 30_000 }, async () => {
  const evidence = await runLexicalSpike();
  const summary = evidence.summary as {
    casesRun: number;
    segmentedExpectedHits: number;
    synonymProbesWithNoLiteralHit: number;
  };
  const strategy = evidence.strategy as {
    nativeComparison: { native_match: boolean; segmented_match: boolean };
    semanticLimitation: string;
  };

  assert.equal(summary.casesRun, fixture.queries.length);
  assert.equal(summary.segmentedExpectedHits, fixture.queries.filter(item => item.kind !== 'synonym_probe').length);
  assert.equal(summary.synonymProbesWithNoLiteralHit, fixture.queries.filter(item => item.kind === 'synonym_probe').length);
  assert.equal(strategy.nativeComparison.native_match, false);
  assert.equal(strategy.nativeComparison.segmented_match, true);
  assert.match(strategy.semanticLimitation, /not evaluated|unverified/i);
});
