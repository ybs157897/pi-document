import assert from 'node:assert/strict';
import test from 'node:test';
import { lexicalQuery, tokenize } from '../../src/retrieval/lexical.js';

test('compound identifiers remain exact conjunctions despite conversational filler', () => {
  assert.deepEqual(lexicalQuery('Please locate case ABC-123 for me', tokenize('Please locate case ABC-123 for me')), { text: "('abc' & '123')", syntax: 'tsquery' });
  assert.deepEqual(lexicalQuery('Compare XR-7 and XY-42', tokenize('Compare XR-7 and XY-42')), { text: "('xr' & '7') | ('xy' & '42')", syntax: 'tsquery' });
});

test('ordinary lexical terms preserve conjunction precision without accepting query operators', () => {
  assert.deepEqual(lexicalQuery('recovery policy', ['recovery', 'policy']), { text: 'recovery policy', syntax: 'plain' });
  const query = lexicalQuery('', ["word') | !'unsafe", '恢复', '恢复']);
  assert.equal(query.syntax, 'plain');
  assert.deepEqual(lexicalQuery('pressure 0.46 MPa', tokenize('pressure 0.46 MPa')), { text: 'pressure 0.46 mpa', syntax: 'plain' });
  assert.deepEqual(lexicalQuery('', []), { text: '', syntax: 'plain' });
});
