import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import Busboy from 'busboy';
import {
  AgentCard as AgentCardCodec,
  Role,
  TaskState as A2ATaskState,
  type AgentCard,
  type AgentSkill,
  type Artifact,
  type ListTasksRequest,
  type ListTasksResponse,
  type Message,
  type Part,
  type SendMessageRequest,
  type StreamResponse,
  type Task as A2ATask,
  type TaskArtifactUpdateEvent,
  type TaskState as A2ATaskStateType,
  type TaskStatus,
  type TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  A2AError,
  ContentTypeNotSupportedError,
  JsonRpcRequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';
import {
  defaultServerCallContextBuilder,
  type A2ARequestHandler,
  type ServerCallContext,
  type ServerCallContextBuilderOptions,
  type User,
} from '@a2a-js/sdk/server';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { parseRequest } from '../domain/validation.js';
import { NaturalTaskRuntime } from '../runtime/natural-runtime.js';
import {
  DomainError,
  type DocumentRequest,
  type GatewayRuntime,
  type Principal,
  type Scope,
  type StoredTask,
} from '../domain/types.js';
import type { NaturalTask } from '../runtime/natural-store.js';

const A2A_PATH = '/a2a';
const CARD_PATH = '/.well-known/agent-card.json';
const POLL_INTERVAL_MS = 50;
const TASK_CURSOR_TTL_MS = 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_ACTIVE_UPLOADS = 8;
const MAX_ACTIVE_UPLOADS_PER_PRINCIPAL = 2;
const UPLOAD_MEDIA_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/html',
]);
const PRINCIPAL_STATE_KEY = 'pi-document.gateway.principal';
const SIGNAL_STATE_KEY = 'pi-document.gateway.disconnect-signal';
const REQUEST_PRINCIPAL = Symbol('pi-document.gateway.principal');
const REQUEST_SIGNAL = Symbol('pi-document.gateway.disconnect-signal');

type GatewayRequest = Request & {
  [REQUEST_PRINCIPAL]?: Principal;
  [REQUEST_SIGNAL]?: AbortSignal;
};

type GatewayUser = User & {
  principal: Principal;
  disconnectSignal: AbortSignal;
};

type GatewayOptions = { publicBaseUrl: string; natural?: NaturalTaskRuntime };
type GatewayTask = StoredTask | NaturalTask;
type JsonRecord = Record<string, unknown>;
type UploadSlots = { active: number; byPrincipal: Map<string, number> };

const taskStateToA2A: Record<StoredTask['state'], A2ATaskStateType> = {
  submitted: A2ATaskState.TASK_STATE_SUBMITTED,
  working: A2ATaskState.TASK_STATE_WORKING,
  completed: A2ATaskState.TASK_STATE_COMPLETED,
  failed: A2ATaskState.TASK_STATE_FAILED,
  canceled: A2ATaskState.TASK_STATE_CANCELED,
};

const naturalStateToA2A: Record<NaturalTask['state'], A2ATaskStateType> = {
  submitted: A2ATaskState.TASK_STATE_SUBMITTED,
  working: A2ATaskState.TASK_STATE_WORKING,
  input_required: A2ATaskState.TASK_STATE_INPUT_REQUIRED,
  cancel_requested: A2ATaskState.TASK_STATE_WORKING,
  completed: A2ATaskState.TASK_STATE_COMPLETED,
  failed: A2ATaskState.TASK_STATE_FAILED,
  canceled: A2ATaskState.TASK_STATE_CANCELED,
};

const terminalStates = new Set<StoredTask['state']>(['completed', 'failed', 'canceled']);

function isNaturalTask(task: GatewayTask): task is NaturalTask {
  return task.id.startsWith('agt_');
}

function isTerminalTask(task: GatewayTask): boolean {
  return isNaturalTask(task)
    ? task.state === 'completed' || task.state === 'failed' || task.state === 'canceled'
    : terminalStates.has(task.state);
}

function isInterruptedTask(task: GatewayTask): boolean {
  return isNaturalTask(task) && task.state === 'input_required';
}

const requestFieldSets: Record<string, readonly string[]> = {
  SendMessage: ['tenant', 'message', 'configuration', 'metadata'],
  SendStreamingMessage: ['tenant', 'message', 'configuration', 'metadata'],
  GetTask: ['tenant', 'id', 'historyLength'],
  ListTasks: ['tenant', 'contextId', 'status', 'pageSize', 'pageToken', 'historyLength', 'statusTimestampAfter', 'includeArtifacts'],
  CancelTask: ['tenant', 'id', 'metadata'],
  SubscribeToTask: ['tenant', 'id'],
};

export function createGateway(runtime: GatewayRuntime, options: GatewayOptions): Express {
  const publicBaseUrl = normalizePublicBaseUrl(options.publicBaseUrl);
  const indexingEnabled = runtime.backend.indexingEnabled === true;
  const natural = options.natural;
  const uploadEnabled = typeof runtime.backend.createUpload === 'function';
  const card = createAgentCard(publicBaseUrl, indexingEnabled, natural !== undefined, uploadEnabled);
  const cursorSecret = randomBytes(32);
  const uploadSlots: UploadSlots = { active: 0, byPrincipal: new Map() };
  const requestHandler = createBackendRequestHandler(runtime, card, cursorSecret, natural);
  const app = express();

  app.disable('x-powered-by');
  app.get(CARD_PATH, (_request, response) => {
    response.json(AgentCardCodec.toJSON(card));
  });
  app.get('/healthz', (_request, response) => {
    response.status(200).json({ status: 'ok' });
  });
  app.get(['/readiness', '/readyz'], (_request, response) => {
    if (!runtimeIsReady(runtime)) {
      response.status(503).json({ status: 'not_ready' });
      return;
    }
    response.status(200).json({ status: 'ready' });
  });

  app.use(A2A_PATH, requireBearer(runtime));
  app.use(A2A_PATH, express.json({ limit: '1mb', strict: true }));
  app.use(A2A_PATH, rejectUnknownJsonRpcFields);
  app.use(A2A_PATH, requireRpcScope);
  app.use(A2A_PATH, attachDisconnectSignal);
  app.use(A2A_PATH, jsonRpcHandler({
    requestHandler,
    userBuilder: buildGatewayUser,
    contextBuilder: buildServerCallContext,
  }));

  app.get('/v1/documents/:id/content', requireBearer(runtime), async (request, response, next) => {
    try {
      const principal = principalFromRequest(request as GatewayRequest);
      if (!hasScope(principal, 'knowledge:read')) {
        sendHttpError(response, 403, 'FORBIDDEN', 'Insufficient scope');
        return;
      }
      const version = parseContentVersion(request.query.version);
      const documentId = request.params.id;
      if (typeof documentId !== 'string' || !documentId) throw new DomainError('INVALID_DOCUMENT_ID', 'Invalid document id', 400);
      const content = await runtime.backend.readContent(principal, documentId, version);
      response
        .status(200)
        .set('Content-Type', safeDocumentMimeType(content.mimeType))
        .set('Content-Length', String(content.bytes.byteLength))
        .set('Cache-Control', 'private, no-store')
        .set('Content-Disposition', 'attachment')
        .set('ETag', `"${content.sha256}"`)
        .set('X-Content-SHA256', content.sha256)
        .set('X-Content-Type-Options', 'nosniff')
        .send(content.bytes);
    } catch (error) {
      if (isInvisibleResource(error)) {
        sendHttpError(response, 404, 'DOCUMENT_NOT_FOUND', 'Document not found');
        return;
      }
      next(error);
    }
  });

  app.post('/v1/uploads', requireBearer(runtime), createUploadHandler(runtime, uploadSlots));

  app.use(httpErrorHandler());
  return app;
}

function createUploadHandler(runtime: GatewayRuntime, slots: UploadSlots): RequestHandler {
  return async (request, response, next) => {
    let releaseSlot: (() => void) | undefined;
    let abortController: AbortController | undefined;
    const gatewayRequest = request as GatewayRequest;
    let onRequestAborted: (() => void) | undefined;
    let onResponseClosed: (() => void) | undefined;
    try {
      const principal = principalFromRequest(gatewayRequest);
      if (!hasScope(principal, 'knowledge:write')) {
        request.resume();
        sendHttpError(response, 403, 'FORBIDDEN', 'Insufficient scope');
        return;
      }
      const knowledgeBaseId = parseUploadKnowledgeBaseId(request.query.knowledgeBaseId);
      const createUpload = runtime.backend.createUpload;
      if (typeof createUpload !== 'function') {
        request.resume();
        sendHttpError(response, 501, 'UPLOADS_NOT_SUPPORTED', 'This backend does not support uploads');
        return;
      }
      releaseSlot = acquireUploadSlot(principal, slots);
      if (!releaseSlot) {
        request.resume();
        response.set('Retry-After', '1');
        sendHttpError(response, 429, 'UPLOAD_CONCURRENCY_LIMIT', 'Upload concurrency limit reached');
        return;
      }

      abortController = new AbortController();
      onRequestAborted = () => abortController?.abort(new Error('Upload request was aborted'));
      onResponseClosed = () => {
        if (!response.writableEnded) abortController?.abort(new Error('Upload response was closed'));
      };
      request.once('aborted', onRequestAborted);
      response.once('close', onResponseClosed);

      const upload = await readMultipartUpload(request, abortController.signal);
      if (abortController.signal.aborted) throw uploadAbortedError();
      const result = await createUpload.call(runtime.backend, principal, knowledgeBaseId, upload.bytes, upload.mimeType);
      if (abortController.signal.aborted || response.destroyed) return;
      response
        .status(201)
        .set('Cache-Control', 'private, no-store')
        .json({
          uploadId: result.uploadId,
          sha256: result.sha256,
          size: result.size,
          mime: result.mime,
          expiresAt: result.expiresAt,
        });
    } catch (error) {
      if (!response.destroyed && !response.headersSent) {
        if (!request.readableEnded) request.resume();
        next(error);
      }
    } finally {
      if (onRequestAborted) request.off('aborted', onRequestAborted);
      if (onResponseClosed) response.off('close', onResponseClosed);
      releaseSlot?.();
    }
  };
}

function acquireUploadSlot(principal: Principal, slots: UploadSlots): (() => void) | undefined {
  const key = JSON.stringify([principal.tenantId, principal.id]);
  const principalActive = slots.byPrincipal.get(key) ?? 0;
  if (slots.active >= MAX_ACTIVE_UPLOADS || principalActive >= MAX_ACTIVE_UPLOADS_PER_PRINCIPAL) return undefined;
  slots.active += 1;
  slots.byPrincipal.set(key, principalActive + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    slots.active -= 1;
    const remaining = (slots.byPrincipal.get(key) ?? 1) - 1;
    if (remaining > 0) slots.byPrincipal.set(key, remaining);
    else slots.byPrincipal.delete(key);
  };
}

function parseUploadKnowledgeBaseId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200) {
    throw new DomainError('INVALID_KNOWLEDGE_BASE_ID', 'knowledgeBaseId must be a non-empty string of at most 200 characters', 400);
  }
  return value;
}

async function readMultipartUpload(
  request: Request,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: string }> {
  const contentType = request.header('content-type') ?? '';
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    request.resume();
    throw new DomainError('MULTIPART_REQUIRED', 'Content-Type must be multipart/form-data', 415);
  }

  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: request.headers,
      limits: {
        fileSize: MAX_UPLOAD_BYTES,
        files: 1,
        fields: 0,
        // Busboy counts the initial multipart boundary, so 2 permits one actual form part.
        parts: 2,
        fieldNameSize: 100,
        fieldSize: 1024,
        headerPairs: 32,
      },
    });
  } catch {
    request.resume();
    throw new DomainError('INVALID_MULTIPART', 'Malformed multipart upload', 400);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let fileSeen = false;
    let mimeType = '';
    let byteLength = 0;
    let failure: DomainError | undefined;
    const chunks: Buffer[] = [];

    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      request.off('error', onRequestError);
    };
    const rejectOnce = (error: DomainError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const markFailure = (error: DomainError) => {
      failure ??= error;
    };
    const onRequestError = () => {
      request.unpipe(parser);
      parser.destroy();
      rejectOnce(new DomainError('INVALID_MULTIPART', 'Upload request ended unexpectedly', 400));
    };
    const onAbort = () => {
      request.unpipe(parser);
      parser.destroy();
      request.resume();
      rejectOnce(uploadAbortedError());
    };

    parser.on('file', (_fieldName, stream, info) => {
      fileSeen = true;
      mimeType = normalizeMediaType(info.mimeType);
      if (!UPLOAD_MEDIA_TYPES.has(mimeType)) {
        markFailure(new DomainError('UNSUPPORTED_MEDIA_TYPE', 'Upload MIME type is not supported', 415));
        stream.resume();
        return;
      }
      stream.on('limit', () => markFailure(new DomainError('UPLOAD_TOO_LARGE', 'File exceeds the 50 MiB limit', 413)));
      stream.on('data', (chunk: Buffer | string) => {
        if (failure) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteLength += bytes.byteLength;
        chunks.push(bytes);
      });
      stream.on('error', () => markFailure(new DomainError('INVALID_MULTIPART', 'Upload stream failed', 400)));
      stream.on('end', () => {
        if (stream.truncated) markFailure(new DomainError('UPLOAD_TOO_LARGE', 'File exceeds the 50 MiB limit', 413));
      });
    });
    parser.on('field', (_name, _value, info) => {
      markFailure(new DomainError(
        info.nameTruncated || info.valueTruncated ? 'MULTIPART_FIELD_TOO_LARGE' : 'UNEXPECTED_MULTIPART_FIELD',
        'Upload accepts one file and no form fields',
        info.nameTruncated || info.valueTruncated ? 413 : 400,
      ));
    });
    parser.on('filesLimit', () => markFailure(new DomainError('TOO_MANY_FILES', 'Upload accepts exactly one file', 400)));
    parser.on('fieldsLimit', () => markFailure(new DomainError('UNEXPECTED_MULTIPART_FIELD', 'Upload accepts no form fields', 400)));
    parser.on('partsLimit', () => markFailure(new DomainError('TOO_MANY_PARTS', 'Upload accepts exactly one multipart part', 400)));
    parser.once('error', () => {
      request.unpipe(parser);
      request.resume();
      rejectOnce(new DomainError('INVALID_MULTIPART', 'Malformed multipart upload', 400));
    });
    parser.once('close', () => {
      if (failure) {
        rejectOnce(failure);
      } else if (!fileSeen) {
        rejectOnce(new DomainError('FILE_REQUIRED', 'Upload requires one file', 400));
      } else if (byteLength === 0) {
        rejectOnce(new DomainError('EMPTY_FILE', 'Empty files cannot be uploaded', 400));
      } else if (!settled) {
        settled = true;
        cleanup();
        resolve({ bytes: Buffer.concat(chunks, byteLength), mimeType });
      }
    });
    request.once('error', onRequestError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    request.pipe(parser);
  });
}

function uploadAbortedError(): DomainError {
  return new DomainError('UPLOAD_ABORTED', 'Upload was interrupted', 400);
}

function normalizeMediaType(value: string): string {
  return value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function safeDocumentMimeType(value: string): string {
  const normalized = normalizeMediaType(value);
  return UPLOAD_MEDIA_TYPES.has(normalized) ? normalized : 'application/octet-stream';
}

function createBackendRequestHandler(runtime: GatewayRuntime, card: AgentCard, cursorSecret: Buffer, natural?: NaturalTaskRuntime): A2ARequestHandler {
  return {
    async getAgentCard() {
      return card;
    },
    async getAuthenticatedExtendedAgentCard() {
      throw new UnsupportedOperationError('Authenticated extended Agent Cards are not supported');
    },
    async sendMessage(params, context) {
      const principal = principalFromContext(context);
      const submitted = await submitMessage(runtime, natural, principal, params);
      if (params.configuration?.returnImmediately === true || isTerminalTask(submitted) || isInterruptedTask(submitted)) return toA2ATask(submitted);
      return toA2ATask(await waitForTerminal(runtime, natural, principal, submitted, disconnectSignal(context)));
    },
    async *sendMessageStream(params, context) {
      const principal = principalFromContext(context);
      const submitted = await submitMessage(runtime, natural, principal, params);
      yield taskStreamEvent(submitted);
      if (isTerminalTask(submitted) || isInterruptedTask(submitted)) return;
      yield* pollTaskEvents(runtime, natural, principal, submitted, disconnectSignal(context));
    },
    async getTask(params, context) {
      assertTenantAbsent(params.tenant);
      assertNonNegativeInteger(params.historyLength, 'historyLength');
      const principal = principalFromContext(context);
      return toA2ATask(await getVisibleTask(runtime, natural, principal, params.id));
    },
    async listTasks(params, context) {
      assertTenantAbsent(params.tenant);
      validateListTasksRequest(params);
      const principal = principalFromContext(context);
      return listVisibleTasks(runtime, natural, principal, params, cursorSecret);
    },
    async cancelTask(params, context) {
      assertTenantAbsent(params.tenant);
      if (!params.id) throw invalidParams('CancelTask requires an id');
      const principal = principalFromContext(context);
      try {
        const task = params.id.startsWith('agt_')
          ? await requireNaturalRuntime(natural, true).cancelTask(principal, params.id)
          : await runtime.cancel(principal, params.id);
        assertTaskPrincipal(task, principal);
        if (isTerminalTask(task) && task.state !== 'canceled') {
          throw new TaskNotCancelableError('Task is not in a cancelable state');
        }
        return toA2ATask(task);
      } catch (error) {
        rethrowA2AError(error, 'cancel');
      }
    },
    async *resubscribe(params, context) {
      assertTenantAbsent(params.tenant);
      if (!params.id) throw invalidParams('SubscribeToTask requires an id');
      const principal = principalFromContext(context);
      const task = await getVisibleTask(runtime, natural, principal, params.id);
      if (isTerminalTask(task)) {
        throw new UnsupportedOperationError('A terminal task cannot be subscribed to');
      }
      yield taskStreamEvent(task);
      if (!isInterruptedTask(task)) yield* pollTaskEvents(runtime, natural, principal, task, disconnectSignal(context));
    },
    async createTaskPushNotificationConfig() {
      throw new UnsupportedOperationError('Push notifications are not supported');
    },
    async getTaskPushNotificationConfig() {
      throw new UnsupportedOperationError('Push notifications are not supported');
    },
    async listTaskPushNotificationConfigs() {
      throw new UnsupportedOperationError('Push notifications are not supported');
    },
    async deleteTaskPushNotificationConfig() {
      throw new UnsupportedOperationError('Push notifications are not supported');
    },
  };
}

async function submitMessage(
  runtime: GatewayRuntime,
  natural: NaturalTaskRuntime | undefined,
  principal: Principal,
  params: SendMessageRequest,
): Promise<GatewayTask> {
  assertTenantAbsent(params.tenant);
  const message = params.message;
  if (!message || message.role !== Role.ROLE_USER || !message.messageId || !Array.isArray(message.parts)) {
    throw invalidParams('SendMessage requires a user message with a messageId and parts');
  }
  if (params.configuration?.taskPushNotificationConfig) {
    throw new UnsupportedOperationError('Push notifications are not supported');
  }
  const input = parseMessageInput(message.parts, runtime.backend.indexingEnabled === true, typeof runtime.backend.createUpload === 'function');
  const acceptedModes = params.configuration?.acceptedOutputModes ?? [];
  const outputMode = input.kind === 'text' ? 'text/plain' : 'application/json';
  if (acceptedModes.length > 0 && !acceptedModes.includes(outputMode)) {
    throw new ContentTypeNotSupportedError(`This request returns ${outputMode} parts`);
  }

  if (message.taskId) {
    const previous = await getVisibleTask(runtime, natural, principal, message.taskId);
    if (message.contextId && message.contextId !== previous.contextId) {
      throw invalidParams('message.contextId does not match the task contextId');
    }
    if (isNaturalTask(previous)) {
      if (input.kind !== 'text') throw invalidParams('A natural-language task can only be continued with one text/plain TextPart');
      assertScopeForNaturalTask(principal);
      try {
        return await requireNaturalRuntime(natural).continueText(principal, previous.id, previous.contextId, message.messageId, input.text);
      } catch (error) {
        rethrowA2AError(error, 'submit');
      }
    }
    if (input.kind === 'text') {
      throw new UnsupportedOperationError('Only natural-language tasks can be continued with a TextPart');
    }
    throw new UnsupportedOperationError('Task continuation is not supported by this M1 gateway');
  }

  if (input.kind === 'text') {
    assertScopeForNaturalTask(principal);
    try {
      const task = await requireNaturalRuntime(natural).submitText(principal, message.messageId, input.text, message.contextId || undefined);
      assertTaskPrincipal(task, principal);
      if (message.contextId && task.contextId !== message.contextId) {
        throw new Error('The natural runtime returned a task with a different contextId');
      }
      return task;
    } catch (error) {
      rethrowA2AError(error, 'submit');
    }
  }

  assertScopeForOperation(principal, input.request.operation);
  try {
    const task = await runtime.submit(principal, input.request, message.contextId || undefined);
    assertTaskPrincipal(task, principal);
    if (message.contextId && task.contextId !== message.contextId) {
      throw new Error('The runtime returned a task with a different contextId');
    }
    return task;
  } catch (error) {
    rethrowA2AError(error, 'submit');
  }
}

type MessageInput = { kind: 'text'; text: string } | { kind: 'data'; request: DocumentRequest };

function parseMessageInput(parts: Part[], indexingEnabled: boolean, uploadEnabled: boolean): MessageInput {
  if (parts.length !== 1) throw invalidParams('Each message must contain exactly one TextPart or DataPart');
  const part = parts[0]!;
  if (part.content?.$case === 'text') {
    if (part.mediaType !== 'text/plain') throw new ContentTypeNotSupportedError('Natural-language messages require a text/plain TextPart');
    if (typeof part.content.value !== 'string' || !part.content.value.trim()) throw invalidParams('TextPart content must be non-empty');
    return { kind: 'text', text: part.content.value };
  }
  if (part.content?.$case !== 'data') {
    throw new ContentTypeNotSupportedError('Messages accept only text/plain TextParts or application/json DataParts');
  }
  if (part.mediaType !== 'application/json') {
    throw new ContentTypeNotSupportedError('DataParts require application/json');
  }
  try {
    const request = parseRequest(part.content.value);
    assertM1Operation(request, indexingEnabled, uploadEnabled);
    return { kind: 'data', request };
  } catch (error) {
    if (error instanceof UnsupportedOperationError || error instanceof ContentTypeNotSupportedError) throw error;
    if (error instanceof DomainError) {
      throw invalidParams(`${error.code}: ${error.message}`);
    }
    throw error;
  }
}

function assertM1Operation(request: DocumentRequest, indexingEnabled: boolean, uploadEnabled: boolean): void {
  switch (request.operation) {
    case 'knowledge_base.create':
    case 'knowledge_base.list':
    case 'document.get':
    case 'document.list':
      return;
    case 'document.save':
      if (!indexingEnabled && request.input.source.kind !== 'text') {
        throw new UnsupportedOperationError('M1 document.save supports text sources only');
      }
      if (request.input.source.kind === 'upload' && !uploadEnabled) {
        throw new UnsupportedOperationError('This gateway has no upload source support');
      }
      if (request.input.source.kind === 'url' && !indexingEnabled) {
        throw new UnsupportedOperationError('M1 document.save does not support URL sources');
      }
      return;
    case 'document.search':
      if (indexingEnabled) return;
      throw new UnsupportedOperationError('document.search is unavailable while indexing is disabled');
    case 'document.update':
      if (!indexingEnabled) throw new UnsupportedOperationError('document.update is unavailable while indexing is disabled');
      if (request.input.source.kind === 'upload' && !uploadEnabled) {
        throw new UnsupportedOperationError('This gateway has no upload source support');
      }
      return;
    case 'document.delete':
      if (indexingEnabled) return;
      throw new UnsupportedOperationError(`${request.operation} is unavailable while indexing is disabled`);
    default:
      throw new UnsupportedOperationError(`${request.operation} is not available in M1`);
  }
}

async function waitForTerminal(
  runtime: GatewayRuntime,
  natural: NaturalTaskRuntime | undefined,
  principal: Principal,
  initial: GatewayTask,
  signal?: AbortSignal,
): Promise<GatewayTask> {
  let task = initial;
  while (!isTerminalTask(task) && !isInterruptedTask(task)) {
    if (!(await waitForNextPoll(signal))) return task;
    task = await getVisibleTask(runtime, natural, principal, task.id);
    if (task.contextId !== initial.contextId) throw new TaskNotFoundError('Task not found');
  }
  return task;
}

async function* pollTaskEvents(
  runtime: GatewayRuntime,
  natural: NaturalTaskRuntime | undefined,
  principal: Principal,
  initial: GatewayTask,
  signal?: AbortSignal,
): AsyncGenerator<StreamResponse, void, undefined> {
  let task = initial;
  let lastState = task.state;
  let lastUpdatedAt = task.updatedAt;
  let lastArtifactText = taskArtifactText(task);
  while (!isTerminalTask(task) && !isInterruptedTask(task)) {
    if (!(await waitForNextPoll(signal))) return;
    task = await getVisibleTask(runtime, natural, principal, task.id);
    if (task.contextId !== initial.contextId) throw new TaskNotFoundError('Task not found');

    const nextArtifactText = taskArtifactText(task);
    if (nextArtifactText !== null && nextArtifactText !== lastArtifactText) {
      yield artifactStreamEvent(task);
    }
    if (task.state !== lastState || task.updatedAt !== lastUpdatedAt) {
      yield statusStreamEvent(task);
    }
    lastState = task.state;
    lastUpdatedAt = task.updatedAt;
    lastArtifactText = nextArtifactText;
  }
}

function waitForNextPoll(signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (continued: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(continued);
    };
    const timer = setTimeout(() => finish(true), POLL_INTERVAL_MS);
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function getVisibleTask(runtime: GatewayRuntime, natural: NaturalTaskRuntime | undefined, principal: Principal, id: string): Promise<GatewayTask> {
  if (!id) throw invalidParams('A task id is required');
  try {
    if (id.startsWith('agt_')) return await requireNaturalRuntime(natural, true).getTask(principal, id);
    const task = await runtime.backend.getTask(principal, id);
    assertTaskPrincipal(task, principal);
    return task;
  } catch (error) {
    rethrowA2AError(error, 'task');
  }
}

async function listVisibleTasks(
  runtime: GatewayRuntime,
  natural: NaturalTaskRuntime | undefined,
  principal: Principal,
  params: ListTasksRequest,
  cursorSecret: Buffer,
): Promise<ListTasksResponse> {
  assertScopeForOperation(principal, 'document.list');
  if (typeof runtime.backend.listTaskPage === 'function') {
    return listVisibleTaskPage(runtime, natural, principal, params);
  }
  let tasks: GatewayTask[];
  try {
    const stored = await runtime.backend.listTasks(principal, params.contextId || undefined);
    const naturalTasks = natural ? await natural.listTasks(principal, params.contextId || undefined) : [];
    tasks = [...stored, ...naturalTasks];
  } catch (error) {
    rethrowA2AError(error, 'list');
  }
  tasks = tasks
    .filter((task) => isSamePrincipal(task.principal, principal))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  if (params.status !== A2ATaskState.TASK_STATE_UNSPECIFIED) {
    tasks = tasks.filter((task) => toA2AStatus(task).state === params.status);
  }
  if (params.statusTimestampAfter) {
    const after = Date.parse(params.statusTimestampAfter);
    tasks = tasks.filter((task) => Date.parse(task.updatedAt) >= after);
  }
  const totalSize = tasks.length;
  const pageSize = params.pageSize ?? 50;
  const filterKey = listFilterKey(params);
  const offset = decodePageToken(params.pageToken, filterKey, principal, cursorSecret);
  const page = tasks.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    tasks: page.map((task) => toA2ATask(task, params.includeArtifacts === true)),
    nextPageToken: nextOffset < totalSize ? encodePageToken(nextOffset, filterKey, principal, cursorSecret) : '',
    pageSize,
    totalSize,
  };
}

async function listVisibleTaskPage(
  runtime: GatewayRuntime,
  natural: NaturalTaskRuntime | undefined,
  principal: Principal,
  params: ListTasksRequest,
): Promise<ListTasksResponse> {
  const pageSize = params.pageSize ?? 50;
  let page: Awaited<ReturnType<NonNullable<GatewayRuntime['backend']['listTaskPage']>>>;
  try {
    page = await runtime.backend.listTaskPage!(principal, {
      contextId: params.contextId || undefined,
      states: taskStatesFromA2A(params.status),
      updatedAfter: params.statusTimestampAfter || undefined,
      limit: pageSize,
      cursor: params.pageToken || undefined,
      includeArtifacts: params.includeArtifacts === true,
      includeNatural: natural !== undefined,
    });
  } catch (error) {
    rethrowA2AError(error, 'list');
  }

  const visible = await Promise.all(page.taskIds.map(async id => {
    try { return await getVisibleTask(runtime, natural, principal, id); }
    catch (error) {
      if (error instanceof TaskNotFoundError) return undefined;
      throw error;
    }
  }));
  const tasks = visible.filter((task): task is GatewayTask => task !== undefined);
  return {
    tasks: tasks.map(task => toA2ATask(task, params.includeArtifacts === true)),
    nextPageToken: page.nextCursor ?? '',
    pageSize,
    totalSize: page.totalSize,
  };
}

function taskStatesFromA2A(state: A2ATaskStateType): string[] {
  switch (state) {
    case A2ATaskState.TASK_STATE_UNSPECIFIED: return [];
    case A2ATaskState.TASK_STATE_SUBMITTED: return ['submitted'];
    case A2ATaskState.TASK_STATE_WORKING: return ['working', 'cancel_requested'];
    case A2ATaskState.TASK_STATE_INPUT_REQUIRED: return ['input_required'];
    case A2ATaskState.TASK_STATE_COMPLETED: return ['completed'];
    case A2ATaskState.TASK_STATE_FAILED: return ['failed'];
    case A2ATaskState.TASK_STATE_CANCELED: return ['canceled'];
    default: throw invalidParams('Unsupported task status filter');
  }
}

function toA2ATask(task: GatewayTask, includeArtifacts = true): A2ATask {
  if (isNaturalTask(task)) {
    const artifactText = task.answer;
    return {
      id: task.id,
      contextId: task.contextId,
      status: toA2AStatus(task),
      artifacts: includeArtifacts && artifactText !== null ? [toTextArtifact(task, artifactText)] : [],
      history: [],
      metadata: { naturalLanguage: true, turnNo: task.turnNo },
    };
  }
  if ((task.state === 'completed' || task.state === 'failed') && task.result === null) {
    throw new Error(`Stored ${task.state} task is missing its business result`);
  }
  return {
    id: task.id,
    contextId: task.contextId,
    status: toA2AStatus(task),
    artifacts: includeArtifacts && task.result !== null ? [toArtifact(task)] : [],
    history: [],
    metadata: { operation: task.request.operation, requestId: task.request.requestId },
  };
}

function toA2AStatus(task: GatewayTask): TaskStatus {
  if (isNaturalTask(task)) {
    return {
      state: naturalStateToA2A[task.state],
      message: task.clarification
        ? textMessage(task, `clarification-${task.turnNo}`, task.clarification)
        : task.error
          ? textMessage(task, `error-${task.turnNo}`, task.error.message)
          : undefined,
      timestamp: task.updatedAt,
    };
  }
  return {
    state: taskStateToA2A[task.state],
    message: undefined,
    timestamp: task.updatedAt,
  };
}

function toArtifact(task: StoredTask): Artifact {
  return {
    artifactId: `result-${task.id}`,
    name: `${task.request.operation} result`,
    description: '',
    parts: [
      {
        content: { $case: 'data', value: task.result },
        mediaType: 'application/json',
        filename: '',
        metadata: undefined,
      },
    ],
    metadata: undefined,
    extensions: [],
  };
}

function taskStreamEvent(task: GatewayTask): StreamResponse {
  return { payload: { $case: 'task', value: toA2ATask(task) } };
}

function statusStreamEvent(task: GatewayTask): StreamResponse {
  const event: TaskStatusUpdateEvent = {
    taskId: task.id,
    contextId: task.contextId,
    status: toA2AStatus(task),
    metadata: undefined,
  };
  return { payload: { $case: 'statusUpdate', value: event } };
}

function artifactStreamEvent(task: GatewayTask): StreamResponse {
  const event: TaskArtifactUpdateEvent = {
    taskId: task.id,
    contextId: task.contextId,
    artifact: isNaturalTask(task)
      ? toTextArtifact(task, task.answer ?? '')
      : toArtifact(task),
    append: false,
    lastChunk: true,
    metadata: undefined,
  };
  return { payload: { $case: 'artifactUpdate', value: event } };
}

function taskArtifactText(task: GatewayTask): string | null {
  if (isNaturalTask(task)) return task.answer;
  return task.result === null ? null : JSON.stringify(task.result);
}

function toTextArtifact(task: NaturalTask, text: string): Artifact {
  return {
    artifactId: `answer-${task.id}-${task.turnNo}`,
    name: 'Natural-language answer',
    description: '',
    parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
    metadata: undefined,
    extensions: [],
  };
}

function textMessage(task: NaturalTask, suffix: string, text: string): Message {
  return {
    messageId: `${task.id}-${suffix}`,
    contextId: task.contextId,
    taskId: task.id,
    role: Role.ROLE_AGENT,
    parts: [{ content: { $case: 'text', value: text }, mediaType: 'text/plain', filename: '', metadata: undefined }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function createAgentCard(publicBaseUrl: string, indexingEnabled: boolean, naturalEnabled: boolean, uploadEnabled: boolean): AgentCard {
  const bearerRequirement = { schemes: { bearerAuth: { list: [] } } };
  const skill = (
    id: string,
    name: string,
    description: string,
    tags: string[],
    examples: string[],
  ): AgentSkill => ({
    id,
    name,
    description,
    tags,
    examples,
    inputModes: ['application/json'],
    outputModes: ['application/json'],
    securityRequirements: [bearerRequirement],
  });
  return {
    name: 'Pi Document Agent',
    description: naturalEnabled
      ? indexingEnabled
        ? 'A2A gateway for knowledge-base management, stored documents, indexed saves, document search, and natural-language document tasks.'
        : 'A2A gateway for knowledge-base management, stored text documents, and natural-language document tasks. Search and indexing are unavailable in M1.'
      : indexingEnabled
        ? 'A2A gateway for knowledge-base management, stored documents, indexed saves, and document search.'
        : 'A2A gateway for knowledge-base management and stored text documents. Search and indexing are unavailable in M1.',
    supportedInterfaces: [{
      url: `${publicBaseUrl}${A2A_PATH}`,
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
      tenant: '',
    }],
    provider: { organization: 'Pi Document Agent', url: publicBaseUrl },
    version: '0.1.0',
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {
      bearerAuth: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description: 'Opaque Bearer token resolved to a principal by the gateway.',
            scheme: 'Bearer',
            bearerFormat: 'opaque',
          },
        },
      },
    },
    securityRequirements: [bearerRequirement],
    defaultInputModes: ['application/json', ...(naturalEnabled ? ['text/plain'] : [])],
    defaultOutputModes: ['application/json', ...(naturalEnabled ? ['text/plain'] : [])],
    skills: [
      skill(
        'knowledge-base-management',
        'Knowledge-base management',
        'Create and list authorized knowledge bases.',
        ['knowledge_base.create', 'knowledge_base.list'],
        ['{"schemaVersion":"1.0","operation":"knowledge_base.create","requestId":"req-1","input":{"name":"project-docs"}}'],
      ),
      skill(
        'stored-text-documents',
        'Stored text documents',
        indexingEnabled
          ? uploadEnabled
            ? 'Save or update authorized text, uploaded, or public-URL sources with waitFor=stored or waitFor=indexed, then read or list documents.'
            : 'Save or update authorized text or public-URL sources with waitFor=stored or waitFor=indexed, then read or list documents.'
          : 'Save text with waitFor=stored and read or list authorized documents. This M1 gateway does not index or search.',
        ['document.save', 'document.get', 'document.list', ...(indexingEnabled ? ['document.update'] : [])],
        [
          '{"schemaVersion":"1.0","operation":"document.save","requestId":"req-2","knowledgeBaseId":"kb-1","input":{"source":{"kind":"text","text":"..."},"title":"...","waitFor":"stored"}}',
          ...(indexingEnabled ? ['{"schemaVersion":"1.0","operation":"document.save","requestId":"req-5","knowledgeBaseId":"kb-1","input":{"source":{"kind":"text","text":"..."},"title":"...","waitFor":"indexed"}}'] : []),
          ...(indexingEnabled ? ['{"schemaVersion":"1.0","operation":"document.save","requestId":"req-8","knowledgeBaseId":"kb-1","input":{"source":{"kind":"url","url":"https://public.example.test/guide.html"},"title":"...","waitFor":"indexed"}}'] : []),
          ...(indexingEnabled && uploadEnabled ? ['{"schemaVersion":"1.0","operation":"document.save","requestId":"req-9","knowledgeBaseId":"kb-1","input":{"source":{"kind":"upload","uploadId":"upload-id-from-POST-v1-uploads"},"title":"...","waitFor":"indexed"}}'] : []),
          '{"schemaVersion":"1.0","operation":"document.list","requestId":"req-3","knowledgeBaseId":"kb-1","input":{"limit":10}}',
        ],
      ),
      ...(indexingEnabled ? [skill(
        'document-search',
        'Document search',
        'Search indexed, authorized documents and return versioned source references.',
        ['document.search'],
        ['{"schemaVersion":"1.0","operation":"document.search","requestId":"req-4","knowledgeBaseId":"kb-1","input":{"query":"project decisions","topK":10}}'],
      ), skill(
        'document-version-control',
        'Document version control',
        'Update an authorized document with an expected version, or delete it with a version check.',
        ['document.update', 'document.delete'],
        [
          '{"schemaVersion":"1.0","operation":"document.update","requestId":"req-6","knowledgeBaseId":"kb-1","input":{"documentId":"doc-1","expectedVersion":1,"source":{"kind":"text","text":"updated content"},"waitFor":"indexed"}}',
          '{"schemaVersion":"1.0","operation":"document.delete","requestId":"req-7","knowledgeBaseId":"kb-1","input":{"documentId":"doc-1","expectedVersion":2}}',
        ],
      )] : []),
      ...(indexingEnabled && uploadEnabled ? [{
        id: 'document-source-upload',
        name: 'Document source upload',
        description: 'Upload a supported file with POST /v1/uploads?knowledgeBaseId=… and use the returned uploadId as document.save input.source.uploadId. Files are limited to 50 MiB.',
        tags: ['document.upload', 'document.save'],
        examples: ['POST /v1/uploads?knowledgeBaseId=kb-1 using multipart/form-data, then send a document.save DataPart with input.source={"kind":"upload","uploadId":"…"}.'],
        inputModes: ['multipart/form-data'],
        outputModes: ['application/json'],
        securityRequirements: [bearerRequirement],
      } satisfies AgentSkill] : []),
      ...(naturalEnabled ? [{
        id: 'natural-language-document-tasks',
        name: 'Natural-language document tasks',
        description: 'Use one text/plain TextPart to ask questions or request authorized knowledge-base and document operations. The agent may ask a clarification question before acting.',
        tags: ['natural-language', 'document', 'knowledge_base'],
        examples: ['Please list my documents in knowledge base kb-1.'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        securityRequirements: [bearerRequirement],
      } satisfies AgentSkill] : []),
    ],
    signatures: [],
  };
}

function requireBearer(runtime: GatewayRuntime): RequestHandler {
  return async (request, response, next) => {
    if (!runtimeIsReady(runtime)) {
      response.status(503).json({ error: { code: 'NOT_READY', message: 'Gateway runtime is not ready' } });
      return;
    }
    const token = parseBearer(request.header('authorization'));
    if (!token) {
      response.set('WWW-Authenticate', 'Bearer').status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Bearer authentication required' } });
      return;
    }
    try {
      const principal = await runtime.backend.authenticate(token);
      if (!principal) {
        response.set('WWW-Authenticate', 'Bearer error="invalid_token"').status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid Bearer token' } });
        return;
      }
      (request as GatewayRequest)[REQUEST_PRINCIPAL] = principal;
      next();
    } catch (error) {
      next(error);
    }
  };
}

async function buildGatewayUser(request: Request): Promise<GatewayUser | User> {
  const gatewayRequest = request as GatewayRequest;
  const principal = gatewayRequest[REQUEST_PRINCIPAL];
  if (!principal) {
    return { get isAuthenticated() { return false; }, get userName() { return ''; } };
  }
  return {
    principal,
    disconnectSignal: gatewayRequest[REQUEST_SIGNAL] ?? new AbortController().signal,
    get isAuthenticated() { return true; },
    get userName() { return `${principal.tenantId}:${principal.id}`; },
  };
}

function buildServerCallContext(options: ServerCallContextBuilderOptions): ServerCallContext {
  const safeHeaders = Object.fromEntries(
    Object.entries(options.headers).filter(([name]) => name.toLowerCase() !== 'authorization'),
  );
  const context = defaultServerCallContextBuilder({ ...options, headers: safeHeaders });
  const user = options.user as GatewayUser | undefined;
  if (user?.principal) context.state.set(PRINCIPAL_STATE_KEY, user.principal);
  if (user?.disconnectSignal) context.state.set(SIGNAL_STATE_KEY, user.disconnectSignal);
  return context;
}

const attachDisconnectSignal: RequestHandler = (request, response, next) => {
  const controller = new AbortController();
  const gatewayRequest = request as GatewayRequest;
  gatewayRequest[REQUEST_SIGNAL] = controller.signal;
  const onClose = () => {
    if (!response.writableEnded) controller.abort(new Error('A2A client disconnected'));
  };
  response.once('close', onClose);
  response.once('finish', () => response.off('close', onClose));
  next();
};

const rejectUnknownJsonRpcFields: RequestHandler = (request, response, next) => {
  if (request.header('A2A-Version') !== '1.0') {
    next();
    return;
  }
  const body = request.body;
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    next();
    return;
  }
  const methodFields = requestFieldSets[body.method];
  if (!methodFields) {
    next();
    return;
  }
  const topLevelUnknown = firstUnknownKey(body, ['jsonrpc', 'id', 'method', 'params']);
  if (topLevelUnknown) {
    sendJsonRpcError(response, body.id, -32600, `Unknown JSON-RPC field: ${topLevelUnknown}`);
    return;
  }
  if (!isRecord(body.params)) {
    next();
    return;
  }
  const paramsUnknown = firstUnknownKey(body.params, methodFields);
  if (paramsUnknown) {
    sendJsonRpcError(response, body.id, -32602, `Unknown ${body.method} parameter: ${paramsUnknown}`);
    return;
  }
  const nestedUnknown = findNestedUnknown(body.method, body.params);
  if (nestedUnknown) {
    sendJsonRpcError(response, body.id, -32602, `Unknown A2A field: ${nestedUnknown}`);
    return;
  }
  next();
};

const requireRpcScope: RequestHandler = (request, response, next) => {
  if (request.header('A2A-Version') !== '1.0' || !isRecord(request.body)) {
    next();
    return;
  }
  const principal = (request as GatewayRequest)[REQUEST_PRINCIPAL];
  if (!principal) {
    response.set('WWW-Authenticate', 'Bearer').status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Bearer authentication required' } });
    return;
  }
  const scope = rpcRequiredScope(request.body);
  if (scope && !hasScope(principal, scope)) {
    response.set('WWW-Authenticate', 'Bearer error="insufficient_scope"').status(403).json({ error: { code: 'FORBIDDEN', message: 'Insufficient scope' } });
    return;
  }
  next();
};

function findNestedUnknown(method: string, params: JsonRecord): string | undefined {
  if (method === 'SendMessage' || method === 'SendStreamingMessage') {
    if (isRecord(params.message)) {
      const messageUnknown = firstUnknownKey(params.message, ['messageId', 'contextId', 'taskId', 'role', 'parts', 'metadata', 'extensions', 'referenceTaskIds']);
      if (messageUnknown) return `message.${messageUnknown}`;
      if (Array.isArray(params.message.parts)) {
        for (const [index, part] of params.message.parts.entries()) {
          if (!isRecord(part)) continue;
          const partUnknown = firstUnknownKey(part, ['text', 'raw', 'url', 'data', 'mediaType', 'filename', 'metadata']);
          if (partUnknown) return `message.parts[${index}].${partUnknown}`;
          const contentFields = ['text', 'raw', 'url', 'data'].filter((key) => Object.hasOwn(part, key));
          if (contentFields.length !== 1) return `message.parts[${index}] must contain exactly one content field`;
        }
      }
    }
    if (isRecord(params.configuration)) {
      const configUnknown = firstUnknownKey(params.configuration, ['acceptedOutputModes', 'taskPushNotificationConfig', 'historyLength', 'returnImmediately']);
      if (configUnknown) return `configuration.${configUnknown}`;
    }
  }
  return undefined;
}

function rpcRequiredScope(body: JsonRecord): Scope | undefined {
  switch (body.method) {
    case 'GetTask':
    case 'ListTasks':
    case 'SubscribeToTask':
      return 'knowledge:read';
    case 'CancelTask':
      // Cancellation is authorized by the owning runtime against the task's
      // original operation and resources; a blanket write scope rejects
      // read-only principals canceling their own natural-language tasks.
      return undefined;
    case 'SendMessage':
    case 'SendStreamingMessage': {
      const params = isRecord(body.params) ? body.params : undefined;
      const message = params && isRecord(params.message) ? params.message : undefined;
      const parts = message && Array.isArray(message.parts) ? message.parts : undefined;
      const data = parts && isRecord(parts[0]) && isRecord(parts[0].data) ? parts[0].data : undefined;
      return typeof data?.operation === 'string' ? scopeForOperation(data.operation) : undefined;
    }
    default:
      return undefined;
  }
}

function scopeForOperation(operation: string): Scope | undefined {
  switch (operation) {
    case 'knowledge_base.create': return 'knowledge:write';
    case 'knowledge_base.list':
    case 'document.get':
    case 'document.list':
    case 'document.search':
    case 'document.answer': return 'knowledge:read';
    case 'document.save':
    case 'document.update': return 'knowledge:write';
    case 'document.delete': return 'knowledge:delete';
    default: return undefined;
  }
}

function assertScopeForOperation(principal: Principal, operation: DocumentRequest['operation']): void {
  const scope = scopeForOperation(operation);
  if (scope && !hasScope(principal, scope)) throw new DomainError('FORBIDDEN', 'Insufficient scope', 403);
}

function assertScopeForNaturalTask(principal: Principal): void {
  const canUseKnowledge = (['knowledge:read', 'knowledge:write', 'knowledge:delete'] as const)
    .some(scope => hasScope(principal, scope));
  if (!canUseKnowledge) throw new DomainError('FORBIDDEN', 'Natural-language tasks require a knowledge permission', 403);
}

function hasScope(principal: Principal, required: Scope): boolean {
  return principal.scopes.includes(required) || principal.scopes.includes('knowledge:admin');
}

function principalFromContext(context: ServerCallContext): Principal {
  const principal = context.state.get(PRINCIPAL_STATE_KEY);
  if (!isPrincipal(principal)) throw new A2AError({ message: 'Authenticated principal is missing from request context' });
  return principal;
}

function principalFromRequest(request: GatewayRequest): Principal {
  const principal = request[REQUEST_PRINCIPAL];
  if (!principal) throw new DomainError('UNAUTHENTICATED', 'Bearer authentication required', 401);
  return principal;
}

function disconnectSignal(context: ServerCallContext): AbortSignal | undefined {
  const signal = context.state.get(SIGNAL_STATE_KEY);
  return signal instanceof AbortSignal ? signal : undefined;
}

function assertTenantAbsent(tenant: string): void {
  if (tenant) throw invalidParams('This Agent Card does not declare a tenant');
}

function assertTaskPrincipal(task: GatewayTask, principal: Principal): void {
  if (!isSamePrincipal(task.principal, principal)) throw new TaskNotFoundError('Task not found');
}

function requireNaturalRuntime(natural: NaturalTaskRuntime | undefined, lookup = false): NaturalTaskRuntime {
  if (natural) return natural;
  if (lookup) throw new TaskNotFoundError('Task not found');
  throw new UnsupportedOperationError('Natural-language tasks are not enabled on this gateway');
}

function isSamePrincipal(left: Principal, right: Principal): boolean {
  return left.id === right.id && left.tenantId === right.tenantId;
}

function rethrowA2AError(error: unknown, operation: 'submit' | 'task' | 'list' | 'cancel'): never {
  if (error instanceof A2AError) throw error;
  if (error instanceof DomainError) {
    if (operation === 'task' || operation === 'cancel' || operation === 'list') {
      if (error.status === 404 || error.status === 403) throw new TaskNotFoundError('Task not found');
    }
    if (operation === 'cancel' && (error.status === 409 || error.code === 'TASK_NOT_CANCELABLE')) {
      throw new TaskNotCancelableError('Task is not in a cancelable state');
    }
    if (error.code === 'UNSUPPORTED_OPERATION' || error.status === 501) {
      throw new UnsupportedOperationError(error.message);
    }
    if (error.status >= 400 && error.status < 500) {
      throw invalidParams(`${error.code}: ${error.message}`);
    }
  }
  // The SDK logs streaming failures; do not expose backend driver details or credentials there.
  throw new A2AError({ message: 'Internal gateway error' });
}

function invalidParams(message: string): JsonRpcRequestMalformedError {
  return new JsonRpcRequestMalformedError({ message, envelopeCode: -32602 });
}

function validateListTasksRequest(params: ListTasksRequest): void {
  assertNonNegativeInteger(params.historyLength, 'historyLength');
  if (params.pageSize !== undefined && (!Number.isInteger(params.pageSize) || params.pageSize < 1 || params.pageSize > 100)) {
    throw invalidParams('pageSize must be an integer from 1 to 100');
  }
  if (params.statusTimestampAfter && !Number.isFinite(Date.parse(params.statusTimestampAfter))) {
    throw invalidParams('statusTimestampAfter must be an ISO 8601 timestamp');
  }
  if (params.status !== A2ATaskState.TASK_STATE_UNSPECIFIED) stateFromA2A(params.status);
}

function assertNonNegativeInteger(value: number | undefined, name: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
    throw invalidParams(`${name} must be a non-negative integer`);
  }
}

function stateFromA2A(state: A2ATaskStateType): GatewayTask['state'] {
  switch (state) {
    case A2ATaskState.TASK_STATE_SUBMITTED: return 'submitted';
    case A2ATaskState.TASK_STATE_WORKING: return 'working';
    case A2ATaskState.TASK_STATE_INPUT_REQUIRED: return 'input_required';
    case A2ATaskState.TASK_STATE_COMPLETED: return 'completed';
    case A2ATaskState.TASK_STATE_FAILED: return 'failed';
    case A2ATaskState.TASK_STATE_CANCELED: return 'canceled';
    default: throw invalidParams('Unsupported task status filter');
  }
}

function listFilterKey(params: ListTasksRequest): string {
  return JSON.stringify({
    contextId: params.contextId || '',
    status: params.status,
    statusTimestampAfter: params.statusTimestampAfter ?? '',
    pageSize: params.pageSize ?? 50,
    includeArtifacts: params.includeArtifacts === true,
  });
}

function encodePageToken(offset: number, filter: string, principal: Principal, secret: Buffer): string {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    offset,
    filter,
    tenantId: principal.tenantId,
    principalId: principal.id,
    expiresAt: Date.now() + TASK_CURSOR_TTL_MS,
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function decodePageToken(token: string, filter: string, principal: Principal, secret: Buffer): number {
  if (!token) return 0;
  try {
    if (token.length > 2048) throw new Error('invalid');
    const separator = token.indexOf('.');
    if (separator <= 0 || separator !== token.lastIndexOf('.')) throw new Error('invalid');
    const payload = token.slice(0, separator);
    const signatureText = token.slice(separator + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(signatureText) || !/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error('invalid');
    const payloadBytes = Buffer.from(payload, 'base64url');
    if (payloadBytes.toString('base64url') !== payload) throw new Error('invalid');
    const suppliedSignature = Buffer.from(signatureText, 'base64url');
    const expectedSignature = createHmac('sha256', secret).update(payload).digest();
    if (suppliedSignature.toString('base64url') !== signatureText
      || suppliedSignature.byteLength !== expectedSignature.byteLength
      || !timingSafeEqual(suppliedSignature, expectedSignature)) {
      throw new Error('invalid');
    }
    const decoded = JSON.parse(payloadBytes.toString('utf8')) as unknown;
    if (!isRecord(decoded)
      || decoded.version !== 1
      || decoded.filter !== filter
      || decoded.tenantId !== principal.tenantId
      || decoded.principalId !== principal.id
      || !Number.isSafeInteger(decoded.expiresAt)
      || Number(decoded.expiresAt) <= Date.now()
      || !Number.isSafeInteger(decoded.offset)
      || Number(decoded.offset) < 0) {
      throw new Error('invalid');
    }
    return Number(decoded.offset);
  } catch {
    throw invalidParams('Invalid pageToken');
  }
}

function parseBearer(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

function parseContentVersion(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new DomainError('INVALID_VERSION', 'version must be a positive integer', 400);
  }
  const version = Number(value);
  if (!Number.isSafeInteger(version)) throw new DomainError('INVALID_VERSION', 'version must be a positive integer', 400);
  return version;
}

function isInvisibleResource(error: unknown): boolean {
  return error instanceof DomainError && (error.status === 403 || error.status === 404);
}

function isPrincipal(value: unknown): value is Principal {
  return isRecord(value)
    && typeof value.tenantId === 'string'
    && typeof value.id === 'string'
    && Array.isArray(value.scopes)
    && value.scopes.every((scope) => typeof scope === 'string');
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstUnknownKey(value: JsonRecord, allowed: readonly string[]): string | undefined {
  return Object.keys(value).find((key) => !allowed.includes(key));
}

function sendJsonRpcError(response: Response, id: unknown, code: number, message: string): void {
  const validId = id === null || typeof id === 'string' || (typeof id === 'number' && Number.isInteger(id));
  response.status(200).json({
    jsonrpc: '2.0',
    id: validId ? id : null,
    error: { code, message },
  });
}

function sendHttpError(response: Response, status: number, code: string, message: string): void {
  response.status(status).json({ error: { code, message } });
}

function httpErrorHandler(): ErrorRequestHandler {
  return (error: unknown, request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    if (request.originalUrl.startsWith(`${A2A_PATH}`) && isJsonParseError(error)) {
      sendJsonRpcError(response, null, -32700, 'Parse error');
      return;
    }
    if (error instanceof DomainError) {
      const message = error.status >= 500 ? 'Internal server error' : error.message;
      sendHttpError(response, error.status, error.code, message);
      return;
    }
    if (isBodyTooLarge(error)) {
      sendHttpError(response, 413, 'REQUEST_TOO_LARGE', 'Request body exceeds the gateway limit');
      return;
    }
    sendHttpError(response, 500, 'INTERNAL_ERROR', 'Internal server error');
  };
}

function isJsonParseError(error: unknown): boolean {
  return error instanceof SyntaxError && 'status' in error && (error as { status?: unknown }).status === 400;
}

function isBodyTooLarge(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'type' in error && (error as { type?: unknown }).type === 'entity.too.large';
}

function normalizePublicBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('publicBaseUrl must be an absolute HTTP(S) URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('publicBaseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment');
  }
  return url.toString().replace(/\/+$/, '');
}

function runtimeIsReady(runtime: GatewayRuntime): boolean {
  const candidate = runtime as GatewayRuntime & { ready?: boolean };
  return candidate.ready !== false
    && typeof candidate.submit === 'function'
    && typeof candidate.cancel === 'function'
    && typeof candidate.backend?.authenticate === 'function'
    && typeof candidate.backend?.getTask === 'function'
    && typeof candidate.backend?.listTasks === 'function'
    && typeof candidate.backend?.readContent === 'function';
}
