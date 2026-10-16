import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
require('ajv-formats')(ajv);
const request = ajv.compile(JSON.parse(await readFile('contracts/document-request.schema.json', 'utf8')));
const result = ajv.compile(JSON.parse(await readFile('contracts/document-result.schema.json', 'utf8')));
const sample = JSON.parse(await readFile('contracts/examples/payload-save-text.json', 'utf8'));

test('all business payload fixtures match the published contract', async () => {
  let count = 0;
  for (const name of await readdir('contracts/examples')) {
    const value = JSON.parse(await readFile(`contracts/examples/${name}`, 'utf8'));
    const payloads = name.startsWith('payload-') ? [value] : [
      ...(value.params?.message?.parts ?? []).flatMap((part: { data?: unknown }) => part.data ? [part.data] : []),
      ...(value.result?.task?.artifacts ?? value.result?.artifacts ?? []).flatMap((artifact: { parts: { data?: unknown }[] }) =>
        artifact.parts.flatMap(part => part.data ? [part.data] : [])),
    ];
    for (const payload of payloads) {
      const validate = payload.outcome ? result : request;
      assert.equal(validate(payload), true, `${name}: ${ajv.errorsText(validate.errors)}`);
      count++;
    }
  }
  assert.ok(count >= 10, `expected at least 10 payload fixtures, got ${count}`);
});

test('rejects forged identity, oversized topK, missing receipt and unsupported source', () => {
  assert.equal(request({ ...sample, tenantId: 'victim' }), false);
  const { requestId: _, ...withoutReceipt } = sample;
  assert.equal(request(withoutReceipt), false);
  assert.equal(request({ ...sample, input: { ...sample.input, source: { kind: 'url', url: 'file:///etc/passwd' } } }), false);
  assert.equal(request({ schemaVersion: '1.0', operation: 'document.search', requestId: 'query', knowledgeBaseId: 'kb', input: { query: '编号', topK: 51 } }), false);
});

test('stored result requires a public ingestion task; indexed result requires ready', () => {
  const data = { schemaVersion: '1.0', operation: 'document.save', requestId: 'save', outcome: 'succeeded', result: {
    documentId: 'document', version: 1, indexState: 'stored', sha256: 'a'.repeat(64),
  } };
  assert.equal(result(data), false);
  assert.equal(result({ ...data, result: { ...data.result, ingestionTaskId: 'public-a2a-task' } }), true);
  for (const indexState of ['failed', 'canceled', 'parsing', 'embedding', 'indexing']) {
    assert.equal(result({ ...data, result: { ...data.result, indexState, ingestionTaskId: 'public-a2a-task' } }), false);
  }
  assert.equal(result({ ...data, result: { ...data.result, indexState: 'ready' } }), false);
  assert.equal(result({ ...data, result: { ...data.result, indexState: 'ready', generationId: 'generation' } }), true);
});

test('document preview pages allow a useful bounded code-point window without changing list limits', () => {
  const get = { schemaVersion: '1.0', operation: 'document.get', requestId: 'preview', knowledgeBaseId: 'kb', input: { documentId: 'doc', limit: 8192 } };
  assert.equal(request(get), true);
  assert.equal(request({ ...get, input: { documentId: 'doc', limit: 16385 } }), false);
  assert.equal(request({ ...get, operation: 'document.list', input: { limit: 101 } }), false);
});
