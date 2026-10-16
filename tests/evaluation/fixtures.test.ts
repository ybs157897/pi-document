import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadFrozenFixtures, loadHtmlSnapshots, locateSnippetRange } from '../../scripts/eval-retrieval.js';
import { parseSource } from '../../src/ingestion/parser.js';

test('frozen retrieval fixtures have the required document, query, blind, and version counts', async () => {
  const fixtures = await loadFrozenFixtures();
  assert.equal(fixtures.manifest.datasetSha256, 'da6a450c6f813ce99b1d26acd3e88863c689bc200e7bb2ee3c14ecb580a89c74');
  assert.equal(fixtures.documents.length, 100);
  assert.deepEqual(fixtures.manifest.counts.documentsByFormat, { txt: 20, md: 30, pdf: 30, docx: 20 });
  assert.deepEqual(fixtures.manifest.counts.documentsByLanguage, { zh: 60, en: 30, mixed: 10 });
  assert.equal(fixtures.queries.length, 100);
  assert.equal(fixtures.queries.filter(query => query.expectedOutcome === 'results' || query.expectedOutcome === 'results_after_update').length, 85);
  assert.deepEqual(fixtures.manifest.counts.queriesByCategory, {
    exact: 20, synonym: 30, cross_passage_document: 20, version: 10, no_answer: 10, filter_permission: 10,
  });
  assert.deepEqual(fixtures.manifest.counts.queriesBySplit, { development: 80, blind: 20 });
  assert.equal(fixtures.manifest.counts.versionTransitions, 10);
  assert.ok(fixtures.queries.every(query => Array.isArray(query.expectedDocumentKeys)
    && Array.isArray(query.supportText) && typeof query.category === 'string' && typeof query.language === 'string'));
  assert.equal(fixtures.queries.filter(query => query.scenario === 'permission' && query.principalRole === 'reader').length, 5);
  assert.equal(fixtures.queries.filter(query => query.scenario === 'filter').length, 5);
});

test('the separate HTML snapshot set verifies parser fragments without claiming public URL fetch coverage', async () => {
  const html = await loadHtmlSnapshots();
  assert.equal(html.datasetSha256, '07b825d3fb539ad10ab55b97f1b136bbcda31ed92fe9da5903f487aefde641ae');
  assert.equal(html.snapshots.length, 20);
  assert.ok(html.snapshots.every(snapshot => snapshot.format === 'html' && snapshot.expectedLocator.kind === 'html_section'));
  assert.ok(html.limitations.some(note => note.includes('HTTP URL fetching')));
});

test('HTML citation validation searches every parser span sharing the section locator', async () => {
  const html = await loadHtmlSnapshots();
  const snapshot = html.snapshots[0]!;
  const parsed = await parseSource(await readFile(join(html.root, snapshot.path)), 'text/html');
  const matchingSpans = parsed.spans.filter(span => span.locator.kind === 'html_section'
    && span.locator.fragment === snapshot.expectedLocator.fragment
    && JSON.stringify(span.locator.headingPath) === JSON.stringify(snapshot.expectedLocator.headingPath));
  assert.ok(matchingSpans.length > 1, 'the section locator is shared by headings and multiple content blocks');
  const supportSpan = matchingSpans.find(span => parsed.text.slice(span.startOffset, span.endOffset).includes(snapshot.supportText));
  assert.ok(supportSpan, 'the frozen support text is in a later block with the same HTML section locator');
  const supportStart = supportSpan.startOffset + Array.from(parsed.text.slice(supportSpan.startOffset, supportSpan.endOffset)
    .split(snapshot.supportText, 1)[0]!).length;
  const sourceRange = locateSnippetRange(parsed, snapshot.supportText, snapshot.expectedLocator);
  assert.deepEqual(sourceRange, { startOffset: supportStart, endOffset: supportStart + Array.from(snapshot.supportText).length });
});
