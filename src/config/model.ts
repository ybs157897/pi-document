import { readFile } from 'node:fs/promises';
import { createModels, createProvider } from '@earendil-works/pi-ai/models';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { Model } from '@earendil-works/pi-ai';

export type ModelProfile = {
  provider: 'qwen-maas';
  modelId: string;
  baseUrl: string;
  credentialsEnv: string;
  contextWindow: number;
  maxOutputTokens: number;
  timeoutMs: number;
};

export async function loadModelProfile(path: string): Promise<ModelProfile> {
  return validateModelProfile(JSON.parse(await readFile(path, 'utf8')));
}

export function validateModelProfile(value: unknown): ModelProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MODEL_PROFILE_INVALID');
  const profile = value as ModelProfile;
  if (profile.provider !== 'qwen-maas' || typeof profile.modelId !== 'string' || !profile.modelId.trim()
    || typeof profile.credentialsEnv !== 'string' || !/^[A-Z][A-Z0-9_]+$/.test(profile.credentialsEnv)) {
    throw new Error('MODEL_PROFILE_INVALID');
  }
  const endpoint = new URL(profile.baseUrl);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('MODEL_ENDPOINT_MUST_BE_HTTPS');
  }
  for (const [name, lower, upper] of [
    ['contextWindow', 1024, 1_000_000], ['maxOutputTokens', 128, 8192], ['timeoutMs', 1000, 120_000],
  ] as const) {
    if (!Number.isInteger(profile[name]) || profile[name] < lower || profile[name] > upper) throw new Error(`MODEL_PROFILE_INVALID_${name}`);
  }
  return profile;
}

export function createProfileModels(profile: ModelProfile, key: string) {
  const model: Model<'openai-completions'> = {
    id: profile.modelId, name: profile.modelId, provider: profile.provider,
    api: 'openai-completions', baseUrl: profile.baseUrl,
    input: ['text'], reasoning: true, contextWindow: profile.contextWindow,
    maxTokens: profile.maxOutputTokens,
    // The provider does not expose verified pricing here; report actual tokens and unknown cost.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false,
      thinkingFormat: 'qwen', maxTokensField: 'max_tokens', supportsStrictMode: false,
      supportsLongCacheRetention: false, sendSessionAffinityHeaders: false,
      supportsUsageInStreaming: true, supportsFinishReason: true, requiresThinkingAsText: false,
    },
  };
  const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(createProvider({
    id: profile.provider, name: 'Qwen MaaS', baseUrl: profile.baseUrl,
    models: [model], api: openAICompletionsApi(),
    auth: { apiKey: { name: 'Project-scoped API key', resolve: async () => ({ auth: { apiKey: key }, source: profile.credentialsEnv }) } },
  }));
  return models;
}
