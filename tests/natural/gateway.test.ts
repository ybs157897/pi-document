import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import test from 'node:test';
import { createGateway } from '../../src/a2a/gateway.js';
import { DomainError, type GatewayRuntime, type Principal } from '../../src/domain/types.js';
import type { NaturalTask } from '../../src/runtime/natural-store.js';
import type { NaturalTaskRuntime } from '../../src/runtime/natural-runtime.js';

const principal: Principal = {
  tenantId: 'tenant-natural',
  id: 'principal-natural',
  scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'],
};
const readOnlyPrincipal: Principal = {
  tenantId: principal.tenantId,
  id: 'principal-natural-reader',
  scopes: ['knowledge:read'],
};

type RunningGateway = { origin: string; server: Server; tasks: Map<string, NaturalTask>; calls: string[] };

async function openGateway(): Promise<RunningGateway> {
  const tasks = new Map<string, NaturalTask>();
  const calls: string[] = [];
  let nextId = 1;
  const natural = {
    async submitText(actor: Principal, messageId: string, text: string, contextId?: string) {
      calls.push(`submit:${messageId}:${text}`);
      const id = `agt_${nextId++}`;
      const task: NaturalTask = {
        id,
        contextId: contextId ?? `ctx-${id}`,
        principal: structuredClone(actor),
        state: 'input_required',
        turnNo: 1,
        answer: null,
        clarification: text === 'hold' ? 'The task is paused until you continue.' : 'Which knowledge base should I use?',
        error: null,
        fence: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tasks.set(id, task);
      return structuredClone(task);
    },
    async continueText(actor: Principal, id: string, contextId: string, messageId: string, text: string) {
      calls.push(`continue:${id}:${contextId}:${messageId}:${text}`);
      const task = tasks.get(id);
      if (!task || task.principal.id !== actor.id || task.contextId !== contextId) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      task.turnNo += 1;
      task.state = 'completed';
      task.clarification = null;
      task.answer = 'Saved the requested document.';
      task.updatedAt = new Date(Date.parse(task.updatedAt) + 1).toISOString();
      return structuredClone(task);
    },
    async getTask(actor: Principal, id: string) {
      const task = tasks.get(id);
      if (!task || task.principal.id !== actor.id) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      return structuredClone(task);
    },
    async listTasks(actor: Principal, contextId?: string) {
      return [...tasks.values()].filter(task => task.principal.id === actor.id && (!contextId || task.contextId === contextId)).map(task => structuredClone(task));
    },
    async cancelTask(actor: Principal, id: string) {
      const task = tasks.get(id);
      if (!task || task.principal.id !== actor.id) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      task.state = 'canceled';
      task.updatedAt = new Date(Date.parse(task.updatedAt) + 1).toISOString();
      return structuredClone(task);
    },
  } as unknown as NaturalTaskRuntime;

  const backend = {
    indexingEnabled: false,
    authenticate: async (token: string) => token === 'natural-token'
      ? structuredClone(principal)
      : token === 'natural-reader-token' ? structuredClone(readOnlyPrincipal) : undefined,
    getTask: async () => { throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404); },
    listTasks: async () => [],
    readContent: async () => ({ bytes: Buffer.alloc(0), mimeType: 'text/plain', sha256: '0'.repeat(64) }),
  };
  const runtime = {
    backend,
    submit: async () => { throw new Error('The DataPart route is not part of this test'); },
    cancel: async () => { throw new Error('The DataPart route is not part of this test'); },
  } as unknown as GatewayRuntime;

  let app: ReturnType<typeof createGateway> | undefined;
  const server = createServer((request, response) => app ? app(request, response) : (response.writeHead(503).end()));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  app = createGateway(runtime, { publicBaseUrl: origin, natural });
  return { origin, server, tasks, calls };
}

async function closeGateway(gateway: RunningGateway): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    gateway.server.close(error => error ? reject(error) : resolve());
    gateway.server.closeAllConnections();
  });
}

async function rpc(gateway: RunningGateway, method: string, params: Record<string, unknown>, options: { token?: string } = {}) {
  const response = await fetch(`${gateway.origin}/a2a`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${options.token ?? 'natural-token'}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-natural`, method, params }),
  });
  return { response, body: await response.json() as Record<string, any> };
}

function textMessage(messageId: string, text: string, options: { taskId?: string; contextId?: string; mediaType?: string } = {}) {
  return {
    message: {
      messageId,
      role: 'ROLE_USER',
      ...(options.taskId ? { taskId: options.taskId } : {}),
      ...(options.contextId ? { contextId: options.contextId } : {}),
      parts: [{ text, mediaType: options.mediaType ?? 'text/plain' }],
    },
    configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: false },
  };
}

test('natural TextParts create, interrupt, continue, query, list, subscribe, and cancel one A2A task', async () => {
  const gateway = await openGateway();
  try {
    const card = await (await fetch(`${gateway.origin}/.well-known/agent-card.json`)).json() as Record<string, any>;
    assert.ok(card.defaultInputModes.includes('text/plain'));
    assert.ok(card.defaultOutputModes.includes('text/plain'));
    assert.ok(card.skills.some((skill: { id: string; inputModes: string[] }) => skill.id === 'natural-language-document-tasks' && skill.inputModes.includes('text/plain')));

    const created = await rpc(gateway, 'SendMessage', textMessage('natural-first', 'please save this', { contextId: 'ctx-natural' }));
    assert.equal(created.body.error, undefined);
    const first = created.body.result?.task as Record<string, any>;
    assert.match(first.id, /^agt_/);
    assert.equal(first.contextId, 'ctx-natural');
    assert.equal(first.status.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.equal(first.status.message.parts[0].text, 'Which knowledge base should I use?');
    assert.equal(first.status.message.parts[0].mediaType, 'text/plain');
    assert.equal((first.artifacts ?? []).length, 0);

    const filtered = await rpc(gateway, 'ListTasks', { contextId: 'ctx-natural', status: 'TASK_STATE_INPUT_REQUIRED' });
    assert.equal(filtered.body.result.totalSize, 1);
    assert.equal(filtered.body.result.tasks[0].id, first.id);

    const continued = await rpc(gateway, 'SendMessage', textMessage('natural-second', 'kb-alpha', {
      taskId: first.id,
      contextId: first.contextId,
    }));
    const completed = continued.body.result?.task as Record<string, any>;
    assert.equal(completed.id, first.id);
    assert.equal(completed.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(completed.artifacts[0].parts[0].text, 'Saved the requested document.');
    assert.equal(completed.artifacts[0].parts[0].mediaType, 'text/plain');
    assert.equal(completed.artifacts[0].parts[0].data, undefined);
    assert.deepEqual(gateway.calls, [
      'submit:natural-first:please save this',
      `continue:${first.id}:ctx-natural:natural-second:kb-alpha`,
    ]);

    const fetched = await rpc(gateway, 'GetTask', { id: first.id });
    assert.equal(fetched.body.result.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(fetched.body.result.artifacts[0].parts[0].mediaType, 'text/plain');

    const waiting = await rpc(gateway, 'SendMessage', textMessage('natural-hold', 'hold'));
    const waitingTask = waiting.body.result?.task as Record<string, any>;
    const subscription = await fetch(`${gateway.origin}/a2a`, {
      method: 'POST',
      headers: { Authorization: 'Bearer natural-token', 'Content-Type': 'application/json', 'A2A-Version': '1.0', Accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'subscribe-natural', method: 'SubscribeToTask', params: { id: waitingTask.id } }),
    });
    assert.equal(subscription.status, 200);
    const stream = await subscription.text();
    assert.match(stream, new RegExp(waitingTask.id));
    assert.match(stream, /TASK_STATE_INPUT_REQUIRED/);

    const canceled = await rpc(gateway, 'CancelTask', { id: waitingTask.id });
    assert.equal(canceled.body.result.status.state, 'TASK_STATE_CANCELED');

    const readOnlyTaskResponse = await rpc(gateway, 'SendMessage', textMessage('reader-hold', 'hold'), { token: 'natural-reader-token' });
    const readOnlyTask = readOnlyTaskResponse.body.result.task as Record<string, any>;
    assert.equal(readOnlyTask.status.state, 'TASK_STATE_INPUT_REQUIRED');
    const readOnlyCanceled = await rpc(gateway, 'CancelTask', { id: readOnlyTask.id }, { token: 'natural-reader-token' });
    assert.equal(readOnlyCanceled.response.status, 200);
    assert.equal(readOnlyCanceled.body.result.status.state, 'TASK_STATE_CANCELED');
  } finally {
    await closeGateway(gateway);
  }
});

test('natural TextPart parsing rejects missing media types, mixed parts, and context changes', async () => {
  const gateway = await openGateway();
  try {
    const noMediaType = await rpc(gateway, 'SendMessage', textMessage('missing-media', 'hello', { mediaType: '' }));
    assert.equal(noMediaType.body.error?.code, -32005);

    const mixedPart = await rpc(gateway, 'SendMessage', {
      ...textMessage('mixed-part', 'hello'),
      message: { ...textMessage('mixed-part', 'hello').message, parts: [{ text: 'hello', data: {}, mediaType: 'text/plain' }] },
    });
    assert.equal(mixedPart.body.error?.code, -32602);

    const first = await rpc(gateway, 'SendMessage', textMessage('context-original', 'please save', { contextId: 'ctx-original' }));
    const task = first.body.result.task as Record<string, any>;
    const mismatch = await rpc(gateway, 'SendMessage', textMessage('context-mismatch', 'kb-alpha', {
      taskId: task.id,
      contextId: 'ctx-other',
    }));
    assert.equal(mismatch.body.error?.code, -32602);
    assert.equal(gateway.calls.filter(call => call.startsWith('continue:')).length, 0);
  } finally {
    await closeGateway(gateway);
  }
});
