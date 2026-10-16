import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { startApp } from '../src/app.js';
import { serviceConfig } from '../src/config/service.js';
import { LocalPostgres } from './support/local-postgres.js';

const durationMs = Number(process.env.BENCHMARK_DURATION_MS ?? 600_000);
assert.ok(Number.isInteger(durationMs) && durationMs >= 10_000 && durationMs <= 600_000);
const concurrency = 5, chunksRequired = 10_000, wavePeriodMs = 1000, requestBudget = 3200;
const directory = await mkdtemp(join(tmpdir(), 'pi-document-load-'));
const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
const address = socket.address(); assert.ok(address && typeof address !== 'string');
await new Promise<void>(resolve => socket.close(() => resolve()));
const postgres = new LocalPostgres({ dataDir: join(directory, 'pg'), port: address.port, password: randomBytes(24).toString('hex') });
const token = randomBytes(24).toString('hex');
const baseFetch = globalThis.fetch;
const providerOrigin = new URL(process.env.EMBEDDING_BASE_URL!).origin;
let providerRequests = 0, providerTokens = 0;
const providerLatencies: number[] = [], keyword: number[] = [], hybrid: number[] = [];
let active = 0, peak = 0, measuredStartedAt = 0;
const report: Record<string, unknown> = { status: 'running', concurrency, durationMs, wavePeriodMs,
  dataset: '10,000 repeated public synthetic paragraphs; real cached embeddings. This is a load corpus, not a quality corpus.',
  maxProviderRequests: requestBudget, modelId: process.env.EMBEDDING_MODEL_ID, dimensions: Number(process.env.EMBEDDING_DIMENSIONS), costStatus: 'pricing_not_verified' };
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString());
  if (url.origin !== providerOrigin || !url.pathname.endsWith('/embeddings')) return baseFetch(input, init);
  if (providerRequests >= requestBudget) throw new Error('BENCHMARK_PROVIDER_BUDGET_EXCEEDED');
  providerRequests++;
  const started = performance.now();
  const response = await baseFetch(input, init);
  const usage = await response.clone().json().catch(() => ({})) as { usage?: { total_tokens?: number; prompt_tokens?: number } };
  providerTokens += usage.usage?.total_tokens ?? usage.usage?.prompt_tokens ?? 0;
  if (measuredStartedAt) providerLatencies.push(performance.now() - started);
  return response;
};
let app: Awaited<ReturnType<typeof startApp>> | undefined;
const percentile = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)] ?? null;
async function call(operation: string, input: unknown, knowledgeBaseId?: string, contextId?: string) {
  const response = await fetch(app!.baseUrl + '/a2a', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'SendMessage', params: { message: { messageId: randomUUID(), role: 'ROLE_USER', ...(contextId ? { contextId } : {}), parts: [{ mediaType: 'application/json', data: { schemaVersion: '1.0', operation, requestId: randomUUID(), ...(knowledgeBaseId ? { knowledgeBaseId } : {}), input } }] }, configuration: { returnImmediately: false, acceptedOutputModes: ['application/json'] } } }), signal: AbortSignal.timeout(180_000),
  });
  const envelope = await response.json() as any;
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error));
  const task = envelope.result.task;
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(task.artifacts));
  const result = task.artifacts[0].parts[0].data;
  assert.equal(result.outcome, 'succeeded'); return { task, result: result.result };
}
try {
  await postgres.start();
  const config = serviceConfig({ ...process.env, DATABASE_URL: postgres.url, PORT: '0', HOST: '127.0.0.1', AUTH_BOOTSTRAP_TOKEN: token, AUTH_TENANT_ID: 'load', AUTH_PRINCIPAL_ID: 'load-client', PI_STORAGE_PATH: join(directory, 'pi.sqlite'), BLOB_ROOT: join(directory, 'blobs'), LOG_LEVEL: 'silent', AGENT_MODEL_PROFILE: undefined });
  assert.ok(config.embedding);
  app = await startApp(config);
  const kb = await call('knowledge_base.create', { name: '10k-chunk load corpus' });
  const knowledgeBaseId = kb.result.knowledgeBaseId as string;
  const text = Array(chunksRequired).fill('基准资料 PERF-2026：任务恢复后复用收据，向量索引只发布完整代次。').join('\n\n');
  const upload = new FormData(); upload.set('file', new Blob([text], { type: 'text/markdown' }), 'load.md');
  const uploaded = await fetch(app.baseUrl + `/v1/uploads?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: upload });
  assert.equal(uploaded.status, 201, await uploaded.clone().text());
  const source = await uploaded.json() as { uploadId: string };
  const indexingStarted = performance.now();
  await call('document.save', { title: '10k chunks - repeated load fixture', source: { kind: 'upload', uploadId: source.uploadId }, waitFor: 'indexed' }, knowledgeBaseId);
  report.indexingMs = performance.now() - indexingStarted;
  const count = await app.pool.query('SELECT count(*)::int AS count FROM pd_indexed_chunks');
  assert.equal(count.rows[0].count, chunksRequired); report.chunks = count.rows[0].count;
  const contexts: string[] = [];
  for (let i = 0; i < concurrency; i++) {
    const warmed = await call('document.search', { query: 'PERF-2026 任务恢复收据', mode: 'hybrid', topK: 10, rerank: false }, knowledgeBaseId);
    contexts.push(warmed.task.contextId);
  }
  measuredStartedAt = Date.now();
  const deadline = measuredStartedAt + durationMs;
  await Promise.all(contexts.map(async contextId => {
    while (Date.now() < deadline) {
      const waveStarted = Date.now();
      for (const mode of ['keyword', 'hybrid'] as const) {
        const started = performance.now(); active++; peak = Math.max(peak, active);
        try {
          const searched = await call('document.search', { query: 'PERF-2026 任务恢复收据', mode, topK: 10, rerank: false }, knowledgeBaseId, contextId);
          assert.equal(searched.result.results.length, 10);
          (mode === 'keyword' ? keyword : hybrid).push(performance.now() - started);
        } finally { active--; }
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(deadline - Date.now(), wavePeriodMs - (Date.now() - waveStarted)))));
    }
  }));
  report.actualDurationMs = Date.now() - measuredStartedAt; report.peakConcurrentQueries = peak;
  report.keyword = { samples: keyword.length, p95Ms: percentile(keyword, 0.95), p50Ms: percentile(keyword, 0.5) };
  report.hybrid = { samples: hybrid.length, p95Ms: percentile(hybrid, 0.95), p50Ms: percentile(hybrid, 0.5) };
  report.provider = { requests: providerRequests, reportedTokens: providerTokens, samples: providerLatencies.length, p95Ms: percentile(providerLatencies, 0.95) };
  assert.equal(peak, concurrency);
  assert.ok(percentile(keyword, 0.95)! <= 2000); assert.ok(percentile(hybrid, 0.95)! <= 5000);
  report.status = durationMs >= 600_000 ? 'passed' : 'smoke_passed';
  report.limitation = 'Five synchronized clients, each issuing keyword+hybrid once per one-second wave. Does not claim peak saturation throughput. Rerank is disabled; provider latency is reported separately.';
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  globalThis.fetch = baseFetch;
  report.providerRequests = providerRequests; report.providerTokens = providerTokens;
  await app?.close(); await postgres.stop(); await rm(directory, { recursive: true, force: true });
  await mkdir('evidence/performance', { recursive: true });
  await writeFile(`evidence/performance/${durationMs >= 600_000 ? 'load-10min' : 'load-smoke'}.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
