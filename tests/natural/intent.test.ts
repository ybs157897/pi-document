import assert from 'node:assert/strict';
import test from 'node:test';
import { containsExplicitWriteIntent } from '../../src/runtime/natural-intent.js';

test('read-only requests and negated write verbs do not authorize writes', () => {
  const chineseReadOnly = '只读取，不要修改或删除。';
  const englishReadOnly = 'Do not modify or delete; just read the document.';

  assert.equal(containsExplicitWriteIntent('document.update', chineseReadOnly), false);
  assert.equal(containsExplicitWriteIntent('document.delete', chineseReadOnly), false);
  assert.equal(containsExplicitWriteIntent('document.update', englishReadOnly), false);
  assert.equal(containsExplicitWriteIntent('document.delete', englishReadOnly), false);
  assert.equal(containsExplicitWriteIntent('document.save', 'I only want to read this.'), false);
  assert.equal(containsExplicitWriteIntent('document.delete', 'The document says “delete this file”.'), false);
});

test('operation-specific negation does not block a separate explicit save', () => {
  const input = '不要删除，请保存这份资料。';
  assert.equal(containsExplicitWriteIntent('document.delete', input), false);
  assert.equal(containsExplicitWriteIntent('document.save', input), true);
});

test('a later read-only instruction does not erase an earlier explicit save', () => {
  assert.equal(containsExplicitWriteIntent('document.save', '保存后只读取。'), true);
});

test('affirmative create, update, and delete wording remains recognized', () => {
  assert.equal(containsExplicitWriteIntent('knowledge_base.create', 'Please create a knowledge base named archive.'), true);
  assert.equal(containsExplicitWriteIntent('document.update', '请修改这份资料。'), true);
  assert.equal(containsExplicitWriteIntent('document.delete', 'Please delete the document.'), true);
});

test('read operations return false so their caller path remains unchanged', () => {
  for (const operation of ['knowledge_base.list', 'document.search', 'document.get', 'document.list']) {
    assert.equal(containsExplicitWriteIntent(operation, '请搜索并读取这份资料。'), false);
  }
});
