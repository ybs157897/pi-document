import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startApp } from '../src/app.js';
import { serviceConfig } from '../src/config/service.js';
import { LocalPostgres } from './support/local-postgres.js';
import { parseSource } from '../src/ingestion/parser.js';

// Synthetic size fixtures isolate indexing cost; they do not estimate real document quality.
function markdown(sample: number) {
  let text = '';
  for (let index = 0; Buffer.byteLength(text) < 512_000; index++) {
    text += `Index sample ${sample}, section ${index % 128}. A document version becomes searchable only after all chunks and vectors are durable. Retry reuses the request receipt; deletion hides old references immediately.\n\n`;
  }
  return Buffer.from(text).subarray(0, 512_000);
}

function tenPagePdf(sample: number) {
  const objects: string[] = [];
  const add = (value: string) => { objects.push(value); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pages: number[] = [];
  for (let page = 1; page <= 10; page++) {
    const lines = [`Index sample ${sample}, PDF page ${page}.`, ...Array.from({ length: 45 }, (_, line) =>
      `Line ${line + 1}: Durable receipts preserve versions and source locations after restart.`)];
    const content = `BT /F1 10 Tf 40 800 Td 15 TL\n${lines.map((line, index) => `${index ? 'T* ' : ''}(${line}) Tj`).join('\n')}\nET`;
    const streamId = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    pages.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`));
  }
  objects[1] = `<< /Type /Pages /Count 10 /Kids [${pages.map(id => `${id} 0 R`).join(' ')}] >>`;
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${offset.toString().padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

const directory = await mkdtemp(join(tmpdir(), 'pi-document-index-load-'));
const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
const address = probe.address(); assert.ok(address && typeof address !== 'string');
await new Promise<void>(resolve => probe.close(() => resolve()));
const postgres = new LocalPostgres({ dataDir: join(directory, 'pg'), port: address.port, password: randomBytes(24).toString('hex') });
const token = randomBytes(24).toString('hex');
let app: Awaited<ReturnType<typeof startApp>> | undefined;
const samples: Record<string, unknown>[] = [];
const report: Record<string, unknown> = { status: 'running', startedAt: new Date().toISOString(), modelId: process.env.EMBEDDING_MODEL_ID, samples,
  limitation: 'Five samples per format, p95 is the maximum of this small set. Synthetic 500 KiB Markdown repeats 128 paragraphs; the embedding cache can reuse repeats within a document. PDF has ten pages of 46 text lines. These are size regressions, not representative production throughput.' };
const baseFetch = globalThis.fetch;
const providerOrigin = new URL(process.env.EMBEDDING_BASE_URL!).origin;
let requests = 0, tokens = 0;
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.origin !== providerOrigin || !url.pathname.endsWith('/embeddings')) return baseFetch(input, init);
  assert.ok(++requests <= 300, 'INDEXING_PROVIDER_BUDGET_EXCEEDED');
  const response = await baseFetch(input, init);
  const payload = await response.clone().json().catch(() => ({})) as any;
  tokens += payload.usage?.total_tokens ?? payload.usage?.prompt_tokens ?? 0;
  return response;
};
async function call(operation: string, input: unknown, knowledgeBaseId?: string) {
  const response = await fetch(app!.baseUrl + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'SendMessage', params: { message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ data: { schemaVersion: '1.0', operation, requestId: randomUUID(), ...(knowledgeBaseId ? { knowledgeBaseId } : {}), input }, mediaType: 'application/json' }] }, configuration: { returnImmediately: false } } }), signal: AbortSignal.timeout(180_000) });
  const envelope = await response.json() as any;
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  assert.equal(envelope.result.task.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(envelope.result.task.artifacts));
  return envelope.result.task.artifacts[0].parts[0].data.result;
}
try {
  await postgres.start();
  app = await startApp(serviceConfig({ ...process.env, DATABASE_URL: postgres.url, PORT: '0', AUTH_BOOTSTRAP_TOKEN: token,
    PI_STORAGE_PATH: join(directory, 'pi.sqlite'), BLOB_ROOT: join(directory, 'blobs'), AGENT_MODEL_PROFILE: undefined, LOG_LEVEL: 'silent' }));
  const { knowledgeBaseId } = await call('knowledge_base.create', { name: 'Indexing latency size fixtures' });
  for (const format of ['markdown', 'pdf'] as const) {
    const times: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const bytes = format === 'markdown' ? markdown(sample) : tenPagePdf(sample);
      const mimeType = format === 'markdown' ? 'text/markdown' : 'application/pdf';
      if (format === 'pdf') assert.equal((await parseSource(bytes, mimeType)).spans.length, 10);
      const form = new FormData(); form.set('file', new Blob([new Uint8Array(bytes)], { type: mimeType }), `fixture.${format === 'pdf' ? 'pdf' : 'md'}`);
      const upload: Response = await fetch(app.baseUrl + `/v1/uploads?knowledgeBaseId=${knowledgeBaseId}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
      assert.equal(upload.status, 201);
      const { uploadId } = await upload.json() as any;
      const beforeRequests = requests, beforeTokens = tokens;
      const started = performance.now();
      const result = await call('document.save', { title: `${format}-${sample}`, source: { kind: 'upload', uploadId }, waitFor: 'indexed' }, knowledgeBaseId);
      const elapsedMs = performance.now() - started;
      assert.equal(result.indexState, 'ready'); assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
      const count = await app.pool.query('SELECT count(*)::int AS count FROM pd_indexed_chunks WHERE document_id=$1', [result.documentId]);
      assert.ok(count.rows[0].count > 0);
      times.push(elapsedMs); samples.push({ format, sample, byteSize: bytes.length, pages: format === 'pdf' ? 10 : null, chunks: count.rows[0].count, elapsedMs, providerRequests: requests - beforeRequests, providerTokens: tokens - beforeTokens });
    }
    report[format] = { samples: times.length, p95Ms: Math.max(...times), targetMs: 60_000 };
    assert.ok(Math.max(...times) <= 60_000, `${format} exceeded indexing p95 target`);
  }
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  globalThis.fetch = baseFetch;
  report.provider = { requests, reportedTokens: tokens, maxRequests: 300 }; report.completedAt = new Date().toISOString();
  await app?.close(); await postgres.stop(); await rm(directory, { recursive: true, force: true });
  await mkdir('evidence/performance', { recursive: true });
  await writeFile('evidence/performance/indexing.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
