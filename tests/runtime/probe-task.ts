import { DatabaseSync } from 'node:sqlite';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { Harness, createRegistry, defineDocFamily, defineExtension, defineTask, type TaskId } from '@earendil-works/pi-durable';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';

const Binding = defineDocFamily<{ piTaskId: number | null; payloadHash: string }, { payloadHash: string }>({
  kind: 'spike.request-binding', version: 1, scope: 'session', family: true,
  initial: seed => ({ piTaskId: null, payloadHash: seed.payloadHash }),
});

export async function openProbe(directory: string, afterEffect?: (key: string, signal: AbortSignal) => Promise<void>) {
  // This second SQLite is a technical-probe receipt store, not the application's PostgreSQL replacement.
  const receipt = new DatabaseSync(`${directory}/effect.sqlite`);
  receipt.exec('CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, result TEXT NOT NULL)');
  let attempts = 0;
  const task = defineTask<{ key: string }, { phase: 'effect' }, { key: string }>({
    name: 'spike.effect', version: 1, initial: () => ({ phase: 'effect' }),
    phases: {
      effect: async (current, runtime, ctx) => {
        attempts++;
        receipt.prepare('INSERT OR IGNORE INTO receipts VALUES (?, ?)').run(current.input.key, 'stored');
        await afterEffect?.(current.input.key, runtime.signal);
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: { key: current.input.key } } }), ctx);
      },
    },
    abort: async (_current, runtime, ctx) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted', reason: 'explicit-cancel' } }), ctx);
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'probe', tasks: [task] }));
  const harness = await Harness.open(await openNodeSqliteStorage(`${directory}/pi.sqlite`), { registry, models: createModels() }, context);
  const conversation = await harness.root(context);
  return {
    harness,
    async admit(key: string, payloadHash = 'same') {
      return harness.commit(async tx => {
        const binding = await tx.doc(Binding, key, { payloadHash });
        if (binding.payloadHash !== payloadHash) throw new Error('IDEMPOTENCY_CONFLICT');
        if (binding.piTaskId !== null) return binding.piTaskId as TaskId<{ key: string }>;
        const id = await tx.createTask(task, { key }, { ownership: { kind: 'conversation' }, conversationId: conversation.id, background: true });
        binding.piTaskId = id;
        return id;
      }, context);
    },
    count: () => (receipt.prepare('SELECT COUNT(*) AS count FROM receipts').get() as { count: number }).count,
    attempts: () => attempts,
    async close() { await harness.close(context); receipt.close(); },
  };
}
