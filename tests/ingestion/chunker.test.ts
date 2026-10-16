import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chunkDocument, CHUNK_MAX_UTF8_BYTES, CHUNK_OVERLAP_UTF8_BYTES, CHUNK_TOKEN_BUDGET_STRATEGY } from '../../src/ingestion/chunker.js';
import { parseSource } from '../../src/ingestion/parser.js';
import { tokenize } from '../../src/retrieval/lexical.js';

const fixtureRoot = fileURLToPath(new URL('../../fixtures/parsers/', import.meta.url));
const fixture = (format: string, name: string) => `${fixtureRoot}/${format}/${name}.${format}`;
const points = (text: string) => Array.from(text);

test('chunk byte budget, overlap, offsets, and text coverage use Unicode code points', async () => {
  const source = `标题 😀 ${'a'.repeat(900)} 中文结束。`;
  const parsed = await parseSource(Buffer.from(source), 'text/plain');
  const chunks = chunkDocument(parsed);
  assert.ok(chunks.length > 1);
  assert.equal(CHUNK_MAX_UTF8_BYTES, 768);
  assert.equal(CHUNK_OVERLAP_UTF8_BYTES, 64);
  assert.match(CHUNK_TOKEN_BUDGET_STRATEGY, /not an exact Qwen token count/i);
  assert.deepEqual(chunks.map(chunk => chunk.ordinal), chunks.map((_, index) => index));

  const original = points(parsed.text);
  const covered = new Set<number>();
  chunks.forEach((chunk, index) => {
    assert.ok(Buffer.byteLength(chunk.text, 'utf8') <= CHUNK_MAX_UTF8_BYTES);
    assert.ok(chunk.lexicalTokens.length <= Buffer.byteLength(chunk.text, 'utf8'), 'word-like tokens cannot exceed the UTF-8 byte budget');
    assert.equal(points(chunk.text).join(''), original.slice(chunk.startOffset, chunk.endOffset).join(''));
    assert.deepEqual(chunk.lexicalTokens, tokenize(chunk.text));
    for (let point = chunk.startOffset; point < chunk.endOffset; point += 1) covered.add(point);
    if (index > 0) {
      assert.ok(chunk.startOffset < chunks[index - 1]!.endOffset, 'adjacent chunks should overlap within one source span');
      assert.ok(Buffer.byteLength(points(parsed.text).slice(chunk.startOffset, chunks[index - 1]!.endOffset).join(''), 'utf8') <= CHUNK_OVERLAP_UTF8_BYTES);
    }
    assert.equal(chunk.locator.kind, 'text_span');
    if (chunk.locator.kind === 'text_span') {
      assert.equal(chunk.locator.startOffset, chunk.startOffset);
      assert.equal(chunk.locator.endOffset, chunk.endOffset);
    }
  });
  assert.equal(covered.size, original.length, 'all original code points must appear in at least one chunk');
});

test('chunks retain Markdown heading paths and do not cross source spans', async () => {
  const markdown = await parseSource(await readFile(fixture('md', 'normal')), 'text/markdown');
  const markdownChunks = chunkDocument(markdown);
  const headingChunk = markdownChunks.find(chunk => chunk.text.includes('支持中文'));
  assert.deepEqual(headingChunk?.headingPath, ['实施方案 😀', '输入约束']);

  const html = await parseSource(await readFile(fixture('html', 'normal')), 'text/html');
  const htmlChunks = chunkDocument(html);
  assert.equal(htmlChunks.length, html.spans.length);
  for (let index = 0; index < htmlChunks.length; index += 1) {
    assert.equal(htmlChunks[index]!.locator.kind, 'html_section');
    assert.deepEqual(htmlChunks[index]!.locator, html.spans[index]!.locator);
  }
});

test('PDF page and DOCX paragraph locators survive splitting with global source ranges', async () => {
  const pdf = await parseSource(await readFile(fixture('pdf', 'normal')), 'application/pdf');
  const pdfChunks = chunkDocument(pdf);
  assert.deepEqual(pdfChunks.map(chunk => chunk.locator.kind === 'pdf_page' ? chunk.locator.page : 0), [1, 2]);
  assert.ok(pdfChunks.every(chunk => chunk.endOffset <= points(pdf.text).length));

  const docx = await parseSource(await readFile(fixture('docx', 'over-limit')), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const docxChunks = chunkDocument(docx);
  assert.ok(docxChunks.length > 1);
  assert.ok(docxChunks.every(chunk => chunk.locator.kind === 'docx_paragraph' && chunk.locator.paragraphIndex === 0));
  for (const chunk of docxChunks) {
    assert.equal(points(docx.text).slice(chunk.startOffset, chunk.endOffset).join(''), chunk.text);
  }
});
