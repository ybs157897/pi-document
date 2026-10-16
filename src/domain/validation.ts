import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { DomainError, type DocumentRequest } from './types.js';
const require = createRequire(import.meta.url);
const ajv = new Ajv2020({ strict: true, strictRequired: false, allErrors: true });
require('ajv-formats')(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL('../../contracts/document-request.schema.json', import.meta.url), 'utf8')));
export function parseRequest(value: unknown): DocumentRequest {
  if (!validate(value)) throw new DomainError('INVALID_REQUEST', ajv.errorsText(validate.errors), 400);
  const request = value as DocumentRequest;
  if ((request.operation === 'document.save' || request.operation === 'document.update') && request.input.source.kind === 'text'
    && Buffer.byteLength(request.input.source.text, 'utf8') > 262144) throw new DomainError('SIZE_LIMIT', 'Inline text exceeds 256 KiB', 413);
  return request;
}
