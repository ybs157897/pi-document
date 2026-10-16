import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';

type CorpusDocument = { id: string; text: string };
type QueryFixture = {
  id: string;
  kind: 'exact_terms' | 'identifier' | 'synonym_probe';
  query: string;
  expectedDocumentIds: string[];
  note?: string;
};
type Fixture = { fixtureVersion: number; description: string; corpus: CorpusDocument[]; queries: QueryFixture[] };
type Hit = { id: string; rank: number };
type SearchRow = { document_id: string; rank: number };

const fixturePath = fileURLToPath(new URL('../fixtures/retrieval/lexical-cases.json', import.meta.url));
const defaultEvidencePath = fileURLToPath(new URL('../evidence/m0/lexical-spike.json', import.meta.url));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8')) as Fixture;
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });

export function tokenize(text: string): string[] {
  return [...segmenter.segment(text)]
    .filter(part => part.isWordLike)
    .map(part => part.segment.toLowerCase());
}

export function buildTsQuery(tokens: string[]): string {
  assert.ok(tokens.length > 0, 'query must contain at least one word-like token');
  for (const token of tokens) {
    assert.match(token, /^[\p{L}\p{N}_]+$/u, `unsupported text-search token: ${token}`);
  }
  return tokens.map(token => `'${token}'`).join(' & ');
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const { port } = address;
  await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()));
  return port;
}

export async function runLexicalSpike(evidencePath = defaultEvidencePath): Promise<Record<string, unknown>> {
  assert.ok(fixture.corpus.length >= 20, 'the fixture must contain at least 20 fixed Chinese documents');
  assert.ok(fixture.queries.length >= 20, 'the fixture must contain at least 20 fixed query cases');

  const port = await reserveLocalPort();
  const databaseDir = await mkdtemp(join(tmpdir(), 'pi-document-lexical-spike-'));
  const postgres = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password: randomUUID(),
    persistent: false,
    postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
    onLog: () => undefined,
    onError: message => console.error(message),
  });

  let client: ReturnType<EmbeddedPostgres['getPgClient']> | undefined;
  try {
    await postgres.initialise();
    await postgres.start();
    client = postgres.getPgClient('postgres', '127.0.0.1');
    await client.connect();

    const database = await client.query(`
      SELECT version() AS version,
             current_setting('server_version') AS server_version,
             current_setting('server_version_num') AS server_version_num,
             current_setting('server_encoding') AS server_encoding,
             current_setting('default_text_search_config') AS default_text_search_config,
             database.datcollate AS database_collation,
             database.datctype AS database_ctype
      FROM pg_database AS database
      WHERE database.datname = current_database()
    `);
    await client.query(`
      CREATE TEMP TABLE lexical_documents (
        document_id text PRIMARY KEY,
        original_text text NOT NULL,
        segmented_text text NOT NULL,
        native_vector tsvector NOT NULL,
        segmented_vector tsvector NOT NULL
      )
    `);

    for (const document of fixture.corpus) {
      const segmentedText = tokenize(document.text).join(' ');
      await client.query(
        `INSERT INTO lexical_documents
          (document_id, original_text, segmented_text, native_vector, segmented_vector)
         VALUES ($1, $2, $3, to_tsvector('simple', $2), to_tsvector('simple', $3))`,
        [document.id, document.text, segmentedText],
      );
    }

    const cases = [];
    for (const queryCase of fixture.queries) {
      const queryTokens = tokenize(queryCase.query);
      const tsQuery = buildTsQuery(queryTokens);
      const parsed = await client.query<{ parsed: string }>(`SELECT to_tsquery('simple', $1)::text AS parsed`, [tsQuery]);
      const nativeHits: { rows: SearchRow[] } = await client.query(
        `SELECT document_id, ts_rank_cd(native_vector, to_tsquery('simple', $1))::float8 AS rank
         FROM lexical_documents
         WHERE native_vector @@ to_tsquery('simple', $1)
         ORDER BY rank DESC, document_id`,
        [tsQuery],
      );
      const segmentedHits: { rows: SearchRow[] } = await client.query(
        `SELECT document_id, ts_rank_cd(segmented_vector, to_tsquery('simple', $1))::float8 AS rank
         FROM lexical_documents
         WHERE segmented_vector @@ to_tsquery('simple', $1)
         ORDER BY rank DESC, document_id`,
        [tsQuery],
      );
      const segmentedIds: string[] = segmentedHits.rows.map((row: SearchRow) => row.document_id);
      const missingExpected = queryCase.expectedDocumentIds.filter(id => !segmentedIds.includes(id));

      if (queryCase.kind === 'synonym_probe') {
        assert.equal(segmentedIds.length, 0, `${queryCase.id}: literal lexical query unexpectedly matched ${segmentedIds.join(', ')}`);
      } else {
        assert.deepEqual(missingExpected, [], `${queryCase.id}: expected documents were not retrieved`);
      }

      cases.push({
        id: queryCase.id,
        kind: queryCase.kind,
        query: queryCase.query,
        queryTokens,
        tsQuery: parsed.rows[0]?.parsed,
        expectedDocumentIds: queryCase.expectedDocumentIds,
        nativeHits: nativeHits.rows.map(row => ({ id: row.document_id, rank: row.rank } satisfies Hit)),
        segmentedHits: segmentedHits.rows.map(row => ({ id: row.document_id, rank: row.rank } satisfies Hit)),
        expectedHitPresent: missingExpected.length === 0,
        lexicalOutcome: queryCase.kind === 'synonym_probe' ? 'no_literal_match' : 'expected_hit',
        semanticOutcome: 'not_evaluated_without_embedding',
        ...(queryCase.note ? { note: queryCase.note } : {}),
      });
    }

    const tokenization = await client.query(`
      SELECT to_tsvector('simple', $1)::text AS native_vector,
             to_tsvector('simple', $2)::text AS segmented_vector,
             to_tsquery('simple', $3)::text AS parsed_query,
             to_tsvector('simple', $1) @@ to_tsquery('simple', $3) AS native_match,
             to_tsvector('simple', $2) @@ to_tsquery('simple', $3) AS segmented_match
    `, ['任务恢复', '任务 恢复', buildTsQuery(tokenize('任务恢复'))]);

    const result = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scope: 'Local development spike only; no product schema, PG service, or pgvector extension was changed.',
      runtime: {
        node: process.version,
        icu: process.versions.icu,
        platform: process.platform,
        architecture: process.arch,
        segmenterLocale: segmenter.resolvedOptions().locale,
        segmenterGranularity: segmenter.resolvedOptions().granularity,
      },
      instance: {
        host: '127.0.0.1',
        port,
        database: 'postgres',
        temporaryDataDirectory: true,
        persistent: false,
      },
      postgres: database.rows[0],
      strategy: {
        textSearchConfiguration: 'simple',
        tokenizer: "Intl.Segmenter('zh', { granularity: 'word' })",
        indexing: 'Insert spaces between word-like segments before to_tsvector so query and document use identical token boundaries.',
        query: "to_tsquery('simple', quoted_tokens_joined_with_&) ; all query tokens are required.",
        nativeComparison: tokenization.rows[0],
        semanticLimitation: 'No embeddings, synonym dictionary, or reranker were run. synonym_probe no-hits are lexical observations only; semantic retrieval remains unverified.',
      },
      fixture: {
        corpusCount: fixture.corpus.length,
        queryCount: fixture.queries.length,
        exactAndIdentifierCases: fixture.queries.filter(item => item.kind !== 'synonym_probe').length,
        synonymProbeCases: fixture.queries.filter(item => item.kind === 'synonym_probe').length,
      },
      summary: {
        casesRun: cases.length,
        segmentedExpectedHits: cases.filter(item => item.kind !== 'synonym_probe' && item.expectedHitPresent).length,
        synonymProbesWithNoLiteralHit: cases.filter(item => item.kind === 'synonym_probe' && item.lexicalOutcome === 'no_literal_match').length,
        cases,
      },
    };

    await client.end();
    client = undefined;
    await postgres.stop();
    await rm(databaseDir, { recursive: true, force: true });
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
  } finally {
    if (client) await client.end().catch(() => undefined);
    await postgres.stop().catch(() => undefined);
    await rm(databaseDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runLexicalSpike();
    const summary = result.summary as { casesRun: number; segmentedExpectedHits: number; synonymProbesWithNoLiteralHit: number };
    console.log(`PostgreSQL lexical spike: ${summary.casesRun} cases, ${summary.segmentedExpectedHits} expected hits, ${summary.synonymProbesWithNoLiteralHit} literal synonym-probe misses.`);
    console.log(`Evidence: ${defaultEvidencePath}`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
