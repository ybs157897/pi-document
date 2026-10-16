import { createHash } from 'node:crypto';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels, type Models } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, defineDocFamily, defineExtension, defineTask, type TaskId, type ConversationId, type Extension } from '@earendil-works/pi-durable';
import { openOwnedStorage } from './owned-storage.js';
import { Limiter } from './limiter.js';
import type { DocumentBackend, DocumentRequest, GatewayRuntime, Principal, StoredTask } from '../domain/types.js';
import type { FaultHook } from '../observability/faults.js';

const Binding = defineDocFamily<{ hash: string; taskId: number | null; conversationId: number | null }, { hash: string }>({
  kind: 'pi-document.task-binding', version: 1, scope: 'session', family: true,
  initial: seed => ({ hash: seed.hash, taskId: null, conversationId: null }),
});
const ConversationBinding = defineDocFamily<{ id: number | null }, null>({
  kind: 'pi-document.context-binding', version: 1, scope: 'session', family: true,
  initial: () => ({ id: null }),
});

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

export class DocumentRuntime implements GatewayRuntime {
  private timer?: NodeJS.Timeout;
  private pumping?: Promise<void>;
  private closing = false;
  private started = false;
  ready = false;
  private constructor(readonly backend: DocumentBackend, readonly harness: Harness, private readonly operationTask: ReturnType<typeof createOperationTask>, private readonly fault?: FaultHook) {}

  static async open(backend: DocumentBackend, storagePath: string, options: { models?: Models; extensions?: Extension[]; fault?: FaultHook; deferResume?: boolean } = {}) {
    const operationTask = createOperationTask(backend);
    const registry = createRegistry();
    registry.install(defineExtension({ name: 'document-service', tasks: [operationTask] }));
    for (const extension of options.extensions ?? []) registry.install(extension);
    const storage = await openOwnedStorage(storagePath);
    let harness: Harness;
    try { harness = await Harness.open(storage, { models: options.models ?? createModels(), registry, settings: { retry: { enabled: false, maxRetries: 0 }, stream: { timeoutMs: 60_000, maxRetries: 0 } } }, context); }
    catch (error) { await storage.close(context); throw error; }
    const runtime = new DocumentRuntime(backend, harness, operationTask, options.fault);
    try {
      if (!options.deferResume) await runtime.start();
      return runtime;
    } catch (error) { await runtime.close(); throw error; }
  }

  async start() {
    if (this.started) return;
    if (this.closing) throw new Error('Runtime is closing');
    await this.pump();
    this.harness.resume();
    this.started = true;
    this.timer = setInterval(() => { void this.pump().catch(() => { this.ready = false; }); }, 500);
    this.timer.unref();
  }

  async submit(principal: Principal, request: DocumentRequest, contextId?: string) {
    const admitted = await this.backend.admit(principal, request, contextId);
    await this.fault?.('admission-committed');
    if (admitted.state === 'submitted' || admitted.state === 'working') await this.dispatch(admitted);
    return this.backend.getTask(principal, admitted.id);
  }

  async conversationFor(principal: Principal, contextId: string) {
    const key = JSON.stringify([principal.tenantId, principal.id, contextId]);
    const id = await this.harness.commit(async tx => {
      const binding = await tx.doc(ConversationBinding, key, null);
      if (binding.id === null) binding.id = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id;
      return binding.id as ConversationId;
    }, context);
    const conversation = await this.harness.conversation(id, context);
    if (!conversation) throw new Error('Durable context conversation is missing');
    return conversation;
  }

  async cancel(principal: Principal, id: string) {
    const task = await this.backend.cancel(principal, id);
    if (task.state === 'canceled' && task.piTaskId !== null) {
      await this.harness.abortTask(task.piTaskId as TaskId, context);
      await this.harness.waitForTask(task.piTaskId as TaskId, context);
    }
    return this.backend.getTask(principal, id);
  }

  async dispatch(task: StoredTask) {
    if (this.closing) throw new Error('Runtime is closing');
    const hash = createHash('sha256').update(canonical({ kind: task.kind, request: task.request })).digest('hex');
    const binding = await this.harness.commit(async tx => {
      const existing = await tx.doc(Binding, task.id, { hash });
      if (existing.hash !== hash) throw new Error('Pi task binding payload mismatch');
      if (existing.taskId !== null && existing.conversationId !== null) return { taskId: existing.taskId, conversationId: existing.conversationId };
      const ctxKey = JSON.stringify([task.principal.tenantId, task.principal.id, task.contextId]);
      const conversation = await tx.doc(ConversationBinding, ctxKey, null);
      if (conversation.id === null) conversation.id = (await tx.createConversation({ ownership: { kind: 'ownerless' } })).id;
      const id = await tx.createTask(this.operationTask, { id: task.id }, {
        ownership: { kind: 'conversation' }, conversationId: conversation.id as Parameters<typeof tx.conversation>[0], background: true,
      });
      existing.taskId = id; existing.conversationId = conversation.id;
      return { taskId: id, conversationId: conversation.id };
    }, context);
    await this.fault?.('pi-admitted');
    await this.fault?.('outbox-handled');
    await this.backend.bindTask(task.id, binding.taskId, binding.conversationId);
    const internal = await this.harness.getTask(binding.taskId as TaskId, context);
    if (internal?.state.status === 'terminal' && !['completed', 'aborted'].includes(internal.state.outcome.status)) {
      await this.backend.failTask(task.id, 'RUNTIME_TASK_FAILED', 'Durable execution could not complete the operation', false);
    }
    this.harness.resume();
  }

  pump(): Promise<void> {
    if (this.closing) return Promise.resolve();
    if (this.pumping) return this.pumping;
    this.pumping = (async () => {
      for (const task of await this.backend.pendingTasks()) {
        if (this.closing) break;
        await this.dispatch(task);
      }
      this.ready = true;
    })().finally(() => { this.pumping = undefined; });
    return this.pumping;
  }

  async close() {
    this.closing = true; this.ready = false;
    if (this.timer) clearInterval(this.timer);
    await this.pumping?.catch(() => undefined);
    await this.harness.close(context);
  }
}

function createOperationTask(backend: DocumentBackend) {
  const execution = new Limiter(8);
  return defineTask<{ id: string }, { phase: 'execute'; step?: string }, { id: string }>({
    name: 'pi-document.operation', version: 1, initial: () => ({ phase: 'execute' }),
    phases: {
      execute: async (task, runtime, ctx) => {
        try {
          const result = await execution.run(runtime.signal, () => backend.execute(task.input.id, runtime.signal, async step => {
            await runtime.commit(() => ({ status: 'running', checkpoint: { phase: 'execute', step } }), ctx);
          }));
          await runtime.commit(() => ({ status: 'terminal', outcome: result.outcome === 'succeeded'
            ? { status: 'completed', result: { id: task.input.id } }
            : { status: 'failed', error: { message: result.error?.code ?? 'OPERATION_FAILED' } },
          }), ctx);
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          await backend.failTask(task.input.id, 'PROCESSING_FAILED', 'Operation failed during durable execution', true);
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message: 'PROCESSING_FAILED' } } }), ctx);
        }
      },
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'explicit-cancel' } }), ctx);
    },
  });
}
