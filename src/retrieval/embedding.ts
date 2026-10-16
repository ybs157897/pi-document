export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;
export const EMBEDDING_TOTAL_BUDGET_MS = 10 * 60_000;
export const EMBEDDING_MAX_ATTEMPTS = 5;

export interface EmbeddingProfile {
  baseUrl: string;
  modelId: string;
  dimensions: number;
  apiKey: string;
  version: string;
  normalization: 'l2';
}

export class EmbeddingError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

interface EmbeddingResponse {
  data?: Array<{ index?: unknown; embedding?: unknown }>;
}

function validateProfile(profile: EmbeddingProfile): URL {
  if (!profile || typeof profile !== 'object') throw new EmbeddingError('EMBEDDING_PROFILE_INVALID', 'Embedding profile is required.');
  if (typeof profile.modelId !== 'string' || !profile.modelId.trim()) throw new EmbeddingError('EMBEDDING_PROFILE_INVALID', 'Embedding modelId is required.');
  if (profile.dimensions !== EMBEDDING_DIMENSIONS) throw new EmbeddingError('EMBEDDING_PROFILE_INVALID', `Embedding dimensions must be ${EMBEDDING_DIMENSIONS}.`);
  if (typeof profile.version !== 'string' || !profile.version.trim()) throw new EmbeddingError('EMBEDDING_PROFILE_INVALID', 'Embedding profile version is required.');
  if (profile.normalization !== 'l2') throw new EmbeddingError('EMBEDDING_PROFILE_INVALID', 'Only l2 embedding normalization is supported.');
  if (typeof profile.apiKey !== 'string' || !profile.apiKey.trim() || /[\r\n]/.test(profile.apiKey)) {
    throw new EmbeddingError('EMBEDDING_PROFILE_INVALID', 'A valid API key value is required.');
  }
  let base: URL;
  try {
    base = new URL(profile.baseUrl);
  } catch {
    throw new EmbeddingError('EMBEDDING_PROFILE_INVALID', 'Embedding baseUrl must be an absolute URL.');
  }
  const localHttp = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !localHttp) || base.username || base.password || base.search || base.hash) {
    throw new EmbeddingError('EMBEDDING_PROFILE_INVALID', 'Embedding baseUrl must use HTTPS and cannot contain credentials, query, or fragment.');
  }
  return base;
}

function embeddingEndpoint(base: URL): URL {
  const path = base.pathname.replace(/\/+$/g, '');
  base.pathname = `${path}/embeddings`;
  return base;
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function retryDelayMs(attempt: number, response?: Response): number {
  const retryAfter = response ? retryAfterMs(response) : undefined;
  if (retryAfter !== undefined) return retryAfter;
  const exponential = Math.min(250 * 2 ** (attempt - 1), 8_000);
  return exponential + Math.floor(Math.random() * Math.min(250, exponential));
}

function waitForRetry(milliseconds: number, signal: AbortSignal | undefined, deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new EmbeddingError('EMBEDDING_TIME_BUDGET_EXCEEDED', 'Embedding total time budget was exhausted.'));
  const delayMs = Math.min(milliseconds, remaining);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      if (Date.now() >= deadline) reject(new EmbeddingError('EMBEDDING_TIME_BUDGET_EXCEEDED', 'Embedding total time budget was exhausted.'));
      else resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new EmbeddingError('EMBEDDING_ABORTED', 'Embedding request was canceled.'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function normalizeResponse(payload: EmbeddingResponse, count: number, dimensions: number): number[][] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.data) || payload.data.length !== count) {
    throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID', `Expected ${count} vectors in embedding response.`);
  }
  const vectors: Array<number[] | undefined> = Array.from({ length: count });
  for (const item of payload.data) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID', 'Embedding response contains an invalid data item.');
    }
    const index = item.index;
    const embedding = item.embedding;
    if (!Number.isInteger(index) || (index as number) < 0 || (index as number) >= count || vectors[index as number]) {
      throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID', 'Embedding response contains a missing, duplicate, or invalid index.');
    }
    if (!Array.isArray(embedding) || embedding.length !== dimensions || !embedding.every((component) => typeof component === 'number' && Number.isFinite(component))) {
      throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID', `Embedding ${String(index)} must contain ${dimensions} finite components.`);
    }
    const vector = embedding as number[];
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm) || norm <= 0) throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID', `Embedding ${String(index)} has zero or invalid norm.`);
    vectors[index as number] = vector.map((component) => component / norm);
  }
  if (vectors.some((vector) => vector === undefined)) throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID', 'Embedding response indexes are incomplete.');
  return vectors as number[][];
}

export function createEmbeddingClient(profile: EmbeddingProfile) {
  const base = validateProfile(profile);
  const url = embeddingEndpoint(base);

  return {
    async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
      if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string')) {
        throw new EmbeddingError('EMBEDDING_INPUT_INVALID', 'Embedding input must be an array of strings.');
      }
      if (texts.length === 0) return [];
      if (signal?.aborted) throw new EmbeddingError('EMBEDDING_ABORTED', 'Embedding request was canceled.');
      const deadline = Date.now() + EMBEDDING_TOTAL_BUDGET_MS;
      let lastRetryableError = 'network error';

      for (let attempt = 1; attempt <= EMBEDDING_MAX_ATTEMPTS; attempt += 1) {
        if (signal?.aborted) throw new EmbeddingError('EMBEDDING_ABORTED', 'Embedding request was canceled.');
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new EmbeddingError('EMBEDDING_TIME_BUDGET_EXCEEDED', 'Embedding total time budget was exhausted.');
        const requestSignal = AbortSignal.timeout(Math.min(EMBEDDING_REQUEST_TIMEOUT_MS, remaining));
        const combinedSignal = signal ? AbortSignal.any([signal, requestSignal]) : requestSignal;
        let response: Response;
        try {
          response = await fetch(url, {
            method: 'POST',
            signal: combinedSignal,
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${profile.apiKey}` },
            body: JSON.stringify({ model: profile.modelId, input: texts, dimensions: profile.dimensions, encoding_format: 'float' }),
          });
        } catch {
          if (signal?.aborted) throw new EmbeddingError('EMBEDDING_ABORTED', 'Embedding request was canceled.');
          if (Date.now() >= deadline) throw new EmbeddingError('EMBEDDING_TIME_BUDGET_EXCEEDED', 'Embedding total time budget was exhausted.');
          lastRetryableError = 'network or request timeout';
          if (attempt === EMBEDDING_MAX_ATTEMPTS) break;
          await waitForRetry(retryDelayMs(attempt), signal, deadline);
          continue;
        }

        if (!response.ok) {
          const status = response.status;
          await response.body?.cancel().catch(() => undefined);
          if (status === 401 || status === 403) throw new EmbeddingError('EMBEDDING_AUTH_FAILED', `Embedding service rejected authentication (${status}).`, status);
          if (status !== 429 && status < 500) throw new EmbeddingError('EMBEDDING_HTTP_ERROR', `Embedding service returned HTTP ${status}.`, status);
          lastRetryableError = `HTTP ${status}`;
          if (attempt === EMBEDDING_MAX_ATTEMPTS) break;
          await waitForRetry(retryDelayMs(attempt, response), signal, deadline);
          continue;
        }

        if (Date.now() >= deadline) {
          await response.body?.cancel().catch(() => undefined);
          throw new EmbeddingError('EMBEDDING_TIME_BUDGET_EXCEEDED', 'Embedding total time budget was exhausted.');
        }

        let payload: EmbeddingResponse;
        try {
          payload = await response.json() as EmbeddingResponse;
        } catch (error) {
          if (signal?.aborted) throw new EmbeddingError('EMBEDDING_ABORTED', 'Embedding request was canceled.');
          if (Date.now() >= deadline) throw new EmbeddingError('EMBEDDING_TIME_BUDGET_EXCEEDED', 'Embedding total time budget was exhausted.');
          if (requestSignal.aborted || error instanceof TypeError) {
            lastRetryableError = 'network or response timeout';
            if (attempt === EMBEDDING_MAX_ATTEMPTS) break;
            await waitForRetry(retryDelayMs(attempt), signal, deadline);
            continue;
          }
          throw new EmbeddingError('EMBEDDING_RESPONSE_INVALID', 'Embedding service returned invalid JSON.');
        }
        return normalizeResponse(payload, texts.length, profile.dimensions);
      }

      throw new EmbeddingError('EMBEDDING_RETRY_EXHAUSTED', `Embedding request failed after ${EMBEDDING_MAX_ATTEMPTS} attempts (${lastRetryableError}).`);
    },
  };
}
