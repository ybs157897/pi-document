import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { ParserError, parseSource } from '../../src/ingestion/parser.js';

const fixtureRoot = fileURLToPath(new URL('../../fixtures/parsers/', import.meta.url));
const codePoints = (text: string) => Array.from(text);
const fixture = (format: string, name: string) => `${fixtureRoot}/${format}/${name}.${format}`;

test('parseSource uses MIME types and preserves source spans for text formats', async () => {
  const txt = await parseSource(await readFile(fixture('txt', 'normal')), 'text/plain; charset=utf-8');
  assert.ok(txt.text.includes('标题与定位 😀'));
  assert.equal(txt.spans[0]?.locator.kind, 'text_span');
  assert.equal(txt.spans[0]?.startOffset, 0);
  assert.ok(txt.spans[0] && txt.spans[0].endOffset > txt.spans[0].startOffset);
  assert.notEqual(txt.text.length, codePoints(txt.text).length);

  const markdown = await parseSource(await readFile(fixture('md', 'normal')), 'text/markdown');
  const nestedParagraph = markdown.spans.find(span => span.locator.kind === 'text_span' && span.locator.startLine === 4);
  assert.deepEqual(nestedParagraph?.headingPath, ['实施方案 😀', '输入约束']);
  if (nestedParagraph?.locator.kind === 'text_span') assert.equal(nestedParagraph.locator.endLine, 4);

  const html = await parseSource(await readFile(fixture('html', 'normal')), 'text/html');
  assert.equal(html.spans.find(span => span.locator.kind === 'html_section' && span.locator.headingPath.length === 1)?.locator.kind, 'html_section');
  const htmlFragments = html.spans.flatMap(span => span.locator.kind === 'html_section' ? [span.locator.fragment] : []);
  assert.ok(htmlFragments.includes('overview'));
  assert.ok(htmlFragments.includes(''));
});

test('PDF and DOCX parse in worker processes with page-local and original paragraph locators', async () => {
  const pdf = await parseSource(await readFile(fixture('pdf', 'normal')), 'application/pdf');
  assert.deepEqual(pdf.spans.map(span => span.locator.kind === 'pdf_page' ? span.locator.page : 0), [1, 2]);
  const pages = pdf.text.split('\n\n').map(codePoints);
  for (const span of pdf.spans) {
    assert.ok(span.startOffset >= 0 && span.endOffset <= codePoints(pdf.text).length);
    assert.equal(span.locator.kind, 'pdf_page');
    if (span.locator.kind === 'pdf_page') {
      assert.ok(span.locator.endOffset <= pages[span.locator.page - 1]!.length);
      assert.ok(span.locator.endOffset > span.locator.startOffset);
    }
  }

  const docx = await parseSource(await readFile(fixture('docx', 'normal')), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const paragraphLocators = docx.spans.map(span => span.locator).filter(locator => locator.kind === 'docx_paragraph');
  assert.deepEqual(paragraphLocators.map(locator => locator.kind === 'docx_paragraph' ? locator.paragraphIndex : -1), [0, 2, 3, 4, 5]);
  assert.equal(paragraphLocators[0]?.kind === 'docx_paragraph' ? paragraphLocators[0].headingPath[0] : '', '实施要点 😀');
  const docxSourceSlices = docx.spans.map(span => codePoints(docx.text).slice(span.startOffset, span.endOffset).join(''));
  assert.deepEqual(docxSourceSlices.slice(1, 3), ['重复段落。', '重复段落。']);
});

test('empty, corrupt, unsupported, and over-limit sources fail with explicit codes', async () => {
  await assert.rejects(parseSource(await readFile(fixture('pdf', 'empty')), 'application/pdf'), (error: unknown) => error instanceof ParserError && error.code === 'EMPTY_PARSE');
  await assert.rejects(parseSource(await readFile(fixture('docx', 'corrupt')), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), (error: unknown) => error instanceof ParserError && error.code === 'CORRUPT_DOCUMENT');
  await assert.rejects(parseSource(Buffer.from('x'), 'application/octet-stream'), (error: unknown) => error instanceof ParserError && error.code === 'UNSUPPORTED_FORMAT');
  await assert.rejects(parseSource(Buffer.alloc(50 * 1024 * 1024 + 1), 'text/plain'), (error: unknown) => error instanceof ParserError && error.code === 'SIZE_LIMIT');
});

test('AbortSignal terminates a running heavy parser worker', async () => {
  const controller = new AbortController();
  const parsing = parseSource(await readFile(fixture('pdf', 'normal')), 'application/pdf', controller.signal);
  controller.abort();
  await assert.rejects(parsing, (error: unknown) => error instanceof ParserError && error.code === 'PARSER_ABORTED');
});
