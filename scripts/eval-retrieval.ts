import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { cpus, freemem, platform, release, totalmem, arch, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Pool } from 'pg';
import { LocalPostgres } from './support/local-postgres.js';
import { parseSource, type ParsedSource, type SourceLocator } from '../src/ingestion/parser.js';
import { chunkDocument } from '../src/ingestion/chunker.js';
import { EMBEDDING_MAX_ATTEMPTS } from '../src/retrieval/embedding.js';
import { startApp } from '../src/app.js';
import type { ServiceConfig } from '../src/config/service.js';
import type { DocumentRequest, Principal, StoredTask } from '../src/domain/types.js';

type Language = 'zh' | 'en' | 'mixed';
type Format = 'txt' | 'md' | 'pdf' | 'docx';
type SourceFormat = Format | 'html';
type QueryCategory = 'exact' | 'synonym' | 'cross_passage_document' | 'version' | 'no_answer' | 'filter_permission';

interface SourceDescriptor {
  key: string;
  format: SourceFormat;
  title: string;
  path: string;
  sha256: string;
  byteSize: number;
  tags: string[];
}

interface FixtureDocument extends SourceDescriptor {
  code: string;
  format: Format;
  language: Language;
  access: 'public' | 'restricted';
  knowledgeBaseRole: 'public' | 'restricted';
  topicKey: string;
  supportPassages: Array<{ id: string; text: string; version: number; sha256: string; locator: SourceLocator; range: { startOffset: number; endOffset: number } }>;
}

interface VersionTransition {
  fixtureId: string;
  documentKey: string;
  format: Format;
  language: Language;
  fromVersion: 1;
  toVersion: 2;
  baselinePath: string;
  baselineSha256: string;
  version1Value: string;
  version2Path: string;
  version2Sha256: string;
  version2ByteSize: number;
  supportText: string;
  acceptableSourceLocator: { container: SourceLocator; range: { startOffset: number; endOffset: number } };
  queryId: string;
}

interface HtmlSnapshot extends SourceDescriptor {
  format: 'html';
  language: Language;
  query: string;
  supportText: string;
  expectedLocator: Extract<SourceLocator, { kind: 'html_section' }>;
}

interface HtmlFixtureSet {
  root: string;
  datasetSha256: string;
  snapshots: HtmlSnapshot[];
  limitations: string[];
}

interface EvaluationQuery {
  id: string;
  query: string;
  category: QueryCategory;
  scenario?: 'filter' | 'permission';
  language: Language;
  split: 'development' | 'blind';
  expectedDocumentKeys: string[];
  expectedFormats: Format[];
  expectedKnowledgeBaseRole?: 'public' | 'restricted';
  expectedOutcome: 'results' | 'no_answer' | 'permission_denied' | 'results_after_update';
  supportText: string[];
  acceptableSourceLocators: Array<{
    documentKey: string;
    version: number;
    sha256: string;
    container: SourceLocator;
    range: { startOffset: number; endOffset: number };
  }>;
  expectedVersion?: number;
  versionFixtureId?: string;
  principalRole: 'evaluator' | 'reader';
  filters?: { tags?: string[]; sourceTypes?: Array<'upload'> };
  note?: string;
}

interface FrozenManifest {
  fixtureVersion: 1;
  frozen: true;
  datasetSha256: string;
  blindSplit: { seed: string; strategy: string; developmentQueries: number; blindQueries: number };
  counts: {
    documents: number;
    documentsByFormat: Record<Format, number>;
    documentsByLanguage: Record<Language, number>;
    formatLanguageMatrix: Record<Format, Record<Language, number>>;
    queries: number;
    queriesByCategory: Record<QueryCategory, number>;
    queriesByLanguage: Record<Language, number>;
    queriesBySplit: Record<'development' | 'blind', number>;
    versionTransitions: number;
  };
  files: Array<{ path: string; sha256: string; byteSize: number }>;
  generationSources: Record<string, string>;
  restrictions: string[];
}

interface FixtureSet {
  root: string;
  manifest: FrozenManifest;
  documents: FixtureDocument[];
  queries: EvaluationQuery[];
  updates: VersionTransition[];
}

export interface QueryRun {
  queryId: string;
  category: QueryCategory;
  scenario?: 'filter' | 'permission';
  language: Language;
  split: 'development' | 'blind';
  expectedOutcome: EvaluationQuery['expectedOutcome'];
  expectedDocumentKeys: string[];
  expectedFormats: Format[];
  status: 'completed' | 'not_run' | 'failed';
  actualUniqueDocumentKeys: string[];
  resultCount: number;
  denied?: boolean;
  leakage?: boolean;
  falsePositive?: boolean;
  recallAt10?: number;
  mrrAt10?: number;
  supportCoverage?: {
    expectedPassageCount: number;
    locatorOverlapCount: number;
    fullSnippetCount: number;
  };
  citationChecks: { verified: number; failed: number };
  actualMode?: string;
  degraded?: boolean;
  degradationReason?: string;
  taskId?: string;
  denialCode?: string;
  failureCode?: string;
  note?: string;
}

function hasLegacySupportCoverageFailure(row: QueryRun): boolean {
  return row.status === 'failed' && row.failureCode === 'EVAL_RELEVANT_SUPPORT_SNIPPET_MISSING'
    && row.recallAt10 !== undefined && row.mrrAt10 !== undefined;
}

function hasAnswerableRankingResult(row: QueryRun): boolean {
  return (row.status === 'completed' || hasLegacySupportCoverageFailure(row))
    && typeof row.recallAt10 === 'number' && Number.isFinite(row.recallAt10)
    && typeof row.mrrAt10 === 'number' && Number.isFinite(row.mrrAt10);
}

interface RankedDocument {
  documentId: string;
  version: number;
}

interface MetricSummary {
  queryCount: number;
  recallAt10: number | null;
  mrrAt10: number | null;
}

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureRoot = join(projectRoot, 'fixtures', 'evaluation', 'frozen');
const htmlSnapshotRoot = join(projectRoot, 'fixtures', 'html-snapshots', 'frozen');
const defaultPgBinDir = resolve(projectRoot, '.cache', 'postgres', 'bin');
const frozenDatasetSha256 = 'da6a450c6f813ce99b1d26acd3e88863c689bc200e7bb2ee3c14ecb580a89c74';
const frozenHtmlSnapshotSha256 = '07b825d3fb539ad10ab55b97f1b136bbcda31ed92fe9da5903f487aefde641ae';
const defaultTotalRuntimeMs = 60 * 60_000;
const maxDocuments = 100;
const maxQueries = 100;
const maxFileBytes = 1024 * 1024;
const maxTotalFileBytes = 5 * 1024 * 1024;
const maxTaskWaitMs = 120_000;
const maxRunnerHttpRequests = 25_000;
const maxEmbeddingAttemptBudget = 1_500;
const fetchTimeoutMs = 20_000;
const scopes: Principal['scopes'] = ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'];

class EvaluationFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalHash(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new EvaluationFailure(code);
}

function parseJson<T>(value: unknown, code: string): T {
  if (!value || typeof value !== 'object') throw new EvaluationFailure(code);
  return value as T;
}

async function readFixtureFile(root: string, relativePath: string): Promise<Buffer> {
  if (!relativePath || relativePath.includes('\\') || relativePath.startsWith('/')
    || relativePath.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new EvaluationFailure('EVAL_FIXTURE_PATH_INVALID');
  }
  const path = join(root, ...relativePath.split('/'));
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new EvaluationFailure('EVAL_FIXTURE_NOT_REGULAR_FILE');
  return readFile(path);
}

async function listFixtureFiles(root: string, current = root): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const full = join(current, entry.name);
    const info = await lstat(full);
    if (info.isSymbolicLink()) throw new EvaluationFailure('EVAL_FIXTURE_SYMLINK_NOT_ALLOWED');
    if (info.isDirectory()) result.push(...await listFixtureFiles(root, full));
    else if (info.isFile()) result.push(relative(root, full).split('/').join('/'));
    else throw new EvaluationFailure('EVAL_FIXTURE_ENTRY_INVALID');
  }
  return result.sort();
}

export async function estimateEmbeddingBudget(fixtures: FixtureSet, htmlSnapshots: HtmlFixtureSet): Promise<{
  parsedDocumentCount: number;
  mainCorpusDocumentCount: number;
  versionUpdateDocumentCount: number;
  htmlSnapshotCount: number;
  chunkCount: number;
  ingestionEmbeddingBatchCount: number;
  searchEmbeddingRequestCount: number;
  worstCaseEmbeddingAttempts: number;
}> {
  let chunkCount = 0;
  let ingestionEmbeddingBatchCount = 0;
  const parseFile = async (root: string, path: string, format: SourceFormat) => {
    const bytes = await readFixtureFile(root, path);
    const parsed = await parseSource(bytes, mimeForFormat(format));
    const chunks = chunkDocument(parsed);
    if (chunks.length === 0) throw new EvaluationFailure('EVAL_FIXTURE_PARSE_EMPTY');
    chunkCount += chunks.length;
    ingestionEmbeddingBatchCount += Math.ceil(chunks.length / 8);
  };
  for (const document of fixtures.documents) await parseFile(fixtures.root, document.path, document.format);
  for (const transition of fixtures.updates) await parseFile(fixtures.root, transition.version2Path, transition.format);
  for (const snapshot of htmlSnapshots.snapshots) await parseFile(htmlSnapshots.root, snapshot.path, 'html');
  const searchEmbeddingRequestCount = fixtures.queries.filter(query => query.category !== 'version' || query.expectedOutcome === 'results_after_update')
    .filter(query => query.scenario !== 'permission').length;
  const worstCaseEmbeddingAttempts = (ingestionEmbeddingBatchCount + searchEmbeddingRequestCount) * EMBEDDING_MAX_ATTEMPTS;
  if (worstCaseEmbeddingAttempts > maxEmbeddingAttemptBudget) throw new EvaluationFailure('EVAL_EMBEDDING_ATTEMPT_BUDGET_EXCEEDED');
  return {
    parsedDocumentCount: fixtures.documents.length + fixtures.updates.length + htmlSnapshots.snapshots.length,
    mainCorpusDocumentCount: fixtures.documents.length,
    versionUpdateDocumentCount: fixtures.updates.length,
    htmlSnapshotCount: htmlSnapshots.snapshots.length,
    chunkCount,
    ingestionEmbeddingBatchCount,
    searchEmbeddingRequestCount,
    worstCaseEmbeddingAttempts,
  };
}

export async function loadFrozenFixtures(root = fixtureRoot): Promise<FixtureSet> {
  const manifestBytes = await readFixtureFile(root, 'manifest.json');
  const manifest = parseJson<FrozenManifest>(JSON.parse(manifestBytes.toString('utf8')), 'EVAL_MANIFEST_INVALID');
  assert(manifest.fixtureVersion === 1 && manifest.frozen === true, 'EVAL_MANIFEST_NOT_FROZEN');
  assert(manifest.datasetSha256 === frozenDatasetSha256, 'EVAL_FROZEN_DATASET_HASH_CHANGED');
  const corpus = parseJson<{ fixtureVersion: number; documents: FixtureDocument[] }>(
    JSON.parse((await readFixtureFile(root, 'corpus.json')).toString('utf8')), 'EVAL_CORPUS_INVALID');
  const queryFixture = parseJson<{ fixtureVersion: number; blindSplitSeed: string; queries: EvaluationQuery[] }>(
    JSON.parse((await readFixtureFile(root, 'queries.json')).toString('utf8')), 'EVAL_QUERIES_INVALID');
  const updates = parseJson<{ fixtureVersion: number; transitions: VersionTransition[] }>(
    JSON.parse((await readFixtureFile(root, 'updates.json')).toString('utf8')), 'EVAL_UPDATES_INVALID');
  assert(corpus.fixtureVersion === 1 && queryFixture.fixtureVersion === 1 && updates.fixtureVersion === 1, 'EVAL_FIXTURE_VERSION_INVALID');
  assert(queryFixture.blindSplitSeed === manifest.blindSplit.seed, 'EVAL_BLIND_SPLIT_SEED_MISMATCH');
  assert(corpus.documents.length === maxDocuments && queryFixture.queries.length === maxQueries, 'EVAL_FIXTURE_COUNT_INVALID');

  const actualFiles: Array<{ path: string; sha256: string; byteSize: number }> = [];
  let totalBytes = 0;
  for (const expected of manifest.files) {
    const bytes = await readFixtureFile(root, expected.path);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > maxFileBytes || totalBytes > maxTotalFileBytes) throw new EvaluationFailure('EVAL_FIXTURE_SIZE_BUDGET_EXCEEDED');
    const digest = sha256(bytes);
    if (digest !== expected.sha256 || bytes.byteLength !== expected.byteSize) throw new EvaluationFailure('EVAL_FIXTURE_HASH_MISMATCH');
    actualFiles.push({ path: expected.path, sha256: digest, byteSize: bytes.byteLength });
  }
  if (actualFiles.length !== manifest.files.length) throw new EvaluationFailure('EVAL_MANIFEST_FILE_SET_INVALID');
  const expectedPaths = new Set([...manifest.files.map(file => file.path), 'manifest.json']);
  const actualPaths = await listFixtureFiles(root);
  if (actualPaths.length !== expectedPaths.size || actualPaths.some(path => !expectedPaths.has(path))) {
    throw new EvaluationFailure('EVAL_FIXTURE_FILE_SET_MISMATCH');
  }
  const expectedDatasetHash = sha256(Buffer.from(actualFiles
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(entry => `${entry.path}\t${entry.sha256}\t${entry.byteSize}`).join('\n') + '\n', 'utf8'));
  if (expectedDatasetHash !== manifest.datasetSha256) throw new EvaluationFailure('EVAL_DATASET_HASH_MISMATCH');

  const docsByKey = new Map(corpus.documents.map(document => [document.key, document]));
  if (docsByKey.size !== maxDocuments) throw new EvaluationFailure('EVAL_DOCUMENT_KEY_DUPLICATE');
  const documentFormatCounts: Record<Format, number> = { txt: 0, md: 0, pdf: 0, docx: 0 };
  const documentLanguageCounts: Record<Language, number> = { zh: 0, en: 0, mixed: 0 };
  const formatLanguageCounts: Record<Format, Record<Language, number>> = {
    txt: { zh: 0, en: 0, mixed: 0 }, md: { zh: 0, en: 0, mixed: 0 },
    pdf: { zh: 0, en: 0, mixed: 0 }, docx: { zh: 0, en: 0, mixed: 0 },
  };
  const manifestFilesByPath = new Map(manifest.files.map(file => [file.path, file]));
  for (const document of corpus.documents) {
    documentFormatCounts[document.format] += 1;
    documentLanguageCounts[document.language] += 1;
    formatLanguageCounts[document.format][document.language] += 1;
    const file = manifestFilesByPath.get(document.path);
    if (!file || file.sha256 !== document.sha256 || file.byteSize !== document.byteSize) throw new EvaluationFailure('EVAL_DOCUMENT_MANIFEST_HASH_MISMATCH');
  }
  const queryIds = new Set<string>();
  const queryCategoryCounts: Record<QueryCategory, number> = {
    exact: 0, synonym: 0, cross_passage_document: 0, version: 0, no_answer: 0, filter_permission: 0,
  };
  const queryLanguageCounts: Record<Language, number> = { zh: 0, en: 0, mixed: 0 };
  const querySplitCounts: Record<'development' | 'blind', number> = { development: 0, blind: 0 };
  for (const query of queryFixture.queries) {
    if (!query.id || queryIds.has(query.id)) throw new EvaluationFailure('EVAL_QUERY_ID_DUPLICATE');
    queryIds.add(query.id);
    queryCategoryCounts[query.category] += 1;
    queryLanguageCounts[query.language] += 1;
    querySplitCounts[query.split] += 1;
    if (!['zh', 'en', 'mixed'].includes(query.language) || !['development', 'blind'].includes(query.split)) {
      throw new EvaluationFailure('EVAL_QUERY_LABEL_INVALID');
    }
    if (!Array.isArray(query.expectedDocumentKeys) || !Array.isArray(query.supportText) || !Array.isArray(query.acceptableSourceLocators)) {
      throw new EvaluationFailure('EVAL_QUERY_GOLD_LABEL_MISSING');
    }
    if (query.expectedOutcome === 'results' && (query.expectedDocumentKeys.length === 0
      || query.expectedDocumentKeys.length !== query.supportText.length
      || query.expectedDocumentKeys.length !== query.acceptableSourceLocators.length)) {
      throw new EvaluationFailure('EVAL_QUERY_GOLD_LABEL_MISMATCH');
    }
    for (const locator of query.acceptableSourceLocators) {
      const document = docsByKey.get(locator.documentKey);
      if (!document) throw new EvaluationFailure('EVAL_QUERY_DOCUMENT_UNKNOWN');
      if (locator.version === 1 && locator.sha256 !== document.sha256) throw new EvaluationFailure('EVAL_QUERY_SOURCE_HASH_MISMATCH');
      if (!Number.isSafeInteger(locator.range.startOffset) || locator.range.startOffset < 0
        || !Number.isSafeInteger(locator.range.endOffset) || locator.range.endOffset <= locator.range.startOffset) {
        throw new EvaluationFailure('EVAL_QUERY_LOCATOR_RANGE_INVALID');
      }
    }
    if (query.category === 'version' && (query.expectedVersion !== 2 || query.expectedOutcome !== 'results_after_update')) {
      throw new EvaluationFailure('EVAL_VERSION_QUERY_INVALID');
    }
    if (query.scenario === 'permission' && (query.expectedOutcome !== 'permission_denied' || query.principalRole !== 'reader')) {
      throw new EvaluationFailure('EVAL_PERMISSION_QUERY_INVALID');
    }
  }
  const transitions = new Map(updates.transitions.map(transition => [transition.documentKey, transition]));
  if (transitions.size !== 10 || updates.transitions.some(transition => transition.fromVersion !== 1 || transition.toVersion !== 2)) {
    throw new EvaluationFailure('EVAL_VERSION_FIXTURE_COUNT_INVALID');
  }
  const queriesById = new Map(queryFixture.queries.map(query => [query.id, query]));
  for (const transition of updates.transitions) {
    const document = docsByKey.get(transition.documentKey);
    const query = queriesById.get(transition.queryId);
    const queryAnchor = query?.acceptableSourceLocators[0];
    const updateFile = manifestFilesByPath.get(transition.version2Path);
    if (!document || !query || transition.baselinePath !== document.path || transition.baselineSha256 !== document.sha256
      || transition.format !== document.format || !updateFile || updateFile.sha256 !== transition.version2Sha256
      || updateFile.byteSize !== transition.version2ByteSize || query.versionFixtureId !== transition.fixtureId
      || query.supportText[0] !== transition.supportText || queryAnchor?.sha256 !== transition.version2Sha256
      || JSON.stringify(queryAnchor?.container) !== JSON.stringify(transition.acceptableSourceLocator.container)
      || queryAnchor?.range.startOffset !== transition.acceptableSourceLocator.range.startOffset
      || queryAnchor?.range.endOffset !== transition.acceptableSourceLocator.range.endOffset) {
      throw new EvaluationFailure('EVAL_VERSION_FIXTURE_METADATA_MISMATCH');
    }
    const bytes = await readFixtureFile(root, transition.version2Path);
    const parsed = await parseSource(bytes, mimeForFormat(transition.format));
    const rawStart = parsed.text.indexOf(transition.supportText);
    if (rawStart < 0) throw new EvaluationFailure('EVAL_VERSION_SUPPORT_TEXT_MISSING');
    const startOffset = Array.from(parsed.text.slice(0, rawStart)).length;
    const endOffset = startOffset + Array.from(transition.supportText).length;
    const span = parsed.spans.find(item => item.startOffset <= startOffset && item.endOffset >= endOffset);
    if (!span || JSON.stringify(span.locator) !== JSON.stringify(transition.acceptableSourceLocator.container)
      || startOffset !== transition.acceptableSourceLocator.range.startOffset
      || endOffset !== transition.acceptableSourceLocator.range.endOffset) {
      throw new EvaluationFailure('EVAL_VERSION_LOCATOR_LABEL_MISMATCH');
    }
  }
  for (const query of queryFixture.queries.filter(item => item.category === 'version')) {
    const key = query.expectedDocumentKeys[0];
    const transition = transitions.get(key ?? '');
    const document = docsByKey.get(key ?? '');
    if (!transition || !document || transition.version2Path !== `updates/${key}-v2.${document.format}`
      || transition.version2Sha256 !== query.acceptableSourceLocators[0]?.sha256) throw new EvaluationFailure('EVAL_VERSION_LABEL_MISMATCH');
  }
  const countsMatch = JSON.stringify(documentFormatCounts) === JSON.stringify(manifest.counts.documentsByFormat)
    && JSON.stringify(documentLanguageCounts) === JSON.stringify(manifest.counts.documentsByLanguage)
    && JSON.stringify(formatLanguageCounts) === JSON.stringify(manifest.counts.formatLanguageMatrix)
    && JSON.stringify(queryCategoryCounts) === JSON.stringify(manifest.counts.queriesByCategory)
    && JSON.stringify(queryLanguageCounts) === JSON.stringify(manifest.counts.queriesByLanguage)
    && JSON.stringify(querySplitCounts) === JSON.stringify(manifest.counts.queriesBySplit);
  if (!countsMatch) throw new EvaluationFailure('EVAL_MANIFEST_COUNT_MISMATCH');
  if (manifest.blindSplit.blindQueries !== queryFixture.queries.filter(query => query.split === 'blind').length
    || manifest.blindSplit.blindQueries !== 20 || manifest.blindSplit.developmentQueries !== 80) {
    throw new EvaluationFailure('EVAL_BLIND_SPLIT_COUNT_INVALID');
  }
  return { root, manifest, documents: corpus.documents, queries: queryFixture.queries, updates: updates.transitions };
}

export async function loadHtmlSnapshots(root = htmlSnapshotRoot): Promise<HtmlFixtureSet> {
  const manifest = parseJson<{
    fixtureVersion: number;
    frozen: boolean;
    datasetSha256: string;
    counts: { snapshots: number; languages: Record<Language, number> };
    files: Array<{ path: string; sha256: string; byteSize: number }>;
    snapshots: HtmlSnapshot[];
    publicUrlFetchCoverage: string;
    limitations: string[];
  }>(JSON.parse((await readFixtureFile(root, 'manifest.json')).toString('utf8')), 'EVAL_HTML_MANIFEST_INVALID');
  assert(manifest.fixtureVersion === 1 && manifest.frozen, 'EVAL_HTML_FIXTURES_NOT_FROZEN');
  assert(manifest.datasetSha256 === frozenHtmlSnapshotSha256, 'EVAL_HTML_SNAPSHOT_HASH_CHANGED');
  assert(manifest.counts.snapshots === 20 && manifest.snapshots.length === 20, 'EVAL_HTML_SNAPSHOT_COUNT_INVALID');
  assert(manifest.publicUrlFetchCoverage.includes('not covered'), 'EVAL_HTML_URL_COVERAGE_CLAIM_INVALID');

  const actualFiles: Array<{ path: string; sha256: string; byteSize: number }> = [];
  let totalBytes = 0;
  for (const file of manifest.files) {
    const bytes = await readFixtureFile(root, file.path);
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > maxFileBytes || totalBytes > maxTotalFileBytes) throw new EvaluationFailure('EVAL_HTML_SNAPSHOT_SIZE_BUDGET_EXCEEDED');
    const digest = sha256(bytes);
    if (digest !== file.sha256 || bytes.byteLength !== file.byteSize) throw new EvaluationFailure('EVAL_HTML_SNAPSHOT_HASH_MISMATCH');
    actualFiles.push({ path: file.path, sha256: digest, byteSize: bytes.byteLength });
  }
  const actualDatasetHash = sha256(Buffer.from(actualFiles.sort((left, right) => left.path.localeCompare(right.path))
    .map(file => `${file.path}\t${file.sha256}\t${file.byteSize}`).join('\n') + '\n', 'utf8'));
  if (actualDatasetHash !== manifest.datasetSha256) throw new EvaluationFailure('EVAL_HTML_SNAPSHOT_DATASET_HASH_MISMATCH');
  const actualPaths = await listFixtureFiles(root);
  const expectedPaths = new Set([...manifest.files.map(file => file.path), 'manifest.json']);
  if (actualPaths.length !== expectedPaths.size || actualPaths.some(path => !expectedPaths.has(path))) {
    throw new EvaluationFailure('EVAL_HTML_SNAPSHOT_FILE_SET_MISMATCH');
  }

  const languages: Record<Language, number> = { zh: 0, en: 0, mixed: 0 };
  for (const snapshot of manifest.snapshots) {
    languages[snapshot.language] += 1;
    const file = manifest.files.find(item => item.path === snapshot.path);
    if (!file || file.sha256 !== snapshot.sha256 || file.byteSize !== snapshot.byteSize || snapshot.format !== 'html'
      || snapshot.expectedLocator.kind !== 'html_section' || !snapshot.supportText || !snapshot.query) {
      throw new EvaluationFailure('EVAL_HTML_SNAPSHOT_LABEL_INVALID');
    }
    if ('sourceUrl' in (snapshot as unknown as Record<string, unknown>)) throw new EvaluationFailure('EVAL_HTML_SNAPSHOT_PUBLIC_URL_CLAIM_INVALID');
    const bytes = await readFixtureFile(root, snapshot.path);
    const parsed = await parseSource(bytes, 'text/html');
    if (!parsed.text.includes(snapshot.supportText) || !parsed.spans.some(span => span.locator.kind === 'html_section'
      && span.locator.fragment === snapshot.expectedLocator.fragment
      && JSON.stringify(span.locator.headingPath) === JSON.stringify(snapshot.expectedLocator.headingPath)
      && parsed.text.slice(span.startOffset, span.endOffset).includes(snapshot.supportText))) {
      throw new EvaluationFailure('EVAL_HTML_SNAPSHOT_EXPECTED_LOCATOR_INVALID');
    }
  }
  if (JSON.stringify(languages) !== JSON.stringify(manifest.counts.languages)) throw new EvaluationFailure('EVAL_HTML_SNAPSHOT_LANGUAGE_COUNT_INVALID');
  return { root, datasetSha256: manifest.datasetSha256, snapshots: manifest.snapshots, limitations: manifest.limitations };
}

export function metricSummary(rows: QueryRun[]): MetricSummary {
  const answerable = rows.filter(row => (row.expectedOutcome === 'results' || row.expectedOutcome === 'results_after_update')
    && row.expectedDocumentKeys.length > 0);
  if (answerable.length === 0) return { queryCount: 0, recallAt10: null, mrrAt10: null };
  const scored = (row: QueryRun, metric: 'recallAt10' | 'mrrAt10') =>
    row.status === 'completed' || hasLegacySupportCoverageFailure(row) ? row[metric] ?? 0 : 0;
  return {
    queryCount: answerable.length,
    recallAt10: answerable.reduce((sum, row) => sum + scored(row, 'recallAt10'), 0) / answerable.length,
    mrrAt10: answerable.reduce((sum, row) => sum + scored(row, 'mrrAt10'), 0) / answerable.length,
  };
}

export function scoreDocumentRanking(expectedDocumentKeys: string[], rankedUniqueDocumentKeys: string[]): { recallAt10: number; mrrAt10: number } {
  const expected = new Set(expectedDocumentKeys);
  if (expected.size === 0) throw new EvaluationFailure('EVAL_EXPECTED_DOCUMENT_SET_EMPTY');
  const top = [...new Set(rankedUniqueDocumentKeys)].slice(0, 10);
  const matched = new Set(top.filter(key => expected.has(key)));
  const first = top.findIndex(key => expected.has(key));
  return { recallAt10: matched.size / expected.size, mrrAt10: first < 0 ? 0 : 1 / (first + 1) };
}

export function locateSnippetRange(
  parsed: ParsedSource,
  snippetValue: unknown,
  locatorValue: unknown,
): { startOffset: number; endOffset: number } | undefined {
  if (typeof snippetValue !== 'string' || !snippetValue) return undefined;
  if (!locatorValue || typeof locatorValue !== 'object' || Array.isArray(locatorValue)) return undefined;
  const locator = locatorValue as Record<string, unknown>;
  const codePoints = Array.from(parsed.text);
  if (locator.kind === 'text_span') {
    const start = Number(locator.startOffset); const end = Number(locator.endOffset);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > codePoints.length) return undefined;
    return codePoints.slice(start, end).join('') === snippetValue ? { startOffset: start, endOffset: end } : undefined;
  }
  if (locator.kind === 'pdf_page') {
    const page = Number(locator.page); const start = Number(locator.startOffset); const end = Number(locator.endOffset);
    if (![page, start, end].every(Number.isSafeInteger) || start < 0 || end <= start) return undefined;
    const span = parsed.spans.find(item => item.locator.kind === 'pdf_page' && item.locator.page === page);
    if (!span || end > span.endOffset - span.startOffset) return undefined;
    const globalStart = span.startOffset + start;
    const globalEnd = span.startOffset + end;
    return codePoints.slice(globalStart, globalEnd).join('') === snippetValue
      ? { startOffset: globalStart, endOffset: globalEnd } : undefined;
  }
  if (locator.kind === 'docx_paragraph') {
    const paragraphIndex = Number(locator.paragraphIndex);
    if (!Number.isSafeInteger(paragraphIndex) || paragraphIndex < 0) return undefined;
    const span = parsed.spans.find(item => item.locator.kind === 'docx_paragraph' && item.locator.paragraphIndex === paragraphIndex);
    if (!span) return undefined;
    const paragraph = codePoints.slice(span.startOffset, span.endOffset).join('');
    const relativeIndex = paragraph.indexOf(snippetValue);
    if (relativeIndex < 0) return undefined;
    const startOffset = span.startOffset + Array.from(paragraph.slice(0, relativeIndex)).length;
    return { startOffset, endOffset: startOffset + Array.from(snippetValue).length };
  }
  if (locator.kind === 'html_section') {
    if (!Array.isArray(locator.headingPath) || typeof locator.fragment !== 'string') return undefined;
    for (const span of parsed.spans) {
      if (span.locator.kind !== 'html_section' || span.locator.fragment !== locator.fragment
        || JSON.stringify(span.locator.headingPath) !== JSON.stringify(locator.headingPath)) continue;
      const block = codePoints.slice(span.startOffset, span.endOffset).join('');
      const relativeIndex = block.indexOf(snippetValue);
      if (relativeIndex < 0) continue;
      const startOffset = span.startOffset + Array.from(block.slice(0, relativeIndex)).length;
      return { startOffset, endOffset: startOffset + Array.from(snippetValue).length };
    }
  }
  return undefined;
}

function metricsBy(rows: QueryRun[], keyOf: (row: QueryRun) => string[]): Record<string, MetricSummary> {
  const groups = new Map<string, QueryRun[]>();
  for (const row of rows) {
    for (const key of keyOf(row)) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => [key, metricSummary(values)]));
}

export function buildEvaluationSummary(rows: QueryRun[]) {
  const scored = rows.filter(row => (row.expectedOutcome === 'results' || row.expectedOutcome === 'results_after_update')
    && row.expectedDocumentKeys.length > 0);
  const overall = metricSummary(rows);
  const noAnswer = rows.filter(row => row.expectedOutcome === 'no_answer' && row.status === 'completed');
  const permission = rows.filter(row => row.expectedOutcome === 'permission_denied' && row.status === 'completed');
  const citationChecks = rows.reduce((result, row) => ({
    verified: result.verified + row.citationChecks.verified,
    failed: result.failed + row.citationChecks.failed,
  }), { verified: 0, failed: 0 });
  const completedExpectedRuns = rows.filter(row => row.status === 'completed' || hasLegacySupportCoverageFailure(row)).length;
  const failedRuns = rows.filter(row => row.status === 'failed' && !hasLegacySupportCoverageFailure(row)).length;
  const notRun = rows.filter(row => row.status === 'not_run').length;
  const expectedSupportPassageCount = scored.reduce((sum, row) => sum + row.expectedDocumentKeys.length, 0);
  const historicalSupportMisses = scored.filter(hasLegacySupportCoverageFailure);
  const supportCoverageUnknownPassageCount = historicalSupportMisses.reduce((sum, row) => sum + row.expectedDocumentKeys.length, 0);
  const supportRows = scored.filter(row => row.status === 'completed').map(row => row.supportCoverage ?? {
    // Older reports marked a query completed only after all expected full snippets were returned.
    expectedPassageCount: row.expectedDocumentKeys.length,
    locatorOverlapCount: row.expectedDocumentKeys.length,
    fullSnippetCount: row.expectedDocumentKeys.length,
  });
  const locatorOverlapSupportCount = supportRows.reduce((sum, support) => sum + support.locatorOverlapCount, 0);
  const fullSupportSnippetCount = supportRows.reduce((sum, support) => sum + support.fullSnippetCount, 0);
  const supportCoveragePass = expectedSupportPassageCount > 0 && supportCoverageUnknownPassageCount === 0
    && fullSupportSnippetCount === expectedSupportPassageCount;
  const supportCoverageFailureQueryCount = scored.filter(row => hasLegacySupportCoverageFailure(row)
    || (row.status === 'completed' && row.supportCoverage !== undefined
      && row.supportCoverage.fullSnippetCount < row.expectedDocumentKeys.length)).length;
  const noAnswerFalsePositives = noAnswer.filter(row => row.falsePositive).length;
  const permissionLeaks = permission.filter(row => row.leakage).length;
  const permissionDenied = permission.filter(row => row.denied).length;
  const degradedRows = rows.filter(row => row.status === 'completed' && row.degraded);
  const degradationReasons = new Map<string, number>();
  for (const row of degradedRows) {
    for (const reason of (row.degradationReason ?? 'unspecified').split(';').map(value => value.trim()).filter(Boolean)) {
      degradationReasons.set(reason, (degradationReasons.get(reason) ?? 0) + 1);
    }
  }
  const overallThresholdsPass = (overall.recallAt10 ?? -1) >= 0.90 && (overall.mrrAt10 ?? -1) >= 0.75;
  const blind = metricSummary(rows.filter(row => row.split === 'blind'));
  const expectedScoreCount = scored.length;
  const expectedLiveQueryCount = rows.length;
  const executedQueriesCompleted = completedExpectedRuns === expectedLiveQueryCount - notRun;
  const completedScoredCount = scored.filter(hasAnswerableRankingResult).length;
  const scoreCoverageComplete = completedScoredCount === expectedScoreCount;
  const qualityGatePass = executedQueriesCompleted && failedRuns === 0 && overallThresholdsPass
    && citationChecks.failed === 0 && supportCoveragePass && permissionDenied === permission.length && permissionLeaks === 0;
  const datasetComplete = notRun === 0 && scoreCoverageComplete;
  const acceptancePass = qualityGatePass && datasetComplete;
  return {
    status: !qualityGatePass ? 'failed' : datasetComplete ? 'passed' : 'partial',
    expectedQueryCount: rows.length,
    expectedLiveQueryCount,
    completedQueryCount: completedExpectedRuns,
    failedQueryCount: failedRuns,
    supportCoverageFailureQueryCount,
    notRunQueryCount: notRun,
    answerableAuthorizedQueryCount: expectedScoreCount,
    completedAnswerableQueryCount: completedScoredCount,
    scoreCoverageComplete,
    supportCoverage: {
      expectedPassageCount: expectedSupportPassageCount,
      locatorOverlapPassageCount: locatorOverlapSupportCount,
      locatorOverlapRate: expectedSupportPassageCount && supportCoverageUnknownPassageCount === 0
        ? locatorOverlapSupportCount / expectedSupportPassageCount : null,
      fullSnippetPassageCount: fullSupportSnippetCount,
      fullSnippetRate: expectedSupportPassageCount && supportCoverageUnknownPassageCount === 0
        ? fullSupportSnippetCount / expectedSupportPassageCount : null,
      unknownPassageCount: supportCoverageUnknownPassageCount,
    },
    supportCoveragePass,
    metrics: {
      overall,
      byLanguage: metricsBy(rows, row => [row.language]),
      byFormat: metricsBy(rows, row => row.expectedFormats),
      byCategory: metricsBy(rows, row => [row.category]),
      bySplit: metricsBy(rows, row => [row.split]),
      blind,
    },
    noAnswer: {
      queryCount: noAnswer.length,
      falsePositiveQueryCount: noAnswerFalsePositives,
      falsePositiveRate: noAnswer.length ? noAnswerFalsePositives / noAnswer.length : null,
    },
    permission: {
      queryCount: permission.length,
      deniedQueryCount: permissionDenied,
      leakageQueryCount: permissionLeaks,
    },
    degradation: {
      degradedQueryCount: degradedRows.length,
      reasons: Object.fromEntries([...degradationReasons.entries()].sort(([left], [right]) => left.localeCompare(right))),
    },
    citations: {
      verifiedHitCount: citationChecks.verified,
      failedHitCount: citationChecks.failed,
      verifiedRate: citationChecks.verified + citationChecks.failed
        ? citationChecks.verified / (citationChecks.verified + citationChecks.failed) : null,
    },
    thresholds: { recallAt10: 0.90, mrrAt10: 0.75, supportCoverage: 1, overallPass: overallThresholdsPass },
    qualityGatePass,
    acceptancePass,
    limitations: [
      'Scores describe this frozen synthetic fixture only and do not establish retrieval quality on real enterprise documents.',
      'Version queries target v2 after the v1-to-v2 update flow; unexecuted or failed answerable rows remain in the core denominator with zero score.',
      'No-answer false positives are reported separately and are excluded from Recall@10 and MRR@10.',
      'Permission checks are reported as denials/leaks separately and are excluded from the quality denominator.',
    ],
  };
}

function mimeForFormat(format: SourceFormat): string {
  switch (format) {
    case 'txt': return 'text/plain';
    case 'md': return 'text/markdown';
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'html': return 'text/html';
  }
}

function safeErrorCode(error: unknown): string {
  if (error instanceof EvaluationFailure) return error.code;
  const message = error instanceof Error ? error.message : '';
  const match = /^([A-Z][A-Z0-9_]{2,63})(?::|$)/.exec(message);
  return match?.[1] ?? 'EVAL_RUNTIME_FAILED';
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'EVAL_PORT_RESERVATION_FAILED');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

function embeddingConfiguration() {
  const baseUrl = process.env.EMBEDDING_BASE_URL?.trim();
  const modelId = process.env.EMBEDDING_MODEL_ID?.trim();
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? '1024');
  const version = process.env.EMBEDDING_PROFILE_VERSION?.trim() || '1';
  const credentialsEnv = process.env.EMBEDDING_API_KEY_ENV?.trim() || 'PI_DOCUMENT_EMBEDDING_API_KEY';
  const apiKey = process.env[credentialsEnv]?.trim();
  assert(baseUrl && modelId && apiKey && Number.isSafeInteger(dimensions), 'EVAL_EMBEDDING_CONFIG_INCOMPLETE');
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { throw new EvaluationFailure('EVAL_EMBEDDING_BASE_URL_INVALID'); }
  assert(!parsed.username && !parsed.password && !parsed.search && !parsed.hash, 'EVAL_EMBEDDING_BASE_URL_INVALID');
  const profile = { baseUrl, modelId, dimensions, apiKey, version, normalization: 'l2' as const };
  const publicProfile = { origin: parsed.origin, modelId, dimensions, version, normalization: 'l2', credentialsEnv };
  return { profile, publicProfile, configSha256: canonicalHash(publicProfile) };
}

async function packageLockInfo() {
  const lock = JSON.parse((await readFile(join(projectRoot, 'package-lock.json'), 'utf8'))) as {
    packages?: Record<string, { version?: string }>;
  };
  const packages = lock.packages ?? {};
  return {
    lockSha256: sha256(await readFile(join(projectRoot, 'package-lock.json'))),
    piDurableVersion: packages['node_modules/@earendil-works/pi-durable']?.version ?? null,
    a2aSdkVersion: packages['node_modules/@a2a-js/sdk']?.version ?? null,
  };
}

async function gitInfo() {
  let head: string | null = null;
  let dirtyCount: number | null = null;
  try {
    head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })).stdout.trim();
    const status = (await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: projectRoot })).stdout;
    dirtyCount = status.split('\n').filter(Boolean).length;
  } catch { /* Report unavailable git state as null instead of including local command output. */ }
  return { head, dirtyPathCount: dirtyCount };
}

function systemInfo() {
  return {
    platform: `${platform()} ${release()}`,
    architecture: arch(),
    cpuModel: cpus()[0]?.model ?? null,
    cpuCount: cpus().length,
    memoryTotalBytes: totalmem(),
    memoryFreeBytesAtStart: freemem(),
    node: process.version,
  };
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 });
  await rename(temp, path);
}

function asTask(value: unknown): StoredTask {
  return parseJson<StoredTask>(value, 'EVAL_TASK_INVALID');
}

type WireTask = {
  id: string;
  contextId?: string;
  status?: { state?: string };
  artifacts?: Array<{ parts?: Array<{ data?: unknown }> }>;
};

type A2AResponse = { result?: { task?: WireTask } & Partial<WireTask>; error?: { code?: number; message?: string; data?: unknown } };

function taskFromResponse(body: A2AResponse): WireTask {
  if (body.error) throw new EvaluationFailure(`EVAL_A2A_${body.error.code ?? 'ERROR'}`);
  const task = body.result?.task ?? body.result;
  if (!task || typeof task.id !== 'string') throw new EvaluationFailure('EVAL_A2A_TASK_MISSING');
  return task as WireTask;
}

function businessResult(task: WireTask): Record<string, unknown> {
  const data = task.artifacts?.flatMap(artifact => artifact.parts ?? []).find(part => part.data !== undefined)?.data;
  if (!data) throw new EvaluationFailure('EVAL_TASK_RESULT_MISSING');
  const result = typeof data === 'string' ? JSON.parse(data) as unknown : data;
  return parseJson<Record<string, unknown>>(result, 'EVAL_BUSINESS_RESULT_INVALID');
}

function terminalState(task: WireTask): boolean {
  return ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED'].includes(task.status?.state ?? '');
}

function taskBusinessResult(task: WireTask): Record<string, unknown> {
  const business = businessResult(task);
  if (business.outcome !== 'succeeded') {
    const error = parseJson<{ code?: string }>(business.error, 'EVAL_BUSINESS_FAILURE_INVALID');
    throw new EvaluationFailure(`EVAL_BUSINESS_${error.code ?? 'FAILED'}`);
  }
  return parseJson<Record<string, unknown>>(business.result, 'EVAL_BUSINESS_PAYLOAD_MISSING');
}

function valueString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value) throw new EvaluationFailure(code);
  return value;
}

function jsonRpcErrorCode(body: A2AResponse): string | undefined {
  const message = body.error?.message ?? '';
  if (message.includes('KNOWLEDGE_BASE_NOT_FOUND')) return 'KNOWLEDGE_BASE_NOT_FOUND';
  if (message.includes('FORBIDDEN')) return 'FORBIDDEN';
  return undefined;
}

function taskErrorCode(task: WireTask): string | undefined {
  try {
    const result = businessResult(task);
    const error = result.error as { code?: unknown } | undefined;
    return typeof error?.code === 'string' ? error.code : undefined;
  } catch { return undefined; }
}

async function runLiveEvaluation(
  runId: string, fixtures: FixtureSet, htmlFixtures: HtmlFixtureSet, report: Record<string, unknown>, reportPath: string,
): Promise<void> {
  const embedding = embeddingConfiguration();
  const pgPassword = randomBytes(24).toString('hex');
  const pgBinDir = resolve(process.env.PG_BIN_DIR?.trim() || defaultPgBinDir);
  const root = await mkdtemp(join(tmpdir(), 'pi-document-eval-'));
  let postgres: LocalPostgres | undefined;
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let ownerPool: Pool | undefined;
  const startTime = Date.now();
  const maxRuntimeMs = Number(process.env.EVAL_MAX_RUNTIME_MS ?? defaultTotalRuntimeMs);
  if (!Number.isSafeInteger(maxRuntimeMs) || maxRuntimeMs < 5 * 60_000 || maxRuntimeMs > 3 * 60 * 60_000) {
    await rm(root, { recursive: true, force: true });
    throw new EvaluationFailure('EVAL_RUNTIME_BUDGET_INVALID');
  }
  const docByKey = new Map(fixtures.documents.map(document => [document.key, document]));
  const documentIds = new Map<string, string>();
  const keyByDocumentId = new Map<string, string>();
  const sourceInfoByDocumentId = new Map<string, { key: string; format: SourceFormat; sha256: string; version: number }>();
  const parsedSourceCache = new Map<string, { bytes: Buffer; parsed: ParsedSource; sha256: string }>();
  let rpcId = 0;
  let messageId = 0;
  let httpRequestCount = 0;
  const trace = report.results as Record<string, unknown>;
  const persist = async () => {
    if (report.environment && typeof report.environment === 'object') {
      (report.environment as Record<string, unknown>).runnerHttpRequests = httpRequestCount;
    }
    await atomicWriteJson(reportPath, report);
  };
  const takeHttpBudget = () => {
    httpRequestCount += 1;
    if (httpRequestCount > maxRunnerHttpRequests) throw new EvaluationFailure('EVAL_HTTP_REQUEST_BUDGET_EXCEEDED');
  };

  async function rawA2A(baseUrl: string, token: string, method: string, params: unknown): Promise<{ status: number; body: A2AResponse }> {
    takeHttpBudget();
    const response = await fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    });
    let body: A2AResponse;
    try { body = await response.json() as A2AResponse; } catch { throw new EvaluationFailure('EVAL_A2A_RESPONSE_INVALID'); }
    return { status: response.status, body };
  }

  async function submitRequest(baseUrl: string, token: string, request: DocumentRequest): Promise<WireTask> {
    const response = await rawA2A(baseUrl, token, 'SendMessage', {
      message: {
        messageId: `eval-msg-${++messageId}`,
        role: 'ROLE_USER',
        parts: [{ data: request, mediaType: 'application/json' }],
      },
      configuration: { returnImmediately: true, acceptedOutputModes: ['application/json'] },
    });
    return taskFromResponse(response.body);
  }

  async function waitForTask(baseUrl: string, token: string, initial: WireTask): Promise<WireTask> {
    const deadline = Math.min(Date.now() + maxTaskWaitMs, startTime + maxRuntimeMs);
    let task = initial;
    let delayMs = 250;
    while (!terminalState(task)) {
      if (Date.now() >= deadline) throw new EvaluationFailure('EVAL_TASK_TIMEOUT');
      await new Promise(resolveWait => setTimeout(resolveWait, delayMs));
      delayMs = Math.min(2_000, Math.ceil(delayMs * 1.5));
      const response = await rawA2A(baseUrl, token, 'GetTask', { id: task.id });
      task = taskFromResponse(response.body);
    }
    if (task.status?.state !== 'TASK_STATE_COMPLETED') {
      const code = taskErrorCode(task) ?? task.status?.state ?? 'TASK_FAILED';
      throw new EvaluationFailure(`EVAL_TASK_${code}`);
    }
    return task;
  }

  async function runBusiness(baseUrl: string, token: string, request: DocumentRequest): Promise<{ task: WireTask; result: Record<string, unknown> }> {
    const submitted = await submitRequest(baseUrl, token, request);
    const completed = await waitForTask(baseUrl, token, submitted);
    return { task: completed, result: taskBusinessResult(completed) };
  }

  async function createKnowledgeBase(baseUrl: string, token: string, name: string): Promise<string> {
    const { result } = await runBusiness(baseUrl, token, {
      schemaVersion: '1.0', operation: 'knowledge_base.create', requestId: `eval-kb-${name}`,
      input: { name, description: 'Frozen synthetic retrieval evaluation; not real enterprise data.' },
    });
    return valueString(result.knowledgeBaseId, 'EVAL_KB_ID_MISSING');
  }

  async function uploadFixture(baseUrl: string, token: string, knowledgeBaseId: string, document: SourceDescriptor, sourceRoot: string): Promise<string> {
    const bytes = await readFixtureFile(sourceRoot, document.path);
    if (bytes.byteLength !== document.byteSize) throw new EvaluationFailure('EVAL_UPLOAD_SOURCE_SIZE_MISMATCH');
    const digest = sha256(bytes);
    if (digest !== document.sha256) throw new EvaluationFailure('EVAL_UPLOAD_SOURCE_HASH_MISMATCH');
    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mimeForFormat(document.format) }), basename(document.path));
    takeHttpBudget();
    const response = await fetch(`${baseUrl}/v1/uploads?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`, {
      method: 'POST', signal: AbortSignal.timeout(fetchTimeoutMs),
      headers: { Authorization: `Bearer ${token}` }, body: form,
    });
    const body = await response.json() as { uploadId?: string; sha256?: string; error?: { code?: string } };
    if (!response.ok || typeof body.uploadId !== 'string' || body.sha256 !== document.sha256) {
      throw new EvaluationFailure(`EVAL_UPLOAD_${body.error?.code ?? response.status}`);
    }
    return body.uploadId;
  }

  async function sourceBytesForHit(baseUrl: string, token: string, hit: Record<string, unknown>): Promise<{ bytes: Buffer; parsed: ParsedSource; sha256: string }> {
    const documentId = valueString(hit.documentId, 'EVAL_HIT_DOCUMENT_ID_MISSING');
    const document = sourceInfoByDocumentId.get(documentId);
    if (!document) throw new EvaluationFailure('EVAL_HIT_SOURCE_METADATA_MISSING');
    const version = Number(hit.version);
    if (!Number.isSafeInteger(version) || version !== document.version) throw new EvaluationFailure('EVAL_HIT_VERSION_MISMATCH');
    const cacheKey = `${document.key}:${version}`;
    const cached = parsedSourceCache.get(cacheKey);
    if (cached) return cached;
    const contentUri = valueString(hit.contentUri, 'EVAL_HIT_CONTENT_URI_MISSING');
    let uri: URL;
    try { uri = new URL(contentUri); } catch { throw new EvaluationFailure('EVAL_HIT_CONTENT_URI_INVALID'); }
    const expectedPath = `/v1/documents/${encodeURIComponent(documentId)}/content`;
    if (uri.origin !== new URL(baseUrl).origin || uri.pathname !== expectedPath || uri.searchParams.get('version') !== String(version)) {
      throw new EvaluationFailure('EVAL_HIT_CONTENT_URI_SCOPE_INVALID');
    }
    takeHttpBudget();
    const response = await fetch(uri, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(fetchTimeoutMs) });
    if (!response.ok) throw new EvaluationFailure(`EVAL_CITATION_SOURCE_HTTP_${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = sha256(bytes);
    if (digest !== document.sha256) throw new EvaluationFailure('EVAL_CITATION_SOURCE_HASH_MISMATCH');
    const parsed = await parseSource(bytes, mimeForFormat(document.format));
    if (!parsed.text.trim() || parsed.spans.length === 0) throw new EvaluationFailure('EVAL_CITATION_SOURCE_PARSE_EMPTY');
    const result = { bytes, parsed, sha256: digest };
    parsedSourceCache.set(cacheKey, result);
    return result;
  }

  async function verifyHit(baseUrl: string, token: string, hitValue: unknown): Promise<{ key: string; sourceRange: { startOffset: number; endOffset: number } }> {
    const hit = parseJson<Record<string, unknown>>(hitValue, 'EVAL_HIT_INVALID');
    const documentId = valueString(hit.documentId, 'EVAL_HIT_DOCUMENT_ID_MISSING');
    const key = keyByDocumentId.get(documentId);
    if (!key) throw new EvaluationFailure('EVAL_HIT_DOCUMENT_UNKNOWN');
    const sourceInfo = sourceInfoByDocumentId.get(documentId);
    if (!sourceInfo || sourceInfo.key !== key) throw new EvaluationFailure('EVAL_HIT_FIXTURE_DOCUMENT_UNKNOWN');
    const content = await sourceBytesForHit(baseUrl, token, hit);
    const sourceRange = locateSnippetRange(content.parsed, hit.snippet, hit.locator);
    if (!sourceRange) throw new EvaluationFailure('EVAL_CITATION_LOCATOR_MISMATCH');
    return { key, sourceRange };
  }

  try {
    const embeddingBudget = await estimateEmbeddingBudget(fixtures, htmlFixtures);
    const packageInfo = await packageLockInfo();
    const git = await gitInfo();
    const pgToolVersionResult = await execFileAsync(join(pgBinDir, 'postgres'), ['--version'], { timeout: 10_000 });
    const pgToolVersion = pgToolVersionResult.stdout.trim();
    if (!/^postgres \(PostgreSQL\) 17\.(?:1[0-9]|[2-9][0-9])(?:\.\d+)?$/.test(pgToolVersion)) {
      throw new EvaluationFailure('EVAL_POSTGRES_TOOL_VERSION_UNSUPPORTED');
    }
    report.environment = {
      ...systemInfo(),
      ...packageInfo,
      git,
      postgresToolVersion: pgToolVersion,
      embedding: embedding.publicProfile,
      embeddingConfigSha256: embedding.configSha256,
      fixtureSha256: fixtures.manifest.datasetSha256,
      fixtureCounts: fixtures.manifest.counts,
      htmlSnapshotSha256: htmlFixtures.datasetSha256,
      htmlSnapshotCount: htmlFixtures.snapshots.length,
      htmlSnapshotCoverage: 'uploaded synthetic HTML parser/locator smoke using frozen support text for deterministic keyword retrieval; public URL fetch is not covered by these snapshots',
      embeddingBudget,
      runtimeBudgets: {
        maxDocuments, maxQueries, maxFileBytes, maxTotalFileBytes, maxTaskWaitMs,
        supplementalVersionUpdates: fixtures.updates.length,
        supplementalHtmlSnapshots: htmlFixtures.snapshots.length,
        supplementalHtmlLocatorSearches: htmlFixtures.snapshots.length,
        maxTotalRuntimeMs: maxRuntimeMs, maxRunnerHttpRequests, maxEmbeddingAttemptBudget,
        indexingWaitFor: 'indexed', searchMode: 'hybrid', searchTopK: 10, rerank: false,
        htmlLocatorSearchMode: 'keyword', htmlLocatorSearchInput: 'frozen_support_text',
        embeddingBatchSize: 8, embeddingMaxAttemptsPerRequest: EMBEDDING_MAX_ATTEMPTS,
      },
    };
    await persist();
    await mkdir(join(root, 'pg'), { recursive: true, mode: 0o700 });
    postgres = new LocalPostgres({ dataDir: join(root, 'pg'), binDir: pgBinDir, port: await reservePort(), password: pgPassword });
    await postgres.start();
    ownerPool = new Pool({ connectionString: postgres.url, max: 8, connectionTimeoutMillis: 5_000 });
    const databaseInfo = await ownerPool.query<{ server_version: string }>('SHOW server_version');
    const serverVersion = databaseInfo.rows[0]?.server_version ?? 'unknown';
    const [serverMajor, serverMinor] = serverVersion.split('.').map(Number);
    if (serverMajor !== 17 || !Number.isSafeInteger(serverMinor) || serverMinor! < 10) {
      throw new EvaluationFailure('EVAL_POSTGRES_SERVER_VERSION_UNSUPPORTED');
    }
    const availableVector = await ownerPool.query<{ default_version: string | null }>(`SELECT default_version FROM pg_available_extensions WHERE name = 'vector'`);
    if (availableVector.rowCount !== 1) throw new EvaluationFailure('EVAL_PGVECTOR_EXTENSION_FILES_MISSING');

    const ownerToken = randomBytes(32).toString('hex');
    const readerToken = randomBytes(32).toString('hex');
    const serviceConfig: ServiceConfig = {
      host: '127.0.0.1', port: 0, databaseUrl: postgres.url,
      piStoragePath: join(root, 'pi.sqlite'), blobRoot: join(root, 'blobs'),
      bootstrap: { tenantId: 'evaluation-tenant', principalId: 'evaluator', token: ownerToken },
      embedding: embedding.profile,
    };
    app = await startApp(serviceConfig);
    const vectorExtension = await ownerPool.query<{ extversion: string }>(`SELECT extversion FROM pg_extension WHERE extname = 'vector'`);
    if (vectorExtension.rowCount !== 1) throw new EvaluationFailure('EVAL_PGVECTOR_EXTENSION_MISSING');
    const currentApp = app;
    const reader: Principal = { tenantId: 'evaluation-tenant', id: 'reader', scopes: ['knowledge:read'] };
    const publicKbId = await createKnowledgeBase(currentApp.baseUrl, ownerToken, `evaluation-public-${runId}`);
    const restrictedKbId = await createKnowledgeBase(currentApp.baseUrl, ownerToken, `evaluation-restricted-${runId}`);
    const htmlKbId = await createKnowledgeBase(currentApp.baseUrl, ownerToken, `evaluation-html-snapshots-${runId}`);
    await currentApp.backend.provisionPrincipal({ ...reader, token: readerToken });
    await currentApp.backend.grantKnowledgeBase(reader, publicKbId, ['knowledge:read']);

    const pgConfig = { binDir: relative(projectRoot, pgBinDir), serverVersion, pgvectorVersion: vectorExtension.rows[0]!.extversion };
    (report.environment as Record<string, unknown>).postgres = pgConfig;
    report.startedAt = new Date().toISOString();
    report.status = 'running';
    await persist();

    const docsReport: Array<Record<string, unknown>> = [];
    trace.documents = docsReport;
    for (const document of fixtures.documents) {
      if (Date.now() - startTime > maxRuntimeMs) throw new EvaluationFailure('EVAL_TOTAL_RUNTIME_BUDGET_EXCEEDED');
      const knowledgeBaseId = document.knowledgeBaseRole === 'restricted' ? restrictedKbId : publicKbId;
      const uploadId = await uploadFixture(currentApp.baseUrl, ownerToken, knowledgeBaseId, document, fixtures.root);
      const submitted = await submitRequest(currentApp.baseUrl, ownerToken, {
        schemaVersion: '1.0', operation: 'document.save', requestId: `eval-save-${document.key}`,
        knowledgeBaseId,
        input: { title: document.title, tags: document.tags, source: { kind: 'upload', uploadId }, waitFor: 'indexed' },
      });
      const task = await waitForTask(currentApp.baseUrl, ownerToken, submitted);
      const saved = taskBusinessResult(task);
      const documentId = valueString(saved.documentId, 'EVAL_SAVED_DOCUMENT_ID_MISSING');
      const version = Number(saved.version);
      const savedHash = valueString(saved.sha256, 'EVAL_SAVED_SOURCE_HASH_MISSING');
      if (version !== 1 || savedHash !== document.sha256 || saved.indexState !== 'ready') {
        throw new EvaluationFailure('EVAL_SAVED_DOCUMENT_STATE_INVALID');
      }
      documentIds.set(document.key, documentId);
      keyByDocumentId.set(documentId, document.key);
      sourceInfoByDocumentId.set(documentId, { key: document.key, format: document.format, sha256: savedHash, version });
      docsReport.push({ key: document.key, documentId, version, sha256: savedHash, format: document.format,
        language: document.language, knowledgeBaseRole: document.knowledgeBaseRole, taskId: task.id, indexState: saved.indexState });
      await persist();
    }
    if (docsReport.length !== maxDocuments) throw new EvaluationFailure('EVAL_DOCUMENT_LOAD_INCOMPLETE');

    const versionUpdateReport: Array<Record<string, unknown>> = [];
    trace.versionUpdates = versionUpdateReport;
    await persist();
    for (const transition of fixtures.updates) {
      const updateRow: Record<string, unknown> = {
        documentKey: transition.documentKey,
        status: 'running',
        fromVersion: transition.fromVersion,
        toVersion: transition.toVersion,
      };
      versionUpdateReport.push(updateRow);
      await persist();
      try {
        const document = docByKey.get(transition.documentKey);
        const documentId = documentIds.get(transition.documentKey);
        if (!document || !documentId) throw new EvaluationFailure('EVAL_VERSION_DOCUMENT_MISSING');
        const knowledgeBaseId = document.knowledgeBaseRole === 'restricted' ? restrictedKbId : publicKbId;
        const source: SourceDescriptor = {
          key: document.key,
          format: transition.format,
          title: document.title,
          path: transition.version2Path,
          sha256: transition.version2Sha256,
          byteSize: transition.version2ByteSize,
          tags: document.tags,
        };
        const uploadId = await uploadFixture(currentApp.baseUrl, ownerToken, knowledgeBaseId, source, fixtures.root);
        const updateRequest: DocumentRequest = {
          schemaVersion: '1.0', operation: 'document.update', requestId: `eval-update-${transition.documentKey}`,
          knowledgeBaseId,
          input: {
            documentId,
            expectedVersion: transition.fromVersion,
            source: { kind: 'upload', uploadId },
            title: document.title,
            tags: document.tags,
            waitFor: 'indexed',
          },
        };
        const { task, result } = await runBusiness(currentApp.baseUrl, ownerToken, updateRequest);
        const updatedDocumentId = valueString(result.documentId, 'EVAL_UPDATED_DOCUMENT_ID_MISSING');
        const updatedVersion = Number(result.version);
        const updatedSha = valueString(result.sha256, 'EVAL_UPDATED_SOURCE_HASH_MISSING');
        if (updatedDocumentId !== documentId || updatedVersion !== transition.toVersion
          || updatedSha !== transition.version2Sha256 || result.indexState !== 'ready') {
          throw new EvaluationFailure('EVAL_VERSION_UPDATE_RESULT_INVALID');
        }
        sourceInfoByDocumentId.set(documentId, {
          key: document.key, format: document.format, sha256: transition.version2Sha256, version: transition.toVersion,
        });

        const oldSupportId = document.language === 'en' ? 'fact_en' : 'fact_zh';
        const oldSupport = document.supportPassages.find(passage => passage.id === oldSupportId && passage.version === transition.fromVersion);
        if (!oldSupport) throw new EvaluationFailure('EVAL_VERSION_BASELINE_SUPPORT_MISSING');
        const oldVersionSearch = await runBusiness(currentApp.baseUrl, ownerToken, {
          schemaVersion: '1.0', operation: 'document.search', requestId: `eval-old-version-${transition.documentKey}`,
          knowledgeBaseId,
          input: { query: oldSupport.text, topK: 10, mode: 'keyword', rerank: false,
            filters: { documentIds: [documentId], sourceTypes: ['upload'] } },
        });
        const oldHits = oldVersionSearch.result.results;
        if (!Array.isArray(oldHits)) throw new EvaluationFailure('EVAL_OLD_VERSION_SEARCH_RESULTS_INVALID');
        const unexpectedDocumentHits = oldHits.filter(value => String((value as Record<string, unknown>).documentId) !== documentId).length;
        const oldVersionHits = oldHits.filter(value => Number((value as Record<string, unknown>).version) === transition.fromVersion).length;
        if (unexpectedDocumentHits !== 0 || oldVersionHits !== 0) throw new EvaluationFailure('EVAL_STALE_VERSION_SEARCH_RESULT');
        let currentVersionCitationChecks = 0;
        for (const hit of oldHits) {
          await verifyHit(currentApp.baseUrl, ownerToken, hit);
          currentVersionCitationChecks += 1;
        }
        updateRow.status = 'passed';
        updateRow.documentId = documentId;
        updateRow.updateTaskId = task.id;
        updateRow.resultVersion = updatedVersion;
        updateRow.sha256 = updatedSha;
        updateRow.indexState = result.indexState;
        updateRow.oldVersionSearchHitCount = oldHits.length;
        updateRow.oldVersionSearchStaleHitCount = oldVersionHits;
        updateRow.oldVersionSearchCurrentVersionCitationChecks = currentVersionCitationChecks;
      } catch (error) {
        updateRow.status = 'failed';
        updateRow.failureCode = safeErrorCode(error);
        await persist();
        throw error;
      }
      await persist();
    }
    trace.versionUpdateSummary = {
      fixtureCount: fixtures.updates.length,
      passedCount: versionUpdateReport.filter(row => row.status === 'passed').length,
      sameDocumentIdCount: versionUpdateReport.filter(row => row.documentId && row.resultVersion === 2).length,
      activeVersion2Count: versionUpdateReport.filter(row => row.resultVersion === 2).length,
      staleVersionSearchHitCount: versionUpdateReport.reduce((count, row) => count + Number(row.oldVersionSearchStaleHitCount ?? 0), 0),
    };
    await persist();

    const htmlSnapshotReport: Array<Record<string, unknown>> = [];
    trace.htmlSnapshots = htmlSnapshotReport;
    await persist();
    for (const snapshot of htmlFixtures.snapshots) {
      const snapshotRow: Record<string, unknown> = {
        key: snapshot.key, status: 'running', sourceTransport: 'upload_snapshot', searchInput: 'frozen_support_text',
      };
      htmlSnapshotReport.push(snapshotRow);
      await persist();
      try {
        const uploadId = await uploadFixture(currentApp.baseUrl, ownerToken, htmlKbId, snapshot, htmlFixtures.root);
        const save = await runBusiness(currentApp.baseUrl, ownerToken, {
          schemaVersion: '1.0', operation: 'document.save', requestId: `eval-html-save-${snapshot.key}`,
          knowledgeBaseId: htmlKbId,
          input: { title: snapshot.title, tags: snapshot.tags, source: { kind: 'upload', uploadId }, waitFor: 'indexed' },
        });
        const documentId = valueString(save.result.documentId, 'EVAL_HTML_DOCUMENT_ID_MISSING');
        const version = Number(save.result.version);
        const savedSha = valueString(save.result.sha256, 'EVAL_HTML_SOURCE_HASH_MISSING');
        if (version !== 1 || savedSha !== snapshot.sha256 || save.result.indexState !== 'ready') {
          throw new EvaluationFailure('EVAL_HTML_DOCUMENT_STATE_INVALID');
        }
        keyByDocumentId.set(documentId, snapshot.key);
        sourceInfoByDocumentId.set(documentId, { key: snapshot.key, format: 'html', sha256: snapshot.sha256, version: 1 });
        const search = await runBusiness(currentApp.baseUrl, ownerToken, {
          schemaVersion: '1.0', operation: 'document.search', requestId: `eval-html-locator-${snapshot.key}`,
          knowledgeBaseId: htmlKbId,
          input: { query: snapshot.supportText, topK: 10, mode: 'keyword', rerank: false,
            filters: { documentIds: [documentId], sourceTypes: ['upload'] } },
        });
        const hits = search.result.results;
        if (!Array.isArray(hits)) throw new EvaluationFailure('EVAL_HTML_SEARCH_RESULTS_INVALID');
        let locatorVerified = false;
        let verifiedHits = 0;
        for (const hitValue of hits) {
          const hit = parseJson<Record<string, unknown>>(hitValue, 'EVAL_HTML_HIT_INVALID');
          if (hit.documentId !== documentId) throw new EvaluationFailure('EVAL_HTML_SEARCH_SCOPE_INVALID');
          await verifyHit(currentApp.baseUrl, ownerToken, hit);
          verifiedHits += 1;
          const locator = hit.locator as Record<string, unknown> | undefined;
          const snippet = typeof hit.snippet === 'string' ? hit.snippet.replace(/\s+/gu, ' ').trim() : '';
          const support = snapshot.supportText.replace(/\s+/gu, ' ').trim();
          if (locator?.kind === 'html_section' && locator.fragment === snapshot.expectedLocator.fragment
            && JSON.stringify(locator.headingPath) === JSON.stringify(snapshot.expectedLocator.headingPath)
            && snippet.includes(support)) locatorVerified = true;
        }
        if (!locatorVerified) throw new EvaluationFailure('EVAL_HTML_LOCATOR_NOT_VERIFIED');
        snapshotRow.status = 'passed';
        snapshotRow.documentId = documentId;
        snapshotRow.version = version;
        snapshotRow.sha256 = savedSha;
        snapshotRow.indexState = save.result.indexState;
        snapshotRow.saveTaskId = save.task.id;
        snapshotRow.searchTaskId = search.task.id;
        snapshotRow.searchMode = search.result.actualMode;
        snapshotRow.searchHitCount = hits.length;
        snapshotRow.citationHashAndLocatorChecks = verifiedHits;
        snapshotRow.expectedHtmlLocator = snapshot.expectedLocator;
        snapshotRow.publicUrlFetchExercised = false;
      } catch (error) {
        snapshotRow.status = 'failed';
        snapshotRow.failureCode = safeErrorCode(error);
        await persist();
      }
      await persist();
    }
    trace.htmlSnapshotSummary = {
      snapshotCount: htmlFixtures.snapshots.length,
      failedCount: htmlSnapshotReport.filter(row => row.status === 'failed').length,
      gatePass: htmlSnapshotReport.length === htmlFixtures.snapshots.length
        && htmlSnapshotReport.every(row => row.status === 'passed'),
      uploadIndexedCount: htmlSnapshotReport.filter(row => row.status === 'passed' && row.indexState === 'ready').length,
      parserLocatorVerifiedCount: htmlSnapshotReport.filter(row => row.status === 'passed').length,
      sha256VerifiedCount: htmlSnapshotReport.filter(row => row.status === 'passed' && typeof row.sha256 === 'string').length,
      publicUrlFetchExercised: false,
      sourceTransport: 'upload_snapshot',
      datasetSha256: htmlFixtures.datasetSha256,
    };
    await persist();

    const queryReport: QueryRun[] = [];
    trace.queries = queryReport;
    await persist();
    for (const query of fixtures.queries) {
      if (Date.now() - startTime > maxRuntimeMs) throw new EvaluationFailure('EVAL_TOTAL_RUNTIME_BUDGET_EXCEEDED');
      const row: QueryRun = {
        queryId: query.id, category: query.category, ...(query.scenario ? { scenario: query.scenario } : {}),
        language: query.language, split: query.split, expectedOutcome: query.expectedOutcome,
        expectedDocumentKeys: query.expectedDocumentKeys, expectedFormats: query.expectedFormats,
        status: 'failed', actualUniqueDocumentKeys: [], resultCount: 0, citationChecks: { verified: 0, failed: 0 },
      };
      queryReport.push(row);
      try {
        const requestedKbRole = query.scenario === 'permission'
          ? 'restricted'
          : query.expectedKnowledgeBaseRole
            ?? docByKey.get(query.expectedDocumentKeys[0] ?? '')?.knowledgeBaseRole
            ?? 'public';
        const kbId = requestedKbRole === 'restricted' ? restrictedKbId : publicKbId;
        const token = query.principalRole === 'reader' ? readerToken : ownerToken;
        const request: DocumentRequest = {
          schemaVersion: '1.0', operation: 'document.search', requestId: `eval-search-${query.id}`,
          knowledgeBaseId: kbId,
          input: { query: query.query, topK: 10, mode: 'hybrid', rerank: false,
            ...(query.filters ? { filters: query.filters } : {}) },
        };
        const submitted = await rawA2A(currentApp.baseUrl, token, 'SendMessage', {
          message: { messageId: `eval-msg-${++messageId}`, role: 'ROLE_USER', parts: [{ data: request, mediaType: 'application/json' }] },
          configuration: { returnImmediately: true, acceptedOutputModes: ['application/json'] },
        });
        if (query.scenario === 'permission' && submitted.body.error) {
          const code = jsonRpcErrorCode(submitted.body);
          row.denialCode = code;
          row.denied = code === 'KNOWLEDGE_BASE_NOT_FOUND' || code === 'FORBIDDEN';
          row.leakage = false;
          row.status = row.denied ? 'completed' : 'failed';
          row.failureCode = row.denied ? undefined : 'EVAL_PERMISSION_DENIAL_UNEXPECTED';
          row.note = row.denied ? code : `A2A error ${submitted.body.error.code ?? 'unknown'} was not an authorization denial.`;
        } else {
          const initial = taskFromResponse(submitted.body);
          const task = await waitForTask(currentApp.baseUrl, token, initial);
          row.taskId = task.id;
          const result = taskBusinessResult(task);
          const rawHits = result.results;
          if (!Array.isArray(rawHits)) throw new EvaluationFailure('EVAL_SEARCH_RESULTS_INVALID');
          row.resultCount = rawHits.length;
          row.actualMode = typeof result.actualMode === 'string' ? result.actualMode : undefined;
          row.degraded = typeof result.degraded === 'boolean' ? result.degraded : undefined;
          row.degradationReason = typeof result.degradationReason === 'string' ? result.degradationReason : undefined;
          const rankedUniqueIds: string[] = [];
          const seenIds = new Set<string>();
          const supportOverlapKeys = new Set<string>();
          const fullSupportSnippetKeys = new Set<string>();
          for (const value of rawHits) {
            const hit = parseJson<Record<string, unknown>>(value, 'EVAL_HIT_INVALID');
            const documentId = valueString(hit.documentId, 'EVAL_HIT_DOCUMENT_ID_MISSING');
            if (!seenIds.has(documentId)) { seenIds.add(documentId); rankedUniqueIds.push(documentId); }
            try {
              const verified = await verifyHit(currentApp.baseUrl, token, hit);
              row.citationChecks.verified += 1;
              if (!row.actualUniqueDocumentKeys.includes(verified.key)) row.actualUniqueDocumentKeys.push(verified.key);
              const expectedIndex = query.expectedDocumentKeys.indexOf(verified.key);
              if (expectedIndex >= 0 && typeof hit.snippet === 'string') {
                const support = query.supportText[expectedIndex]!;
                const supportAnchor = query.acceptableSourceLocators[expectedIndex]!;
                const sourceInfo = sourceInfoByDocumentId.get(String(hit.documentId));
                if (!sourceInfo || Number(hit.version) !== supportAnchor.version || Number(hit.version) !== query.expectedVersion && query.category === 'version'
                  || sourceInfo.sha256 !== supportAnchor.sha256 || sourceInfo.version !== supportAnchor.version) {
                  throw new EvaluationFailure('EVAL_GOLD_SOURCE_VERSION_MISMATCH');
                }
                const normalizedSnippet = hit.snippet.replace(/\s+/gu, ' ').trim();
                const normalizedSupport = support.replace(/\s+/gu, ' ').trim();
                const containsSupport = normalizedSnippet.includes(normalizedSupport);
                const overlapsSupport = verified.sourceRange.startOffset < supportAnchor.range.endOffset
                  && verified.sourceRange.endOffset > supportAnchor.range.startOffset;
                if (overlapsSupport) supportOverlapKeys.add(verified.key);
                if (containsSupport && overlapsSupport) fullSupportSnippetKeys.add(verified.key);
              }
            } catch (error) {
              row.citationChecks.failed += 1;
              throw error;
            }
          }
          if (query.scenario === 'permission') {
            row.denied = false;
            row.leakage = rawHits.length > 0;
            row.actualUniqueDocumentKeys = rankedUniqueIds.map(id => keyByDocumentId.get(id) ?? 'unknown');
            row.status = 'completed';
          } else if (query.expectedOutcome === 'no_answer') {
            row.falsePositive = rawHits.length > 0;
            row.status = 'completed';
          } else {
            row.status = 'completed';
            const expectedDocumentIds = query.expectedDocumentKeys.map(key => documentIds.get(key)).filter((id): id is string => Boolean(id));
            const rankedKeys: string[] = [];
            const rankedKeySeen = new Set<string>();
            for (const documentId of rankedUniqueIds) {
              const key = keyByDocumentId.get(documentId);
              if (key && !rankedKeySeen.has(key)) { rankedKeySeen.add(key); rankedKeys.push(key); }
            }
            const score = scoreDocumentRanking(query.expectedDocumentKeys, rankedKeys);
            row.recallAt10 = score.recallAt10;
            row.mrrAt10 = score.mrrAt10;
            if (expectedDocumentIds.length !== query.expectedDocumentKeys.length) throw new EvaluationFailure('EVAL_EXPECTED_DOCUMENT_ID_MISSING');
            row.supportCoverage = {
              expectedPassageCount: query.expectedDocumentKeys.length,
              locatorOverlapCount: supportOverlapKeys.size,
              fullSnippetCount: fullSupportSnippetKeys.size,
            };
            row.note = fullSupportSnippetKeys.size === query.expectedDocumentKeys.length
              ? undefined
              : `Support coverage: ${supportOverlapKeys.size}/${query.expectedDocumentKeys.length} cited ranges overlap the frozen support locators; ${fullSupportSnippetKeys.size}/${query.expectedDocumentKeys.length} complete support snippets were returned.`;
          }
          if (result.actualMode !== 'hybrid') throw new EvaluationFailure('EVAL_SEARCH_MODE_DEGRADED');
          if (typeof result.degradationReason === 'string' && result.degradationReason.includes('embedding_unavailable')) {
            throw new EvaluationFailure('EVAL_QUERY_EMBEDDING_UNAVAILABLE');
          }
          if (query.scenario === 'permission' && rawHits.length > 0) row.leakage = true;
        }
      } catch (error) {
        row.status = 'failed';
        row.failureCode = safeErrorCode(error);
      }
      await persist();
    }

    const querySummary = buildEvaluationSummary(queryReport);
    const htmlSnapshotGatePass = (trace.htmlSnapshotSummary as { gatePass?: unknown } | undefined)?.gatePass === true;
    const summary = {
      ...querySummary,
      htmlSnapshotGatePass,
      acceptancePass: querySummary.acceptancePass && htmlSnapshotGatePass,
      status: !querySummary.qualityGatePass || !htmlSnapshotGatePass ? 'failed' : querySummary.status,
    };
    trace.summary = summary;
    report.completedAt = new Date().toISOString();
    report.status = summary.status;
    report.failureCode = summary.acceptancePass ? undefined
      : summary.qualityGatePass && htmlSnapshotGatePass ? 'EVAL_ACCEPTANCE_INCOMPLETE' : 'EVAL_ACCEPTANCE_GATE_FAILED';
    report.elapsedMs = Date.now() - startTime;
    (report.environment as Record<string, unknown>).runnerHttpRequests = httpRequestCount;
    await persist();
    if (!summary.qualityGatePass || !htmlSnapshotGatePass) throw new EvaluationFailure('EVAL_ACCEPTANCE_GATE_FAILED');
    if (!summary.acceptancePass) throw new EvaluationFailure('EVAL_ACCEPTANCE_INCOMPLETE');
  } finally {
    await app?.close().catch(() => undefined);
    await ownerPool?.end().catch(() => undefined);
    await postgres?.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const live = args.includes('--live');
  if (args.some(argument => argument !== '--live' && argument !== '--validate-only') || (live && args.includes('--validate-only'))) {
    throw new EvaluationFailure('EVAL_USAGE_INVALID');
  }
  if (!live) {
    const [fixtures, htmlSnapshots] = await Promise.all([loadFrozenFixtures(), loadHtmlSnapshots()]);
    const countSummary = {
      datasetSha256: fixtures.manifest.datasetSha256,
      documents: fixtures.manifest.counts.documents,
      queries: fixtures.manifest.counts.queries,
      blindQueries: fixtures.manifest.blindSplit.blindQueries,
      versionTransitions: fixtures.manifest.counts.versionTransitions,
      htmlSnapshotSha256: htmlSnapshots.datasetSha256,
      htmlSnapshots: htmlSnapshots.snapshots.length,
      publicUrlFetchCoverage: 'not covered by synthetic upload snapshots',
    };
    process.stdout.write(`${JSON.stringify({ status: 'fixtures_valid', ...countSummary })}\n`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `retrieval-${stamp}-${randomBytes(3).toString('hex')}`;
  const evidenceRoot = join(projectRoot, 'evidence', 'evaluation', runId);
  const reportPath = join(evidenceRoot, 'report.json');
  await mkdir(evidenceRoot, { recursive: true, mode: 0o700 });
  const report: Record<string, unknown> = {
    schemaVersion: 1,
    runId,
    status: 'running',
    startedAt: new Date().toISOString(),
    results: { documents: [], versionUpdates: [], htmlSnapshots: [], queries: [] },
  };
  await atomicWriteJson(reportPath, report);
  try {
    const [fixtures, htmlSnapshots] = await Promise.all([loadFrozenFixtures(), loadHtmlSnapshots()]);
    report.fixtureSha256 = fixtures.manifest.datasetSha256;
    report.fixtureCounts = fixtures.manifest.counts;
    report.htmlSnapshotSha256 = htmlSnapshots.datasetSha256;
    report.htmlSnapshotCount = htmlSnapshots.snapshots.length;
    await atomicWriteJson(reportPath, report);
    await runLiveEvaluation(runId, fixtures, htmlSnapshots, report, reportPath);
    process.stdout.write(`${JSON.stringify({ status: report.status, runId, report: relative(projectRoot, reportPath) })}\n`);
  } catch (error) {
    const failureCode = safeErrorCode(error);
    report.status = failureCode === 'EVAL_ACCEPTANCE_INCOMPLETE' ? 'partial' : 'failed';
    report.failureCode = failureCode;
    report.completedAt = new Date().toISOString();
    await atomicWriteJson(reportPath, report).catch(() => undefined);
    process.stderr.write(`${JSON.stringify({ status: report.status, runId, code: failureCode, report: relative(projectRoot, reportPath) })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try { await main(); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'failed', code: safeErrorCode(error) })}\n`);
    process.exitCode = 1;
  }
}
