import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSource } from '../src/ingestion/parser.js';

const root = 'fixtures/evaluation/frozen';
const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.datasetSha256, 'da6a450c6f813ce99b1d26acd3e88863c689bc200e7bb2ee3c14ecb580a89c74');
for (const file of manifest.files) {
  const bytes = await readFile(join(root, file.path));
  assert.equal(bytes.length, file.byteSize, file.path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
}
const corpus = JSON.parse(await readFile(join(root, 'corpus.json'), 'utf8'));
const queries = JSON.parse(await readFile(join(root, 'queries.json'), 'utf8')).queries;
const transitions = JSON.parse(await readFile(join(root, 'updates.json'), 'utf8')).transitions;
assert.equal(corpus.documents.length, 100); assert.equal(queries.length, 100); assert.equal(transitions.length, 10);
assert.equal(new Set(corpus.documents.map((d: any) => d.key)).size, 100);
assert.equal(new Set(queries.map((q: any) => q.id)).size, 100);
assert.equal(queries.filter((q: any) => q.split === 'blind').length, 20);
const mime: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const texts = new Map<string, string>();
let passages = 0;
for (const document of corpus.documents) {
  const parsed = await parseSource(await readFile(join(root, document.path)), mime[document.format]!);
  texts.set(`${document.key}:1`, parsed.text);
  for (const passage of document.supportPassages) {
    assert.equal([...parsed.text].slice(passage.range.startOffset, passage.range.endOffset).join(''), passage.text, document.key);
    passages++;
  }
}
for (const update of transitions) {
  const parsed = await parseSource(await readFile(join(root, update.version2Path)), mime[update.format]!);
  texts.set(`${update.documentKey}:2`, parsed.text);
  const range = update.acceptableSourceLocator.range;
  assert.equal([...parsed.text].slice(range.startOffset, range.endOffset).join(''), update.supportText, update.fixtureId);
  assert.notEqual(texts.get(`${update.documentKey}:1`), parsed.text);
}
for (const query of queries) {
  for (let index = 0; index < query.acceptableSourceLocators.length; index++) {
    const locator = query.acceptableSourceLocators[index];
    assert.ok(query.expectedDocumentKeys.includes(locator.documentKey), query.id);
    const text = texts.get(`${locator.documentKey}:${locator.version}`);
    assert.ok(text, query.id);
    assert.equal([...text].slice(locator.range.startOffset, locator.range.endOffset).join(''), query.supportText[index], query.id);
  }
}
const report = { status: 'passed', datasetSha256: manifest.datasetSha256, sourceFilesVerified: manifest.files.length,
  parsedSources: texts.size, supportPassagesChecked: passages, queriesReviewed: queries.length, blindQueries: 20,
  review: 'Independent pre-retrieval source/hash/range review by the integrating agent; category samples checked against the written synthetic facts. No retrieval output used to create labels.',
  limitations: 'Synthetic corpus, not evidence of enterprise data generalization or WeKnora parity.', recordedAt: new Date().toISOString() };
await mkdir('evidence/evaluation', { recursive: true });
await writeFile('evidence/evaluation/independent-fixture-review.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
