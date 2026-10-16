#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const baseUrl = (process.env.PI_DOCUMENT_AGENT_URL ?? '').replace(/\/+$/, '');
const token = process.env.PI_DOCUMENT_AGENT_TOKEN;
const knowledgeBaseId = process.env.PI_DOCUMENT_KNOWLEDGE_BASE_ID;
const filePath = process.env.PI_DOCUMENT_UPLOAD_FILE;
if (!baseUrl || !token || !knowledgeBaseId || !filePath) {
  throw new Error('Set PI_DOCUMENT_AGENT_URL, PI_DOCUMENT_AGENT_TOKEN, PI_DOCUMENT_KNOWLEDGE_BASE_ID, and PI_DOCUMENT_UPLOAD_FILE');
}

const mimeTypes = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
]);
const filename = basename(filePath);
const mimeType = mimeTypes.get(extname(filename).toLowerCase());
if (!mimeType) throw new Error('Supported extensions are .txt, .md, .pdf, .docx, .html, and .htm');

const bytes = await readFile(filePath);
const form = new FormData();
form.set('file', new Blob([bytes], { type: mimeType }), filename);
const response = await fetch(`${baseUrl}/v1/uploads?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}` },
  body: form,
});
const body = await response.json();
if (!response.ok) throw new Error(`Upload failed with HTTP ${response.status}: ${JSON.stringify(body.error ?? body)}`);
console.log(JSON.stringify(body));
