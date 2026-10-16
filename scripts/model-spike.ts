import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import { Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { createProfileModels, loadModelProfile } from '../src/config/model.js';
import { openOwnedStorage } from '../src/runtime/owned-storage.js';

const profile = await loadModelProfile(process.env.AGENT_MODEL_PROFILE ?? 'config/model.example.json');
const report: Record<string, unknown> = {
  phase: 'M0', provider: profile.provider, modelId: profile.modelId, baseUrl: profile.baseUrl,
  modelProfileSha256: createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
  maxModelRequests: 1, maxOutputTokens: profile.maxOutputTokens, timeoutMs: profile.timeoutMs,
  costStatus: 'pricing_not_verified',
  limitation: 'One real Pi tool call probe; not the AC-20 complete document service workflow.',
};
await mkdir('evidence/m0', { recursive: true });
const key = process.env[profile.credentialsEnv];
if (!key) {
  report.status = 'blocked'; report.reason = `Missing environment variable ${profile.credentialsEnv}`;
  await writeFile('evidence/m0/model.json', JSON.stringify(report, null, 2) + '\n');
  console.error(report.reason); process.exitCode = 2;
} else {
  const directory = resolve(`data/m0-model/${Date.now()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const receipt = new DatabaseSync(`${directory}/receipt.sqlite`);
  receipt.exec('CREATE TABLE receipts (operation_key TEXT PRIMARY KEY, text TEXT NOT NULL)');
  const models = createProfileModels(profile, key);
  const stream = models.streamSimple.bind(models);
  let requests = 0;
  models.streamSimple = (model, input, options) => {
    if (++requests > 1) throw new Error('MODEL_REQUEST_BUDGET_EXCEEDED');
    return stream(model, input, { ...options, maxTokens: profile.maxOutputTokens, timeoutMs: profile.timeoutMs, maxRetries: 0 });
  };
  const trace: unknown[] = [];
  const probe = defineTool({
    name: 'probe_store', description: 'Persist one test document into a durable receipt store.', replay: 'safe',
    parameters: Type.Object({ text: Type.String({ minLength: 1, maxLength: 256 }) }),
    execute: async ({ text }, api) => {
      const operationKey = createHash('sha256').update(`m0-fixture:${text}`).digest('hex');
      receipt.prepare('INSERT OR IGNORE INTO receipts VALUES (?, ?)').run(operationKey, text);
      trace.push({ name: 'probe_store', taskId: api.taskId, operationKey, storedText: text });
      return { output: [{ type: 'text', text: 'Persisted.' }], control: { terminate: true } };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'm0-model-probe', tools: [probe] }));
  const storage = await openOwnedStorage(`${directory}/pi.sqlite`);
  const harness = await Harness.open(storage, {
    models, registry,
    settings: { retry: { enabled: false, maxRetries: 0 }, stream: { timeoutMs: profile.timeoutMs, maxRetries: 0 } },
  }, context);
  try {
    const conversation = await harness.root(context, { agent: {
      model: { provider: profile.provider, modelId: profile.modelId }, thinkingLevel: 'off', tools: [probe],
      instructions: 'Use probe_store to save the exact requested test document. Call it once. No other actions.',
    } });
    const submission = await conversation.submit({ type: 'input', content: '请调用 probe_store 保存这段原文：M0 编号 PI-2026-001，重启后资料仍可读取。', requestId: 'm0-live-tool' }, context);
    const settled = await submission.wait(withAbortSignal(AbortSignal.timeout(profile.timeoutMs + 5000), context));
    assert.equal(trace.length, 1, 'real model must call the tool exactly once');
    assert.equal(requests, 1);
    assert.equal(settled.status, 'done');
    const rows = receipt.prepare('SELECT operation_key, text FROM receipts').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.text, 'M0 编号 PI-2026-001，重启后资料仍可读取。');
    report.status = 'passed'; report.requests = requests; report.toolTrace = trace;
    report.submissionId = submission.id; report.submissionStatus = settled.status;
    report.receiptCount = rows.length;
    const usage = await harness.usage(context);
    report.usage = { models: Object.fromEntries(Object.entries(usage.models).map(([model, { cost: _, ...tokens }]) => [model, tokens])), tools: usage.tools };
    report.storageDirectory = directory.replace(process.cwd() + '/', '');
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.message.replaceAll(key, '[redacted]') : 'Model probe failed';
    process.exitCode = 1;
  } finally {
    try { await harness.close(context); } finally { receipt.close(); }
    await writeFile('evidence/m0/model.json', JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ status: report.status, modelId: profile.modelId, requests, evidence: 'evidence/m0/model.json' }));
  }
}
