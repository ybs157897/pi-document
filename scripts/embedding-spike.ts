import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

const fields = ['EMBEDDING_BASE_URL', 'EMBEDDING_MODEL_ID', 'EMBEDDING_API_KEY_ENV'] as const;
const missing: string[] = fields.filter(field => !process.env[field]?.trim());
const keyName = process.env.EMBEDDING_API_KEY_ENV;
const key = keyName ? process.env[keyName] : undefined;
if (keyName && !key) missing.push(keyName);
const report: Record<string, unknown> = { phase: 'M0', requestBudget: 1, rerank: 'not_configured', semanticQuality: 'not_evaluated', status: 'blocked' };
await mkdir('evidence/m0', { recursive: true });
if (missing.length) {
  report.reason = 'Embedding profile or credential is missing'; report.missing = missing;
  process.exitCode = 2;
} else {
  const baseUrl = new URL(process.env.EMBEDDING_BASE_URL!);
  const configuredDimensions = process.env.EMBEDDING_DIMENSIONS ? Number(process.env.EMBEDDING_DIMENSIONS) : undefined;
  try {
    assert.equal(baseUrl.protocol, 'https:', 'Embedding endpoint must use HTTPS');
    assert.ok(!baseUrl.username && !baseUrl.password && !baseUrl.search && !baseUrl.hash, 'Endpoint cannot contain credentials or query parameters');
    if (configuredDimensions !== undefined) assert.ok(Number.isInteger(configuredDimensions) && configuredDimensions >= 1 && configuredDimensions <= 16_000, 'Invalid embedding dimensions');
    const input = ['任务重启后继续处理资料。', '进程恢复后接续文档处理。', '苹果树在春天开花。'];
    const url = new URL(baseUrl.toString().replace(/\/?$/, '/') + 'embeddings');
    const response = await fetch(url, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: process.env.EMBEDDING_MODEL_ID, input, encoding_format: 'float', ...(configuredDimensions ? { dimensions: configuredDimensions } : {}) }),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`EMBEDDING_HTTP_${response.status}`); }
    const payload = await response.json() as { data?: { index: number; embedding: number[] }[]; usage?: unknown };
    assert.equal(payload.data?.length, input.length, 'Embedding response count mismatch');
    const dimensions = configuredDimensions ?? payload.data?.[0]?.embedding.length;
    assert.ok(dimensions && dimensions <= 16_000, 'Invalid returned dimensions');
    const seen = new Set<number>();
    const norms = payload.data!.map(item => {
      assert.ok(Number.isInteger(item.index) && item.index >= 0 && item.index < input.length && !seen.has(item.index), 'Invalid or duplicate embedding index');
      seen.add(item.index);
      assert.equal(item.embedding.length, dimensions, 'Embedding dimension mismatch');
      assert.ok(item.embedding.every(Number.isFinite), 'Embedding contains non-finite components');
      const norm = Math.hypot(...item.embedding);
      assert.ok(norm > 0, 'Zero embedding');
      return norm;
    });
    report.status = 'passed'; report.modelId = process.env.EMBEDDING_MODEL_ID;
    report.baseUrl = baseUrl.toString(); report.dimensions = dimensions; report.returnedVectors = input.length;
    report.dimensionsSource = configuredDimensions ? 'configured_and_verified' : 'provider_default_observed';
    report.inputSha256 = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    report.vectorNorms = norms; report.usage = payload.usage;
    report.limitation = 'Interface, dimensions and finite non-zero vectors only; not retrieval quality or pgvector integration.';
  } catch (error) {
    report.status = 'failed'; report.reason = (error instanceof Error ? error.message : 'Embedding probe failed').replaceAll(key!, '[redacted]');
    process.exitCode = 1;
  }
}
await writeFile('evidence/m0/embedding.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, reason: report.reason, missing: report.missing, evidence: 'evidence/m0/embedding.json' }));
