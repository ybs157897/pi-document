import { resolve } from 'node:path';
import type { EmbeddingProfile } from '../retrieval/embedding.js';
import { readFileSync } from 'node:fs';
import { validateModelProfile, type ModelProfile } from './model.js';
import type { FaultHook } from '../observability/faults.js';

export type ServiceConfig = {
  host: string; port: number; publicBaseUrl?: string;
  databaseUrl: string; piStoragePath: string; blobRoot: string;
  bootstrap?: { tenantId: string; principalId: string; token: string };
  embedding?: EmbeddingProfile;
  agent?: { profile: ModelProfile; apiKey: string };
  agentLimits?: { modelRequests: number; toolCalls: number; turnTimeoutMs: number; concurrentTurns: number };
  taskMaxDurationMs?: number;
  fault?: FaultHook;
  logEvents?: boolean;
};

export function serviceConfig(env: NodeJS.ProcessEnv = process.env): ServiceConfig {
  const bounded = (name: string, maximum: number, defaultValue = maximum) => {
    const value = Number(env[name] ?? defaultValue);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}; expected 1..${maximum}`);
    return value;
  };
  const port = Number(env.PORT ?? 4328);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required; use npm run dev for an isolated local database');
  const host = env.HOST ?? '127.0.0.1';
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('This local development service must bind a loopback address');
  if (env.PUBLIC_BASE_URL) {
    const url = new URL(env.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid PUBLIC_BASE_URL');
  }
  let embedding: EmbeddingProfile | undefined;
  if (env.EMBEDDING_MODEL_ID) {
    const apiKey = env[env.EMBEDDING_API_KEY_ENV ?? 'PI_DOCUMENT_EMBEDDING_API_KEY'];
    if (!apiKey || !env.EMBEDDING_BASE_URL || !env.EMBEDDING_DIMENSIONS) throw new Error('Embedding profile is incomplete');
    embedding = { apiKey, baseUrl: env.EMBEDDING_BASE_URL, modelId: env.EMBEDDING_MODEL_ID, dimensions: Number(env.EMBEDDING_DIMENSIONS), version: env.EMBEDDING_PROFILE_VERSION ?? '1', normalization: 'l2' };
  }
  let agent: ServiceConfig['agent'];
  if (env.AGENT_MODEL_PROFILE) {
    const profile = validateModelProfile(JSON.parse(readFileSync(resolve(env.AGENT_MODEL_PROFILE), 'utf8')));
    const apiKey = env[profile.credentialsEnv];
    if (!apiKey) throw new Error(`Model credential is missing: ${profile.credentialsEnv}`);
    agent = { profile, apiKey };
  }
  return {
    host, port, publicBaseUrl: env.PUBLIC_BASE_URL,
    logEvents: env.LOG_LEVEL !== 'silent',
    taskMaxDurationMs: bounded('TASK_MAX_DURATION_MS', 15 * 60_000),
    databaseUrl: env.DATABASE_URL,
    piStoragePath: resolve(env.PI_STORAGE_PATH ?? 'data/service/pi.sqlite'),
    blobRoot: resolve(env.BLOB_ROOT ?? 'data/service/blobs'),
    ...(embedding ? { embedding } : {}),
    ...(agent ? { agent } : {}),
    ...(agent ? { agentLimits: {
      modelRequests: bounded('NATURAL_MAX_MODEL_REQUESTS', 8),
      toolCalls: bounded('NATURAL_MAX_TOOL_CALLS', 20),
      turnTimeoutMs: bounded('NATURAL_TURN_TIMEOUT_MS', 120_000),
      concurrentTurns: bounded('NATURAL_MAX_CONCURRENT_TURNS', 16, 8),
    } } : {}),
    ...(env.AUTH_BOOTSTRAP_TOKEN ? { bootstrap: { tenantId: env.AUTH_TENANT_ID ?? 'local', principalId: env.AUTH_PRINCIPAL_ID ?? 'local-agent', token: env.AUTH_BOOTSTRAP_TOKEN } } : {}),
  };
}
