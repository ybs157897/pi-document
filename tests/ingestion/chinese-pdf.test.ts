import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseSource } from '../../src/ingestion/parser.js';

test('Chinese CID-font PDF resolves bundled CMaps without fetching external font assets', async () => {
  const bytes = await readFile(new URL('../../fixtures/parsers/pdf/chinese.pdf', import.meta.url));
  const parsed = await parseSource(bytes, 'application/pdf', new AbortController().signal);
  assert.ok(parsed.text.includes('中文向量检索与持久任务恢复'), parsed.text);
  assert.ok(parsed.text.includes('PDF-CN-2026-01'), parsed.text);
  assert.ok(parsed.text.includes('重启后原始文档与来源页码必须保持一致。'), parsed.text);
  assert.equal(parsed.spans.length, 1);
  assert.equal(parsed.spans[0]?.locator.kind, 'pdf_page');
  assert.equal(parsed.spans[0]?.endOffset, [...parsed.text].length);
});
