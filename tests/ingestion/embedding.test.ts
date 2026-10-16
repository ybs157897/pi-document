import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import test from 'node:test';
import {
  createEmbeddingClient,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_ATTEMPTS,
  EMBEDDING_REQUEST_TIMEOUT_MS,
  EMBEDDING_TOTAL_BUDGET_MS,
  EmbeddingError,
  type EmbeddingProfile,
} from '../../src/retrieval/embedding.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function startServer(handler: Handler): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

function profile(baseUrl: string): EmbeddingProfile {
  return {
    baseUrl,
    modelId: 'qwen3.7-text-embedding-flash',
    dimensions: 1024,
    apiKey: 'test-secret-value',
    version: 'profile-v1',
    normalization: 'l2',
  };
}

function readRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); }
      catch (error) { reject(error); }
    });
    request.on('error', reject);
  });
}

function vector(index: number): number[] {
  const value = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  value[index] = index === 0 ? 2 : 3;
  return value;
}

test('OpenAI-compatible embeddings validate indexes and normalize aligned 1024D vectors', async () => {
  const { server, baseUrl } = await startServer(async (request, response) => {
    const payload = await readRequest(request);
    assert.equal(request.url, '/v1/embeddings');
    assert.equal(request.headers.authorization, 'Bearer test-secret-value');
    assert.equal(payload.model, 'qwen3.7-text-embedding-flash');
    assert.equal(payload.dimensions, 1024);
    assert.deepEqual(payload.input, ['first', 'second']);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ index: 1, embedding: vector(1) }, { index: 0, embedding: vector(0) }] }));
  });
  try {
    const vectors = await createEmbeddingClient(profile(baseUrl)).embed(['first', 'second']);
    assert.equal(vectors.length, 2);
    assert.equal(vectors[0]!.length, 1024);
    assert.ok(Math.abs(vectors[0]![0]! - 1) < 1e-12);
    assert.ok(Math.abs(vectors[1]![1]! - 1) < 1e-12);
    assert.ok(vectors.every(item => Math.abs(Math.hypot(...item) - 1) < 1e-12));
  } finally {
    await closeServer(server);
  }
});

test('embedding retries only 429/5xx and stops after five attempts', async () => {
  let attempts = 0;
  const { server, baseUrl } = await startServer(async (request, response) => {
    await readRequest(request);
    attempts += 1;
    if (attempts < 3) {
      response.writeHead(attempts === 1 ? 429 : 503, { 'Retry-After': '0', 'Content-Type': 'application/json' });
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ index: 0, embedding: vector(0) }] }));
  });
  try {
    const result = await createEmbeddingClient(profile(baseUrl)).embed(['retry']);
    assert.equal(result.length, 1);
    assert.equal(attempts, 3);
  } finally {
    await closeServer(server);
  }

  let failures = 0;
  const failing = await startServer(async (request, response) => {
    await readRequest(request);
    failures += 1;
    response.writeHead(503, { 'Retry-After': '0', 'Content-Type': 'application/json' });
    response.end('{}');
  });
  try {
    await assert.rejects(createEmbeddingClient(profile(failing.baseUrl)).embed(['retry']), (error: unknown) => error instanceof EmbeddingError && error.code === 'EMBEDDING_RETRY_EXHAUSTED');
    assert.equal(failures, EMBEDDING_MAX_ATTEMPTS);
  } finally {
    await closeServer(failing.server);
  }
});

test('embedding retries transient network failures', async () => {
  let attempts = 0;
  const { server, baseUrl } = await startServer(async (request, response) => {
    await readRequest(request);
    attempts += 1;
    if (attempts < 3) {
      response.destroy();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ index: 0, embedding: vector(0) }] }));
  });
  try {
    const result = await createEmbeddingClient(profile(baseUrl)).embed(['network-retry']);
    assert.equal(result.length, 1);
    assert.equal(attempts, 3);
  } finally {
    await closeServer(server);
  }
});

test('authentication and malformed vector responses fail without retry or secret disclosure', async () => {
  let authAttempts = 0;
  const auth = await startServer(async (request, response) => {
    await readRequest(request);
    authAttempts += 1;
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end('{"error":"test-secret-value"}');
  });
  try {
    await assert.rejects(createEmbeddingClient(profile(auth.baseUrl)).embed(['secret']), (error: unknown) => {
      assert.ok(error instanceof EmbeddingError);
      assert.equal(error.code, 'EMBEDDING_AUTH_FAILED');
      assert.ok(!error.message.includes('test-secret-value'));
      return true;
    });
    assert.equal(authAttempts, 1);
  } finally {
    await closeServer(auth.server);
  }

  const malformed = await startServer(async (request, response) => {
    await readRequest(request);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ index: 0, embedding: Array.from({ length: 1023 }, () => 1) }] }));
  });
  try {
    await assert.rejects(createEmbeddingClient(profile(malformed.baseUrl)).embed(['bad-dimensions']), (error: unknown) => error instanceof EmbeddingError && error.code === 'EMBEDDING_RESPONSE_INVALID');
  } finally {
    await closeServer(malformed.server);
  }
});

test('embedding rejects count, index, non-finite, and zero-vector responses', async () => {
  const { server, baseUrl } = await startServer(async (request, response) => {
    const payload = await readRequest(request);
    const input = payload.input as string[];
    let data: Array<{ index: number; embedding: unknown }>;
    if (input[0] === 'count') data = [];
    else if (input[0] === 'duplicate') data = [{ index: 0, embedding: vector(0) }, { index: 0, embedding: vector(1) }];
    else if (input[0] === 'non-finite') data = [{ index: 0, embedding: [null, ...Array.from({ length: 1023 }, () => 1)] }];
    else data = [{ index: 0, embedding: Array.from({ length: 1024 }, () => 0) }];
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data }));
  });
  try {
    const client = createEmbeddingClient(profile(baseUrl));
    for (const value of ['count', 'duplicate', 'non-finite', 'zero']) {
      await assert.rejects(client.embed(value === 'duplicate' ? [value, value] : [value]), (error: unknown) => error instanceof EmbeddingError && error.code === 'EMBEDDING_RESPONSE_INVALID');
    }
  } finally {
    await closeServer(server);
  }
});

test('caller cancellation aborts an in-flight embedding request', async () => {
  const serverState = await startServer(async (request, response) => {
    await readRequest(request);
    await new Promise(resolve => setTimeout(resolve, 250));
    if (!response.destroyed) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ index: 0, embedding: vector(0) }] }));
    }
  });
  try {
    const controller = new AbortController();
    const embedding = createEmbeddingClient(profile(serverState.baseUrl)).embed(['cancel'], controller.signal);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(embedding, (error: unknown) => error instanceof EmbeddingError && error.code === 'EMBEDDING_ABORTED');
  } finally {
    await closeServer(serverState.server);
  }
});

test('profile enforces dimensions, version, normalization, and request budgets', () => {
  const baseUrl = 'https://embedding.example/v1';
  assert.throws(() => createEmbeddingClient({ ...profile(baseUrl), dimensions: 1536 }), /dimensions must be 1024/);
  assert.throws(() => createEmbeddingClient({ ...profile(baseUrl), normalization: 'none' as 'l2' }), /Only l2/);
  assert.throws(() => createEmbeddingClient({ ...profile(baseUrl), version: ' ' }), /version is required/);
  assert.equal(EMBEDDING_DIMENSIONS, 1024);
  assert.equal(EMBEDDING_REQUEST_TIMEOUT_MS, 30_000);
  assert.equal(EMBEDDING_TOTAL_BUDGET_MS, 600_000);
});
