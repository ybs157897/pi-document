import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildEvaluationSummary, metricSummary, scoreDocumentRanking, type QueryRun } from '../../scripts/eval-retrieval.js';

test('Recall@10 and MRR@10 count each document once even when multiple chunks rank first', () => {
  assert.deepEqual(scoreDocumentRanking(['doc-a', 'doc-b'], ['doc-a', 'doc-a', 'doc-b']), {
    recallAt10: 1,
    mrrAt10: 1,
  });
  assert.deepEqual(scoreDocumentRanking(['doc-c'], ['doc-x', 'doc-c']), {
    recallAt10: 1,
    mrrAt10: 0.5,
  });
});

test('no-answer and permission rows stay outside the authorized answerable metric denominator', () => {
  const makeRow = (overrides: Partial<QueryRun>): QueryRun => ({
    queryId: 'query', category: 'exact', language: 'en', split: 'development', expectedOutcome: 'results',
    expectedDocumentKeys: ['doc-a'], expectedFormats: ['txt'], status: 'completed',
    actualUniqueDocumentKeys: ['doc-a'], resultCount: 1, recallAt10: 1, mrrAt10: 1,
    supportCoverage: { expectedPassageCount: 1, locatorOverlapCount: 1, fullSnippetCount: 1 },
    citationChecks: { verified: 0, failed: 0 }, ...overrides,
  });
  const rows = [
    makeRow({ queryId: 'answer-1' }),
    makeRow({ queryId: 'answer-2', actualUniqueDocumentKeys: ['doc-x', 'doc-b'], recallAt10: 1, mrrAt10: 0.5 }),
    makeRow({ queryId: 'no-answer', category: 'no_answer', expectedOutcome: 'no_answer', expectedDocumentKeys: [],
      expectedFormats: [], actualUniqueDocumentKeys: ['doc-x'], resultCount: 1, recallAt10: undefined, mrrAt10: undefined, falsePositive: true }),
    makeRow({ queryId: 'permission', category: 'filter_permission', scenario: 'permission', expectedOutcome: 'permission_denied',
      expectedDocumentKeys: ['restricted-doc'], expectedFormats: ['pdf'], actualUniqueDocumentKeys: [], resultCount: 0,
      recallAt10: undefined, mrrAt10: undefined, denied: true, leakage: false }),
  ];
  const summary = buildEvaluationSummary(rows);
  assert.equal(summary.metrics.overall.queryCount, 2);
  assert.equal(summary.metrics.overall.recallAt10, 1);
  assert.equal(summary.metrics.overall.mrrAt10, 0.75);
  assert.equal(summary.noAnswer.falsePositiveQueryCount, 1);
  assert.equal(summary.permission.deniedQueryCount, 1);
  assert.equal(summary.permission.leakageQueryCount, 0);
  assert.equal(summary.acceptancePass, true);

  const withVersion = buildEvaluationSummary([...rows, makeRow({ queryId: 'version-v2', category: 'version',
    expectedOutcome: 'results_after_update', expectedDocumentKeys: ['doc-v'], expectedFormats: ['docx'],
    actualUniqueDocumentKeys: ['doc-v'], recallAt10: 1, mrrAt10: 1 })]);
  assert.equal(withVersion.metrics.overall.queryCount, 3);
  assert.equal(withVersion.answerableAuthorizedQueryCount, 3);
  assert.equal(withVersion.acceptancePass, true);

  const partial = buildEvaluationSummary([...rows, makeRow({ queryId: 'version-not-run', category: 'version',
    expectedOutcome: 'results_after_update', expectedDocumentKeys: ['doc-v'], expectedFormats: ['docx'],
    status: 'not_run', actualUniqueDocumentKeys: [], resultCount: 0, recallAt10: undefined, mrrAt10: undefined })]);
  assert.equal(partial.metrics.overall.queryCount, 3);
  assert.equal(partial.metrics.overall.recallAt10, 2 / 3);
  assert.equal(partial.metrics.overall.mrrAt10, 0.5);
  assert.equal(partial.completedAnswerableQueryCount, 2);
  assert.equal(partial.qualityGatePass, false);
  assert.equal(partial.status, 'failed');
  assert.equal(partial.acceptancePass, false);
  assert.equal(partial.notRunQueryCount, 1);
});

test('failed answerable queries remain in the core denominator and contribute zero', () => {
  const row = (queryId: string, status: QueryRun['status'], recallAt10: number, mrrAt10: number): QueryRun => ({
    queryId, category: 'exact', language: 'zh', split: 'development', expectedOutcome: 'results',
    expectedDocumentKeys: ['doc-a'], expectedFormats: ['txt'], status,
    actualUniqueDocumentKeys: status === 'completed' ? ['doc-a'] : [], resultCount: status === 'completed' ? 1 : 0,
    recallAt10, mrrAt10, citationChecks: { verified: 0, failed: 0 },
  });
  const rows = [
    row('answer-success', 'completed', 1, 1),
    row('answer-citation-failed', 'failed', 1, 1),
  ];

  assert.deepEqual(metricSummary(rows), { queryCount: 2, recallAt10: 0.5, mrrAt10: 0.5 });
  const summary = buildEvaluationSummary(rows);
  assert.equal(summary.answerableAuthorizedQueryCount, 2);
  assert.equal(summary.completedAnswerableQueryCount, 1);
  assert.equal(summary.scoreCoverageComplete, false);
  assert.equal(summary.qualityGatePass, false);
  assert.equal(summary.acceptancePass, false);
});

test('support coverage gates separately without erasing correct document ranking metrics', () => {
  const rows: QueryRun[] = Array.from({ length: 10 }, (_, index) => ({
    queryId: `support-${index}`, category: 'exact', language: 'en', split: 'development', expectedOutcome: 'results',
    expectedDocumentKeys: [`doc-${index}`], expectedFormats: ['txt'], status: 'completed',
    actualUniqueDocumentKeys: [`doc-${index}`], resultCount: 1, recallAt10: 1, mrrAt10: 1,
    supportCoverage: index === 9
      ? { expectedPassageCount: 1, locatorOverlapCount: 0, fullSnippetCount: 0 }
      : { expectedPassageCount: 1, locatorOverlapCount: 1, fullSnippetCount: 1 },
    citationChecks: { verified: 1, failed: 0 },
  }));
  const summary = buildEvaluationSummary(rows);

  assert.equal(summary.metrics.overall.queryCount, 10);
  assert.equal(summary.metrics.overall.recallAt10, 1);
  assert.equal(summary.metrics.overall.mrrAt10, 1);
  assert.equal(summary.completedAnswerableQueryCount, 10);
  assert.equal(summary.scoreCoverageComplete, true);
  assert.equal(summary.thresholds.overallPass, true);
  assert.equal(summary.supportCoverage.expectedPassageCount, 10);
  assert.equal(summary.supportCoverage.locatorOverlapPassageCount, 9);
  assert.equal(summary.supportCoverage.fullSnippetPassageCount, 9);
  assert.equal(summary.supportCoveragePass, false);
  assert.equal(summary.citations.failedHitCount, 0);
  assert.equal(summary.supportCoverageFailureQueryCount, 1);
  assert.equal(summary.qualityGatePass, false, 'support coverage remains an independent acceptance gate');
});

test('legacy support-miss rows preserve persisted ranking scores but remain a failed gate', () => {
  const rows: QueryRun[] = [
    {
      queryId: 'legacy-support-hit', category: 'exact', language: 'en', split: 'development', expectedOutcome: 'results',
      expectedDocumentKeys: ['doc-a'], expectedFormats: ['txt'], status: 'completed', actualUniqueDocumentKeys: ['doc-a'],
      resultCount: 1, recallAt10: 1, mrrAt10: 1, citationChecks: { verified: 1, failed: 0 },
    },
    {
      queryId: 'legacy-support-miss', category: 'exact', language: 'en', split: 'development', expectedOutcome: 'results',
      expectedDocumentKeys: ['doc-b'], expectedFormats: ['txt'], status: 'failed', actualUniqueDocumentKeys: ['doc-b'],
      resultCount: 1, recallAt10: 1, mrrAt10: 1, failureCode: 'EVAL_RELEVANT_SUPPORT_SNIPPET_MISSING',
      citationChecks: { verified: 1, failed: 0 },
    },
  ];
  const summary = buildEvaluationSummary(rows);

  assert.deepEqual(summary.metrics.overall, { queryCount: 2, recallAt10: 1, mrrAt10: 1 });
  assert.equal(summary.completedQueryCount, 2);
  assert.equal(summary.failedQueryCount, 0);
  assert.equal(summary.completedAnswerableQueryCount, 2);
  assert.equal(summary.scoreCoverageComplete, true);
  assert.equal(summary.supportCoverageFailureQueryCount, 1);
  assert.equal(summary.supportCoverage.unknownPassageCount, 1);
  assert.equal(summary.supportCoverage.fullSnippetRate, null, 'old reports did not record per-passage support counts');
  assert.equal(summary.supportCoveragePass, false);
  assert.equal(summary.qualityGatePass, false);
});
