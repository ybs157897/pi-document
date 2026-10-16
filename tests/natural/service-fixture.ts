import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { createAssistantMessageEventStream, type AssistantMessage, type JsonObject, type Models } from '@earendil-works/pi-ai';
import { Pool } from 'pg';
import type { ModelProfile } from '../../src/config/model.js';
import { createProfileModels } from '../../src/config/model.js';
import { migrate, migrateVector, PostgresDocumentBackend } from '../../src/domain/service.js';
import type { DocumentPipeline, Principal, Scope } from '../../src/domain/types.js';
import { DocumentRuntime } from '../../src/runtime/document-runtime.js';
import { NaturalTaskRuntime, type NaturalTaskAttach } from '../../src/runtime/natural-runtime.js';
import { LocalPostgres } from '../../scripts/support/local-postgres.js';

export const fixtureProfile: ModelProfile = {
  provider: 'qwen-maas',
  modelId: 'deterministic-natural-lifecycle-fixture',
  baseUrl: 'https://models.example.test/v1',
  credentialsEnv: 'PI_DOCUMENT_AGENT_API_KEY',
  contextWindow: 8192,
  maxOutputTokens: 512,
  timeoutMs: 10_000,
};

export type FixtureModel = { api: AssistantMessage['api']; provider: AssistantMessage['provider']; id: string };
export type FixtureModelPlan = (requestNo: number, model: FixtureModel, context: Parameters<Models['streamSimple']>[1]) => AssistantMessage | Promise<AssistantMessage>;

export function makeFixtureModels(plan: FixtureModelPlan): { models: Models; calls: () => number } {
  const models = createProfileModels(fixtureProfile, 'fixture-api-key');
  let requests = 0;
  models.streamSimple = ((model, context) => {
    const callNo = ++requests;
    const stream = createAssistantMessageEventStream();
    void Promise.resolve(plan(callNo, { api: model.api, provider: model.provider, id: model.id }, context)).then(
      response => stream.end(response),
      error => stream.end(fixtureResponse(model.api, model.provider, model.id, [], 'error', String(error))),
    );
    return stream;
  }) as typeof models.streamSimple;
  return { models, calls: () => requests };
}

export function fixtureResponse(
  api: AssistantMessage['api'],
  provider: AssistantMessage['provider'],
  modelId: string,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant', content, api, provider, model: modelId,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: Date.now(),
  };
}

export function fixturePlanResponse(
  requestNo: number,
  model: FixtureModel,
  entries: Array<{ call?: { name: string; arguments: JsonObject }; text?: string }>,
): AssistantMessage {
  const entry = entries[requestNo - 1];
  if (!entry) return fixtureResponse(model.api, model.provider, model.id, [{ type: 'text', text: 'Fixture response complete.' }], 'stop');
  if (entry.call) {
    return fixtureResponse(model.api, model.provider, model.id, [{
      type: 'toolCall', id: `fixture-tool-${requestNo}`, name: entry.call.name, arguments: entry.call.arguments,
    }], 'toolUse');
  }
  return fixtureResponse(model.api, model.provider, model.id, [{ type: 'text', text: entry.text ?? '' }], 'stop');
}

export type NaturalServiceFixture = {
  directory: string;
  pool: Pool;
  backend: PostgresDocumentBackend;
  runtime: DocumentRuntime;
  natural: NaturalTaskRuntime;
  principal: Principal;
  token: string;
  close(): Promise<void>;
};

export async function startNaturalService(options: {
  models: Models;
  pipeline?: DocumentPipeline;
  scopes?: Scope[];
  limits?: { modelRequests?: number; toolCalls?: number; turnTimeoutMs?: number; concurrentTurns?: number };
  attach?: (base: NaturalTaskAttach) => NaturalTaskAttach;
}): Promise<NaturalServiceFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-document-natural-lifecycle-'));
  const portServer = createServer();
  let postgres: EmbeddedPostgres | LocalPostgres | undefined;
  let pool: Pool | undefined;
  let natural: NaturalTaskRuntime | undefined;
  let runtime: DocumentRuntime | undefined;
  let closed = false;
  try {
    await new Promise<void>((resolve, reject) => {
      portServer.once('error', reject);
      portServer.listen(0, '127.0.0.1', resolve);
    });
    const address = portServer.address();
    if (!address || typeof address === 'string') throw new Error('Could not reserve a PostgreSQL test port');
    const port = address.port;
    await new Promise<void>((resolve, reject) => portServer.close(error => error ? reject(error) : resolve()));
    const password = randomUUID();
    if (options.pipeline) {
      postgres = new LocalPostgres({ dataDir: join(directory, 'postgres'), port, password });
      await postgres.start();
      pool = new Pool({ connectionString: postgres.url, max: 8 });
    } else {
      postgres = new EmbeddedPostgres({
        databaseDir: join(directory, 'postgres'), port, user: 'postgres', password, persistent: false,
        postgresFlags: ['-c', 'listen_addresses=127.0.0.1'], onLog: () => undefined, onError: console.error,
      });
      await postgres.initialise();
      await postgres.start();
      pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', max: 8 });
    }
    await migrate(pool);
    if (options.pipeline) await migrateVector(pool, options.pipeline.profile.dimensions);

    const backend = new PostgresDocumentBackend({
      pool,
      blobRoot: join(directory, 'blobs'),
      publicBaseUrl: 'https://documents.example.test',
      ...(options.pipeline ? { pipeline: options.pipeline } : {}),
    });
    const token = `natural-lifecycle-${randomUUID()}`;
    const principalId = `principal-${randomUUID()}`;
    const tenantId = `tenant-${principalId}`;
    await backend.provisionPrincipal({
      tenantId, id: principalId, token,
      scopes: options.scopes ?? ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'],
    });
    const principal = await backend.authenticate(token);
    if (!principal) throw new Error('Could not authenticate the natural test principal');

    natural = new NaturalTaskRuntime({
      backend, pool, modelProfile: fixtureProfile, apiKey: 'fixture-api-key', models: options.models,
      ...(options.limits ? { limits: options.limits } : {}),
    });
    runtime = await DocumentRuntime.open(backend, join(directory, 'pi.sqlite'), {
      models: natural.models,
      extensions: [natural.extension],
      deferResume: true,
    });
    const dependencies: NaturalTaskAttach = {
      harness: runtime.harness,
      conversationFor: (actor, contextId) => runtime!.conversationFor(actor, contextId),
      admitDomain: (actor, request, contextId) => backend.admit(actor, request, contextId),
      dispatchDomain: task => runtime!.dispatch(task),
      getDomainTask: (actor, id) => backend.getTask(actor, id),
      cancelDomain: (actor, id) => runtime!.cancel(actor, id),
    };
    await natural.attach(options.attach ? options.attach(dependencies) : dependencies);
    await runtime.start();

    return {
      directory, pool, backend, natural, runtime, principal, token,
      async close() {
        if (closed) return;
        closed = true;
        await natural?.close().catch(() => undefined);
        await runtime?.close().catch(() => undefined);
        await pool?.end().catch(() => undefined);
        await postgres?.stop().catch(() => undefined);
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await natural?.close().catch(() => undefined);
    await runtime?.close().catch(() => undefined);
    await pool?.end().catch(() => undefined);
    await postgres?.stop().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (portServer.listening) await new Promise<void>(resolve => portServer.close(() => resolve()));
  }
}
