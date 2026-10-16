import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Role, TaskState as A2ATaskState, type SendMessageRequest } from '@a2a-js/sdk';
import { ClientFactory } from '@a2a-js/sdk/client';
import { createGateway } from '../../src/a2a/gateway.js';
import { DomainError, type BusinessResult, type DocumentBackend, type DocumentRequest, type GatewayRuntime, type Principal, type StoredTask } from '../../src/domain/types.js';

type RunningGateway = {
  origin: string;
  server: Server;
  runtime: StubRuntime;
};

class StubBackend implements DocumentBackend {
  readonly tasks = new Map<string, StoredTask>();
  readonly getTaskCalls = new Map<string, number>();
  readonly contentReads: string[] = [];
  readonly cancelCalls: string[] = [];
  readonly uploadCalls: Array<{ principal: Principal; knowledgeBaseId: string; bytes: Buffer; mimeType: string }> = [];
  readonly indexingEnabled: boolean;
  createUpload?: NonNullable<DocumentBackend['createUpload']>;
  private uploadGate: Promise<void> = Promise.resolve();
  private readonly tokens = new Map<string, Principal>([
    ['alpha-token', { tenantId: 'tenant-a', id: 'alpha', scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'] }],
    ['beta-token', { tenantId: 'tenant-b', id: 'beta', scopes: ['knowledge:read', 'knowledge:write'] }],
    ['read-only-token', { tenantId: 'tenant-a', id: 'reader', scopes: ['knowledge:read'] }],
  ]);
  private nextTaskId = 1;
  private nextUploadId = 1;

  constructor(options: { indexingEnabled?: boolean; uploadsEnabled?: boolean } = {}) {
    this.indexingEnabled = options.indexingEnabled === true;
    for (let index = 0; index < 9; index += 1) {
      this.tokens.set(`quota-token-${index}`, {
        tenantId: `quota-tenant-${index}`,
        id: `quota-principal-${index}`,
        scopes: ['knowledge:write'],
      });
    }
    if (options.uploadsEnabled !== false) {
      this.createUpload = async (principal, knowledgeBaseId, bytes, mimeType) => {
        this.uploadCalls.push({ principal: structuredClone(principal), knowledgeBaseId, bytes: Buffer.from(bytes), mimeType });
        await this.uploadGate;
        return {
          uploadId: `upload-${this.nextUploadId++}`,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          size: bytes.byteLength,
          mime: mimeType,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        };
      };
    }
  }

  holdUploads(): () => void {
    let release!: () => void;
    this.uploadGate = new Promise<void>((resolve) => { release = resolve; });
    return () => {
      release();
      this.uploadGate = Promise.resolve();
    };
  }

  async authenticate(token: string) {
    const principal = this.tokens.get(token);
    return principal ? structuredClone(principal) : undefined;
  }

  async admit(principal: Principal, request: DocumentRequest, contextId?: string): Promise<StoredTask> {
    const id = `task-${this.nextTaskId++}`;
    const now = new Date().toISOString();
    const task: StoredTask = {
      id,
      contextId: contextId ?? `context-${id}`,
      principal: structuredClone(principal),
      request: structuredClone(request),
      kind: 'operation',
      parentTaskId: null,
      state: 'submitted',
      result: null,
      piTaskId: null,
      piConversationId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(id, task);
    return structuredClone(task);
  }

  async getTask(principal: Principal, id: string): Promise<StoredTask> {
    const task = this.tasks.get(id);
    if (!task || !samePrincipal(task.principal, principal)) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
    const calls = (this.getTaskCalls.get(id) ?? 0) + 1;
    this.getTaskCalls.set(id, calls);
    if (!task.request.requestId.includes('hold')) {
      if (task.state === 'submitted') this.transition(task, 'working');
      else if (task.state === 'working') this.transition(task, 'completed', successResult(task.request));
    } else if (task.state === 'submitted') {
      this.transition(task, 'working');
    }
    return structuredClone(task);
  }

  async listTasks(principal: Principal, contextId?: string): Promise<StoredTask[]> {
    return [...this.tasks.values()]
      .filter((task) => samePrincipal(task.principal, principal) && (!contextId || task.contextId === contextId))
      .map((task) => structuredClone(task));
  }

  async pendingTasks(): Promise<StoredTask[]> {
    return [];
  }

  async bindTask(): Promise<void> {}

  async execute(id: string): Promise<BusinessResult> {
    const task = this.tasks.get(id);
    if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
    return successResult(task.request);
  }

  async failTask(id: string, code: string, message: string, retryable: boolean): Promise<BusinessResult> {
    const task = this.tasks.get(id);
    if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
    const result: BusinessResult = {
      schemaVersion: '1.0',
      operation: task.request.operation,
      requestId: task.request.requestId,
      outcome: 'failed',
      error: { code, message, retryable },
    };
    this.transition(task, 'failed', result);
    return structuredClone(result);
  }

  async cancel(principal: Principal, id: string): Promise<StoredTask> {
    const task = this.tasks.get(id);
    if (!task || !samePrincipal(task.principal, principal)) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
    if (task.state === 'completed' || task.state === 'failed') {
      throw new DomainError('TASK_NOT_CANCELABLE', 'Task is not in a cancelable state', 409);
    }
    this.cancelCalls.push(id);
    this.transition(task, 'canceled');
    return structuredClone(task);
  }

  async readContent(principal: Principal, id: string, version?: number) {
    const owner = id === 'document-alpha' ? 'alpha' : undefined;
    if (!owner || principal.id !== owner || principal.tenantId !== 'tenant-a') {
      throw new DomainError('DOCUMENT_NOT_FOUND', 'Document not found', 404);
    }
    this.contentReads.push(`${id}:${version ?? 'latest'}:${principal.id}`);
    const bytes = Buffer.from('authorized fixture document', 'utf8');
    return { bytes, mimeType: 'text/plain', sha256: 'a'.repeat(64) };
  }

  private transition(task: StoredTask, state: StoredTask['state'], result?: BusinessResult) {
    task.state = state;
    task.updatedAt = new Date(Date.parse(task.updatedAt) + 1).toISOString();
    if (result) task.result = result;
  }
}

class StubRuntime implements GatewayRuntime {
  ready = true;
  constructor(readonly backend: StubBackend) {}

  async submit(principal: Principal, request: DocumentRequest, contextId?: string): Promise<StoredTask> {
    const task = await this.backend.admit(principal, request, contextId);
    if (request.operation === 'document.save' && request.input.waitFor !== 'stored' && !this.backend.indexingEnabled) {
      await this.backend.failTask(task.id, 'INDEXING_UNAVAILABLE', 'Indexing is not available in M1', false);
    }
    return structuredClone(this.backend.tasks.get(task.id)!);
  }

  async cancel(principal: Principal, id: string): Promise<StoredTask> {
    return this.backend.cancel(principal, id);
  }
}

async function openGateway(options: { ready?: boolean; indexingEnabled?: boolean; uploadsEnabled?: boolean } = {}): Promise<RunningGateway> {
  const backend = new StubBackend(options);
  const runtime = new StubRuntime(backend);
  if (options.ready !== undefined) runtime.ready = options.ready;
  let app: ReturnType<typeof createGateway> | undefined;
  const server = createServer((request, response) => {
    if (app) app(request, response);
    else { response.writeHead(503); response.end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  app = createGateway(runtime, { publicBaseUrl: origin });
  return { origin, server, runtime };
}

async function closeGateway(gateway: RunningGateway) {
  await new Promise<void>((resolve, reject) => {
    gateway.server.close((error) => error ? reject(error) : resolve());
    gateway.server.closeAllConnections();
  });
}

function auth(token = 'alpha-token') {
  return { Authorization: `Bearer ${token}` };
}

async function rpc(
  gateway: RunningGateway,
  method: string,
  params: Record<string, unknown>,
  options: { token?: string; version?: string | null; id?: string; extra?: Record<string, unknown> } = {},
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token !== null) Object.assign(headers, auth(options.token));
  if (options.version !== null) headers['A2A-Version'] = options.version ?? '1.0';
  const response = await fetch(`${gateway.origin}/a2a`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: options.id ?? `rpc-${method}`, method, params, ...options.extra }),
  });
  return { response, body: await response.json() as Record<string, any> };
}

function sendParams(requestId: string, options: {
  waitFor?: 'stored' | 'indexed';
  returnImmediately?: boolean;
  contextId?: string;
  taskId?: string;
  operation?: string;
} = {}) {
  const operation = options.operation ?? 'document.save';
  const data = operation === 'document.save'
    ? {
        schemaVersion: '1.0', operation, requestId,
        knowledgeBaseId: 'kb-alpha',
        input: {
          source: { kind: 'text', text: 'M1 stored fixture', mimeType: 'text/markdown' },
          title: 'M1 fixture',
          ...(options.waitFor === undefined ? {} : { waitFor: options.waitFor }),
        },
      }
    : operation === 'document.search'
      ? {
          schemaVersion: '1.0', operation, requestId,
          knowledgeBaseId: 'kb-alpha', input: { query: 'fixture', topK: 5 },
        }
      : {
        schemaVersion: '1.0', operation, requestId,
        input: operation === 'knowledge_base.create' ? { name: `Fixture ${requestId}` } : { limit: 10 },
        ...(operation.startsWith('document.') ? { knowledgeBaseId: 'kb-alpha' } : {}),
      };
  return {
    message: {
      messageId: `message-${requestId}`,
      role: 'ROLE_USER',
      ...(options.contextId ? { contextId: options.contextId } : {}),
      ...(options.taskId ? { taskId: options.taskId } : {}),
      parts: [{ data, mediaType: 'application/json' }],
    },
    configuration: { acceptedOutputModes: ['application/json'], returnImmediately: options.returnImmediately ?? true },
  };
}

function a2aState(task: Record<string, any> | undefined) {
  return task?.status?.state;
}

function resultData(task: Record<string, any> | undefined) {
  return task?.artifacts?.[0]?.parts?.[0]?.data;
}

async function* sseEvents(response: Response): AsyncGenerator<Record<string, any>> {
  assert.ok(response.body);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
        if (data) yield JSON.parse(data) as Record<string, any>;
        boundary = buffer.indexOf('\n\n');
      }
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

test('Card, health, readiness, Bearer auth, and M1 capabilities are accurate', async () => {
  const gateway = await openGateway();
  try {
    const cardResponse = await fetch(`${gateway.origin}/.well-known/agent-card.json`);
    assert.equal(cardResponse.status, 200);
    const card = await cardResponse.json() as Record<string, any>;
    assert.equal(card.supportedInterfaces[0].url, `${gateway.origin}/a2a`);
    assert.equal(card.supportedInterfaces[0].protocolVersion, '1.0');
    assert.equal(card.capabilities.streaming, true);
    assert.equal(card.capabilities.pushNotifications, false);
    assert.deepEqual(card.defaultInputModes, ['application/json']);
    const tags = card.skills.flatMap((skill: { tags: string[] }) => skill.tags);
    assert.deepEqual(tags.sort(), [
      'document.get', 'document.list', 'document.save', 'knowledge_base.create', 'knowledge_base.list',
    ]);
    assert.equal(tags.includes('document.search'), false);

    const sdkClient = await new ClientFactory().createFromUrl(gateway.origin);
    const sdkTask = await sdkClient.sendMessage(sdkSendMessageRequest('sdk-discovery'), {
      serviceParameters: { Authorization: 'Bearer alpha-token' },
    });
    assert.ok('id' in sdkTask);
    assert.equal(sdkTask.status?.state, A2ATaskState.TASK_STATE_SUBMITTED);

    assert.equal((await fetch(`${gateway.origin}/healthz`)).status, 200);
    assert.equal((await fetch(`${gateway.origin}/readiness`)).status, 200);
    const unauthorized = await fetch(`${gateway.origin}/v1/documents/document-alpha/content`);
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get('www-authenticate') ?? '', /^Bearer/i);
    const downloadable = await fetch(`${gateway.origin}/v1/documents/document-alpha/content`, { headers: auth() });
    assert.equal(downloadable.status, 200);
    assert.equal(downloadable.headers.get('content-disposition'), 'attachment');
    assert.equal(downloadable.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await closeGateway(gateway);
  }

  const notReady = await openGateway({ ready: false });
  try {
    assert.equal((await fetch(`${notReady.origin}/healthz`)).status, 200);
    assert.equal((await fetch(`${notReady.origin}/readiness`)).status, 503);
  } finally {
    await closeGateway(notReady);
  }
});

test('Card advertises search and indexed saves only when the backend enables indexing', async () => {
  const gateway = await openGateway({ indexingEnabled: true });
  try {
    const card = await (await fetch(`${gateway.origin}/.well-known/agent-card.json`)).json() as Record<string, any>;
    const tags = card.skills.flatMap((skill: { tags: string[] }) => skill.tags);
    assert.ok(tags.includes('document.search'));
    assert.match(card.skills.find((skill: { id: string }) => skill.id === 'stored-text-documents')?.description ?? '', /waitFor=indexed/);

    const indexed = await rpc(gateway, 'SendMessage', sendParams('indexed-capability', { waitFor: 'indexed' }));
    assert.equal(a2aState(indexed.body.result?.task), 'TASK_STATE_SUBMITTED');
    const search = await rpc(gateway, 'SendMessage', sendParams('search-capability', { operation: 'document.search' }));
    assert.equal(search.body.error, undefined);
    assert.equal(a2aState(search.body.result?.task), 'TASK_STATE_SUBMITTED');
  } finally {
    await closeGateway(gateway);
  }
});

test('JSON-RPC maps stored tasks, scopes, cross-principal visibility, and M1 indexing failures', async () => {
  const gateway = await openGateway();
  try {
    const submitted = await rpc(gateway, 'SendMessage', sendParams('stored-one', { waitFor: 'stored' }));
    assert.equal(submitted.response.status, 200);
    const task = submitted.body.result?.task as Record<string, any>;
    assert.ok(task.id);
    assert.equal(a2aState(task), 'TASK_STATE_SUBMITTED');

    const working = await rpc(gateway, 'GetTask', { id: task.id });
    assert.equal(a2aState(working.body.result), 'TASK_STATE_WORKING');
    const completed = await rpc(gateway, 'GetTask', { id: task.id });
    assert.equal(a2aState(completed.body.result), 'TASK_STATE_COMPLETED');
    assert.equal(resultData(completed.body.result)?.outcome, 'succeeded');
    assert.equal(resultData(completed.body.result)?.result?.indexState, 'stored');
    const terminalSubscription = await rpc(gateway, 'SubscribeToTask', { id: task.id });
    assert.equal(terminalSubscription.body.error?.code, -32004);

    const blocking = await rpc(gateway, 'SendMessage', sendParams('blocking-save', { waitFor: 'stored', returnImmediately: false }));
    assert.equal(a2aState(blocking.body.result?.task), 'TASK_STATE_COMPLETED');
    assert.equal(resultData(blocking.body.result?.task)?.outcome, 'succeeded');

    const invisible = await rpc(gateway, 'GetTask', { id: task.id }, { token: 'beta-token' });
    assert.equal(invisible.body.error?.code, -32001);

    const held = await rpc(gateway, 'SendMessage', sendParams('hold-cancel', { waitFor: 'stored' }));
    const heldId = held.body.result?.task?.id as string;
    const canceled = await rpc(gateway, 'CancelTask', { id: heldId });
    assert.equal(canceled.body.result?.status?.state, 'TASK_STATE_CANCELED');
    assert.deepEqual(gateway.runtime.backend.cancelCalls, [heldId]);
    assert.equal((await rpc(gateway, 'GetTask', { id: heldId })).body.result?.status?.state, 'TASK_STATE_CANCELED');

    const kbOne = await rpc(gateway, 'SendMessage', sendParams('kb-one', { operation: 'knowledge_base.create', contextId: 'list-context' }));
    const kbTwo = await rpc(gateway, 'SendMessage', sendParams('kb-two', { operation: 'knowledge_base.create', contextId: 'list-context' }));
    assert.ok(kbOne.body.result?.task?.id && kbTwo.body.result?.task?.id);
    const firstPage = await rpc(gateway, 'ListTasks', { contextId: 'list-context', pageSize: 1 });
    assert.equal(firstPage.body.result?.totalSize, 2);
    assert.equal(firstPage.body.result?.tasks?.length, 1);
    assert.ok(firstPage.body.result?.nextPageToken);
    const secondPage = await rpc(gateway, 'ListTasks', { contextId: 'list-context', pageSize: 1, pageToken: firstPage.body.result.nextPageToken });
    assert.equal(secondPage.body.result?.totalSize, 2);
    assert.equal(secondPage.body.result?.tasks?.length, 1);
    assert.equal(secondPage.body.result?.nextPageToken, '');
    const cursor = firstPage.body.result?.nextPageToken as string;
    const crossPrincipalCursor = await rpc(gateway, 'ListTasks', {
      contextId: 'list-context', pageSize: 1, pageToken: cursor,
    }, { token: 'beta-token' });
    assert.equal(crossPrincipalCursor.body.error?.code, -32602);
    const alteredCursor = `${cursor.slice(0, -1)}${cursor.endsWith('A') ? 'B' : 'A'}`;
    const tamperedCursor = await rpc(gateway, 'ListTasks', {
      contextId: 'list-context', pageSize: 1, pageToken: alteredCursor,
    });
    assert.equal(tamperedCursor.body.error?.code, -32602);
    const mismatchedFilter = await rpc(gateway, 'ListTasks', {
      contextId: 'other-context', pageSize: 1, pageToken: cursor,
    });
    assert.equal(mismatchedFilter.body.error?.code, -32602);
    const originalDateNow = Date.now;
    try {
      Date.now = () => originalDateNow() + 60 * 60 * 1000 + 1;
      const expiredCursor = await rpc(gateway, 'ListTasks', {
        contextId: 'list-context', pageSize: 1, pageToken: cursor,
      });
      assert.equal(expiredCursor.body.error?.code, -32602);
    } finally {
      Date.now = originalDateNow;
    }

    const completedForCancel = await rpc(gateway, 'SendMessage', sendParams('cancel-completed', { waitFor: 'stored' }));
    const completedId = completedForCancel.body.result?.task?.id as string;
    await rpc(gateway, 'GetTask', { id: completedId });
    await rpc(gateway, 'GetTask', { id: completedId });
    const tooLate = await rpc(gateway, 'CancelTask', { id: completedId });
    assert.equal(tooLate.body.error?.code, -32002);

    const insufficientScope = await rpc(gateway, 'SendMessage', sendParams('read-only-save', { waitFor: 'stored' }), { token: 'read-only-token' });
    assert.equal(insufficientScope.response.status, 403);

    const indexed = await rpc(gateway, 'SendMessage', sendParams('indexed-default'));
    assert.equal(a2aState(indexed.body.result?.task), 'TASK_STATE_FAILED');
    assert.equal(resultData(indexed.body.result?.task)?.outcome, 'failed');
    assert.equal(resultData(indexed.body.result?.task)?.error?.code, 'INDEXING_UNAVAILABLE');
    assert.notEqual(resultData(indexed.body.result?.task)?.outcome, 'succeeded');

    const mismatch = await rpc(gateway, 'SendMessage', sendParams('wrong-context', { contextId: 'wrong', taskId: task.id }));
    assert.equal(mismatch.body.error?.code, -32602);
    const continuation = await rpc(gateway, 'SendMessage', sendParams('same-context', { contextId: task.contextId, taskId: task.id }));
    assert.equal(continuation.body.error?.code, -32004);

    const content = await fetch(`${gateway.origin}/v1/documents/document-alpha/content?version=1`, { headers: auth() });
    assert.equal(content.status, 200);
    assert.equal(await content.text(), 'authorized fixture document');
    assert.deepEqual(gateway.runtime.backend.contentReads, ['document-alpha:1:alpha']);
    const otherContent = await fetch(`${gateway.origin}/v1/documents/document-alpha/content`, { headers: auth('beta-token') });
    assert.equal(otherContent.status, 404);
  } finally {
    await closeGateway(gateway);
  }
});

test('strict v1.0 JSON-RPC rejects unknown fields, legacy methods, and unsupported versions', async () => {
  const gateway = await openGateway();
  try {
    const unknownParam = await rpc(gateway, 'GetTask', { id: 'task-1', surprise: true });
    assert.equal(unknownParam.body.error?.code, -32602);
    const unknownMessageField = sendParams('unknown-message-field', { waitFor: 'stored' });
    const unknownMessage = await rpc(gateway, 'SendMessage', {
      ...unknownMessageField,
      message: { ...unknownMessageField.message, parts: [{ ...unknownMessageField.message.parts[0]!, surprise: true }] },
    });
    assert.equal(unknownMessage.body.error?.code, -32602);
    const unknownBusinessField = sendParams('unknown-business-field', { waitFor: 'stored' });
    const unknownBusiness = await rpc(gateway, 'SendMessage', {
      ...unknownBusinessField,
      message: {
        ...unknownBusinessField.message,
        parts: [{ ...unknownBusinessField.message.parts[0]!, data: { ...unknownBusinessField.message.parts[0]!.data, surprise: true } }],
      },
    });
    assert.equal(unknownBusiness.body.error?.code, -32602);
    const unknownTopLevel = await rpc(gateway, 'GetTask', { id: 'task-1' }, { extra: { surprise: true } });
    assert.equal(unknownTopLevel.body.error?.code, -32600);
    const oldMethod = await rpc(gateway, 'tasks/get', { id: 'task-1' });
    assert.equal(oldMethod.body.error?.code, -32601);
    const wrongVersion = await rpc(gateway, 'GetTask', { id: 'task-1' }, { version: '1.0.1' });
    assert.equal(wrongVersion.body.error?.code, -32009);
    const absentVersion = await rpc(gateway, 'GetTask', { id: 'task-1' }, { version: null });
    assert.equal(absentVersion.body.error?.code, -32009);
    const naturalLanguage = await rpc(gateway, 'SendMessage', {
      message: { messageId: 'text-message', role: 'ROLE_USER', parts: [{ text: 'save this' }] },
    });
    assert.equal(naturalLanguage.body.error?.code, -32005);
    const search = await rpc(gateway, 'SendMessage', sendParams('m1-search', { operation: 'document.search' }));
    assert.equal(search.body.error?.code, -32004);
  } finally {
    await closeGateway(gateway);
  }
});

test('SendStreamingMessage and SubscribeToTask emit Task first, Artifact before terminal, and close', async () => {
  const gateway = await openGateway();
  try {
    const body = sendParams('stream-one', { waitFor: 'stored', returnImmediately: true });
    const streaming = await fetch(`${gateway.origin}/a2a`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json', 'A2A-Version': '1.0', Accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'stream-one', method: 'SendStreamingMessage', params: body }),
    });
    assert.equal(streaming.status, 200);
    assert.match(streaming.headers.get('content-type') ?? '', /^text\/event-stream/i);
    const sendEvents: Record<string, any>[] = [];
    for await (const event of sseEvents(streaming)) sendEvents.push(event);
    assert.equal(sendEvents[0]?.result?.task?.status?.state, 'TASK_STATE_SUBMITTED');
    assert.deepEqual(sendEvents.map(eventCase), ['task', 'statusUpdate', 'artifactUpdate', 'statusUpdate']);
    assert.equal(sendEvents.at(-1)?.result?.statusUpdate?.status?.state, 'TASK_STATE_COMPLETED');

    const created = await rpc(gateway, 'SendMessage', sendParams('subscribe-one', { waitFor: 'stored', returnImmediately: true }));
    const taskId = created.body.result?.task?.id as string;
    const subscribed = await fetch(`${gateway.origin}/a2a`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json', 'A2A-Version': '1.0', Accept: 'text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'subscribe-one', method: 'SubscribeToTask', params: { id: taskId } }),
    });
    const subscribeEvents: Record<string, any>[] = [];
    for await (const event of sseEvents(subscribed)) subscribeEvents.push(event);
    assert.equal(subscribeEvents[0]?.result?.task?.id, taskId);
    assert.deepEqual(subscribeEvents.map(eventCase), ['task', 'artifactUpdate', 'statusUpdate']);
    assert.equal(subscribeEvents.at(-1)?.result?.statusUpdate?.status?.state, 'TASK_STATE_COMPLETED');
  } finally {
    await closeGateway(gateway);
  }
});

test('disconnect stops polling without canceling the durable task', async () => {
  const gateway = await openGateway();
  const controller = new AbortController();
  try {
    const response = await fetch(`${gateway.origin}/a2a`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json', 'A2A-Version': '1.0', Accept: 'text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'disconnect-stream', method: 'SendStreamingMessage',
        params: sendParams('disconnect-hold', { waitFor: 'stored', returnImmediately: true }),
      }),
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    assert.ok(response.body);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let streamText = '';
    while (!streamText.includes('"statusUpdate"')) {
      const next = await reader.read();
      assert.ok(next.value);
      streamText += decoder.decode(next.value, { stream: true });
    }
    assert.match(streamText, /"task"/);
    assert.match(streamText, /TASK_STATE_WORKING/);
    controller.abort();
    await reader.cancel().catch(() => undefined);
    await delay(100);
    const pollsAtSettle = gateway.runtime.backend.getTaskCalls.get('task-1') ?? 0;
    await delay(150);
    assert.equal(gateway.runtime.backend.getTaskCalls.get('task-1') ?? 0, pollsAtSettle);
    assert.deepEqual(gateway.runtime.backend.cancelCalls, []);
    assert.equal(gateway.runtime.backend.tasks.get('task-1')?.state, 'working');
  } finally {
    controller.abort();
    await closeGateway(gateway);
  }
});

test('multipart upload authenticates, validates one bounded supported file, and passes backend identity', async () => {
  const gateway = await openGateway();
  try {
    const uploaded = await postUpload(gateway, [{ filename: 'notes.md', mimeType: 'text/markdown', content: '# Upload fixture' }]);
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const result = await uploaded.json() as Record<string, any>;
    assert.equal(result.uploadId, 'upload-1');
    assert.equal(result.size, Buffer.byteLength('# Upload fixture'));
    assert.equal(result.mime, 'text/markdown');
    assert.equal(result.sha256, createHash('sha256').update('# Upload fixture').digest('hex'));
    assert.ok(Date.parse(result.expiresAt) > Date.now());
    assert.equal(gateway.runtime.backend.uploadCalls.length, 1);
    assert.deepEqual(gateway.runtime.backend.uploadCalls[0]?.principal, {
      tenantId: 'tenant-a',
      id: 'alpha',
      scopes: ['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin'],
    });
    assert.equal(gateway.runtime.backend.uploadCalls[0]?.knowledgeBaseId, 'kb-alpha');
    assert.equal(gateway.runtime.backend.uploadCalls[0]?.mimeType, 'text/markdown');

    const unauthorized = await postUpload(gateway, [{ filename: 'notes.txt', mimeType: 'text/plain', content: 'secret' }], { token: null });
    assert.equal(unauthorized.status, 401);
    const readOnly = await postUpload(gateway, [{ filename: 'notes.txt', mimeType: 'text/plain', content: 'secret' }], { token: 'read-only-token' });
    assert.equal(readOnly.status, 403);

    const multiple = await postUpload(gateway, [
      { filename: 'one.txt', mimeType: 'text/plain', content: 'one' },
      { filename: 'two.txt', mimeType: 'text/plain', content: 'two' },
    ]);
    assert.equal(multiple.status, 400);
    assert.equal((await multiple.json() as Record<string, any>).error.code, 'TOO_MANY_FILES');

    const invalidMime = await postUpload(gateway, [{ filename: 'payload.bin', mimeType: 'application/octet-stream', content: 'payload' }]);
    assert.equal(invalidMime.status, 415);
    assert.equal((await invalidMime.json() as Record<string, any>).error.code, 'UNSUPPORTED_MEDIA_TYPE');

    const oversized = await postUpload(gateway, [{
      filename: 'large.txt', mimeType: 'text/plain', content: new Uint8Array(50 * 1024 * 1024 + 1),
    }]);
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as Record<string, any>).error.code, 'UPLOAD_TOO_LARGE');
    assert.equal(gateway.runtime.backend.uploadCalls.length, 1);
  } finally {
    await closeGateway(gateway);
  }
});

test('upload route returns 501 when a backend has no upload implementation', async () => {
  const gateway = await openGateway({ uploadsEnabled: false });
  try {
    const response = await postUpload(gateway, [{ filename: 'notes.txt', mimeType: 'text/plain', content: 'text' }]);
    assert.equal(response.status, 501);
    assert.equal((await response.json() as Record<string, any>).error.code, 'UPLOADS_NOT_SUPPORTED');
  } finally {
    await closeGateway(gateway);
  }
});

test('upload concurrency slots enforce principal and global limits and release after completion', async () => {
  const gateway = await openGateway();
  const backend = gateway.runtime.backend;
  const releaseForPrincipal = backend.holdUploads();
  try {
    const samePrincipal = [0, 1].map(() => postUpload(gateway, [{ filename: 'a.txt', mimeType: 'text/plain', content: 'x' }]));
    await waitForUploadCalls(backend, 2);
    const thirdForPrincipal = await postUpload(gateway, [{ filename: 'a.txt', mimeType: 'text/plain', content: 'x' }]);
    assert.equal(thirdForPrincipal.status, 429);
    releaseForPrincipal();
    assert.deepEqual((await Promise.all(samePrincipal)).map((response) => response.status), [201, 201]);
    assert.equal((await postUpload(gateway, [{ filename: 'a.txt', mimeType: 'text/plain', content: 'x' }])).status, 201);

    const releaseForGlobal = backend.holdUploads();
    const distinctPrincipals = Array.from({ length: 8 }, (_, index) => postUpload(
      gateway,
      [{ filename: 'a.txt', mimeType: 'text/plain', content: 'x' }],
      { token: `quota-token-${index}` },
    ));
    await waitForUploadCalls(backend, 11);
    const ninthGlobal = await postUpload(gateway, [{ filename: 'a.txt', mimeType: 'text/plain', content: 'x' }], { token: 'quota-token-8' });
    assert.equal(ninthGlobal.status, 429);
    releaseForGlobal();
    assert.deepEqual((await Promise.all(distinctPrincipals)).map((response) => response.status), Array(8).fill(201));
  } finally {
    releaseForPrincipal();
    await closeGateway(gateway);
  }
});

async function postUpload(
  gateway: RunningGateway,
  files: Array<{ filename: string; mimeType: string; content: string | Uint8Array }>,
  options: { token?: string | null; knowledgeBaseId?: string } = {},
): Promise<Response> {
  const form = new FormData();
  for (const file of files) {
    const content: BlobPart = typeof file.content === 'string' ? file.content : toArrayBuffer(file.content);
    form.append('file', new Blob([content], { type: file.mimeType }), file.filename);
  }
  const headers: Record<string, string> = {};
  if (options.token !== null) Object.assign(headers, auth(options.token));
  const knowledgeBaseId = options.knowledgeBaseId ?? 'kb-alpha';
  return fetch(`${gateway.origin}/v1/uploads?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`, {
    method: 'POST',
    headers,
    body: form,
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function waitForUploadCalls(backend: StubBackend, expected: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (backend.uploadCalls.length < expected && Date.now() < deadline) await delay(5);
  assert.equal(backend.uploadCalls.length, expected);
}

function eventCase(event: Record<string, any>): string {
  const result = event.result ?? {};
  if (result.task) return 'task';
  if (result.statusUpdate) return 'statusUpdate';
  if (result.artifactUpdate) return 'artifactUpdate';
  return 'unknown';
}

function successResult(request: DocumentRequest): BusinessResult {
  return {
    schemaVersion: '1.0',
    operation: request.operation,
    requestId: request.requestId,
    outcome: 'succeeded',
    result: request.operation === 'document.save'
      ? { documentId: 'document-alpha', version: 1, indexState: 'stored', sha256: 'a'.repeat(64) }
      : { items: [] },
  };
}

function sdkSendMessageRequest(requestId: string): SendMessageRequest {
  return {
    tenant: '',
    message: {
      messageId: `message-${requestId}`,
      role: Role.ROLE_USER,
      parts: [{
        content: {
          $case: 'data',
          value: {
            schemaVersion: '1.0',
            operation: 'knowledge_base.list',
            requestId,
            input: { limit: 10 },
          },
        },
        mediaType: 'application/json',
        filename: '',
        metadata: undefined,
      }],
      contextId: '',
      taskId: '',
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    },
    configuration: {
      acceptedOutputModes: ['application/json'],
      taskPushNotificationConfig: undefined,
      returnImmediately: true,
    },
    metadata: undefined,
  };
}

function samePrincipal(left: Principal, right: Principal): boolean {
  return left.id === right.id && left.tenantId === right.tenantId;
}
