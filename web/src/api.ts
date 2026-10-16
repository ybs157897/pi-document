import type {
  A2ATask,
  AdminPrincipal,
  BusinessErrorPayload,
  BusinessResult,
  Capabilities,
  KBMember,
  KnowledgeBase,
  Principal,
  SearchResult,
  SessionInfo,
  TaskPage,
} from './types';

const TOKEN_KEY = 'pi-document.ui.token';
const TASKS_KEY = 'pi-document.ui.recent-tasks';
const PENDING_WRITES_KEY = 'pi-document.ui.pending-writes';
const PENDING_TEXT_KEY = 'pi-document.ui.pending-text';
const RETRY_KEY_PREFIX = 'pi-document.ui.retry.';
const MAX_SAVED_TASKS = 100;
const TASK_STATES = new Set(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING', 'TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']);
let sessionEpoch = 0;

export type RecentTask = {
  id: string;
  contextId: string;
  requestId?: string;
  operation?: string;
  naturalLanguage?: boolean;
  acceptedAt: string;
};

export type PendingTextMessage = { taskId: string; contextId: string; messageId: string; text: string };

export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** A send may have reached the service even when the browser did not receive a response. */
export class SubmissionUncertainError extends Error {
  constructor(readonly requestId: string, message: string) {
    super(message);
    this.name = 'SubmissionUncertainError';
  }
}

export class BusinessTaskError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly taskId: string,
    readonly retryable: boolean,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BusinessTaskError';
  }
}

export type OperationRequest = {
  schemaVersion: '1.0';
  operation: string;
  requestId: string;
  knowledgeBaseId?: string;
  input: Record<string, unknown>;
};

function storedToken(): string | null {
  try { return window.sessionStorage.getItem(TOKEN_KEY); }
  catch { return null; }
}

export function getSessionToken(): string | null { return storedToken(); }

export function getSessionEpoch(): number { return sessionEpoch; }

function assertSession(expectedEpoch: number, expectedToken: string): void {
  if (sessionEpoch !== expectedEpoch || storedToken() !== expectedToken) {
    throw new ApiError('登录身份已变化，请重新打开当前页面。', 'SESSION_CHANGED');
  }
}

function announceUnauthorized(token: string | null, guarded: boolean): void {
  if (guarded && token && storedToken() === token && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('pi-document:unauthorized'));
  }
}

export function saveSessionToken(token: string): void {
  sessionEpoch += 1;
  window.sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearSession(): void {
  sessionEpoch += 1;
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
    window.sessionStorage.removeItem(TASKS_KEY);
    window.sessionStorage.removeItem(PENDING_WRITES_KEY);
    window.sessionStorage.removeItem(PENDING_TEXT_KEY);
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key?.startsWith(RETRY_KEY_PREFIX)) window.sessionStorage.removeItem(key);
    }
  } catch { /* A private browser may disable storage; memory state is still cleared by React. */ }
}

function pendingWrites(): OperationRequest[] {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(PENDING_WRITES_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((request): request is OperationRequest => Boolean(
      request && typeof request.requestId === 'string' && typeof request.operation === 'string' && request.input,
    )) : [];
  } catch { return []; }
}

function writePendingWrites(items: OperationRequest[]): void {
  try { window.sessionStorage.setItem(PENDING_WRITES_KEY, JSON.stringify(items)); } catch { /* In-memory retry remains available while this page is open. */ }
}

export function getPendingWriteRequests(): OperationRequest[] { return pendingWrites(); }

function isWriteOperation(request: OperationRequest): boolean {
  return ['document.save', 'document.update', 'document.delete', 'knowledge_base.create'].includes(request.operation);
}

function rememberPendingWrite(request: OperationRequest): void {
  if (!isWriteOperation(request)) return;
  writePendingWrites([...pendingWrites().filter((item) => item.requestId !== request.requestId), request]);
}

function clearPendingWrite(requestId: string): void {
  writePendingWrites(pendingWrites().filter((item) => item.requestId !== requestId));
}

function pendingTextMessages(): PendingTextMessage[] {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(PENDING_TEXT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is PendingTextMessage => Boolean(
      item && typeof item.taskId === 'string' && typeof item.contextId === 'string' && typeof item.messageId === 'string' && typeof item.text === 'string',
    )) : [];
  } catch { return []; }
}

export function getPendingTextMessages(): PendingTextMessage[] { return pendingTextMessages(); }

function rememberPendingText(message: PendingTextMessage): void {
  const items = [...pendingTextMessages().filter((item) => item.taskId !== message.taskId), message];
  try { window.sessionStorage.setItem(PENDING_TEXT_KEY, JSON.stringify(items)); } catch { /* The in-memory input remains usable during this page session. */ }
}

function clearPendingText(taskId: string): void {
  const items = pendingTextMessages().filter((item) => item.taskId !== taskId);
  try { window.sessionStorage.setItem(PENDING_TEXT_KEY, JSON.stringify(items)); } catch { /* The next successful request still carries its message id. */ }
}

function retryStorageKey(taskId: string): string {
  const token = storedToken() ?? '';
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) hash = Math.imul(hash ^ token.charCodeAt(index), 16777619);
  return `${RETRY_KEY_PREFIX}${(hash >>> 0).toString(16)}.${encodeURIComponent(taskId)}`;
}

function clearPendingRetry(taskId: string): void {
  try { window.sessionStorage.removeItem(retryStorageKey(taskId)); } catch { /* The server task remains authoritative. */ }
}

export function getPendingRetryRequestId(taskId: string): string | undefined {
  try { return window.sessionStorage.getItem(retryStorageKey(taskId)) ?? undefined; } catch { return undefined; }
}

function readRecentTasks(): RecentTask[] {
  try {
    const raw = window.sessionStorage.getItem(TASKS_KEY);
    const value: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(value)
      ? value.filter((item): item is RecentTask => Boolean(item && typeof item.id === 'string' && typeof item.contextId === 'string'))
      : [];
  } catch { return []; }
}

export function getRecentTasks(): RecentTask[] { return readRecentTasks(); }

export function rememberTask(task: A2ATask, extras: Partial<RecentTask> = {}): void {
  const next: RecentTask = {
    id: task.id,
    contextId: task.contextId,
    acceptedAt: new Date().toISOString(),
    ...extras,
  };
  const recent = [next, ...readRecentTasks().filter((item) => item.id !== task.id)].slice(0, MAX_SAVED_TASKS);
  try { window.sessionStorage.setItem(TASKS_KEY, JSON.stringify(recent)); } catch { /* A2A ListTasks remains authoritative. */ }
}

function authHeaders(extra?: HeadersInit, token = storedToken()): Headers {
  const headers = new Headers(extra);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  headers.set('Cache-Control', 'no-store');
  return headers;
}

async function responseJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; }
  catch { throw new ApiError('服务返回了无法读取的响应。', 'INVALID_RESPONSE', response.status); }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function errorFrom(value: unknown, status?: number): ApiError {
  const error = object(object(value).error);
  return new ApiError(
    typeof error.message === 'string' ? error.message : '请求失败，请检查网络后重试。',
    typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : 'REQUEST_FAILED',
    status,
  );
}

async function manage<T>(path: string, init: RequestInit = {}, token = storedToken()): Promise<T> {
  const expectedEpoch = sessionEpoch;
  const guarded = Boolean(token && token === storedToken());
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers: authHeaders(init.headers, token), cache: 'no-store' });
  } catch {
    throw new ApiError('无法连接到当前站点。请检查服务状态后重试。', 'NETWORK_ERROR');
  }
  if (response.status === 401) announceUnauthorized(token, guarded);
  if (guarded) assertSession(expectedEpoch, token!);
  const body = await responseJson(response);
  if (guarded) assertSession(expectedEpoch, token!);
  if (!response.ok) throw errorFrom(body, response.status);
  return body as T;
}

export async function validateToken(token: string): Promise<SessionInfo> {
  const result = await manage<SessionInfo>('/api/manage/me', {}, token);
  if (!result?.principal?.id || !Array.isArray(result.principal.scopes) || !result.capabilities) {
    throw new ApiError('身份接口返回的数据格式不完整。', 'INVALID_IDENTITY');
  }
  return result;
}

export async function getSessionInfo(): Promise<SessionInfo> { return validateToken(storedToken() ?? ''); }

function rpcId(): string { return `ui-${crypto.randomUUID()}`; }

async function rpc(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const token = storedToken();
  if (!token) throw new ApiError('登录状态已失效，请重新连接。', 'UNAUTHENTICATED', 401);
  const expectedEpoch = sessionEpoch;
  assertSession(expectedEpoch, token);
  let response: Response;
  try {
    response = await fetch('/a2a', {
      method: 'POST',
      signal,
      headers: authHeaders({ 'Content-Type': 'application/json', Accept: 'application/json', 'A2A-Version': '1.0' }, token),
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId(), method, params }),
      cache: 'no-store',
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('与服务的连接中断，请稍后重试。', 'NETWORK_ERROR');
  }
  if (response.status === 401) announceUnauthorized(token, true);
  assertSession(expectedEpoch, token);
  const body = await responseJson(response);
  assertSession(expectedEpoch, token);
  if (!response.ok) throw errorFrom(body, response.status);
  const envelope = object(body);
  if (envelope.error) {
    const error = object(envelope.error);
    throw new ApiError(typeof error.message === 'string' ? error.message : 'A2A 请求失败。', String(error.code ?? 'A2A_ERROR'), response.status);
  }
  return envelope.result;
}

function sendParams(request: OperationRequest, messageId = crypto.randomUUID()) {
  return {
    message: {
      messageId,
      role: 'ROLE_USER',
      parts: [{ data: request, mediaType: 'application/json' }],
    },
    configuration: { acceptedOutputModes: ['application/json'], returnImmediately: true },
  };
}

function taskFrom(value: unknown): A2ATask {
  const result = object(value);
  const task = object(result.task ?? result);
  const status = object(task.status);
  if (typeof task.id !== 'string' || !task.id || typeof task.contextId !== 'string' || !task.contextId || typeof status.state !== 'string' || !TASK_STATES.has(status.state)) {
    throw new ApiError('服务没有返回有效的任务编号。', 'INVALID_TASK_RESPONSE');
  }
  return task as unknown as A2ATask;
}

export function makeRequest(operation: string, input: Record<string, unknown>, knowledgeBaseId?: string): OperationRequest {
  return {
    schemaVersion: '1.0',
    operation,
    requestId: crypto.randomUUID(),
    ...(knowledgeBaseId ? { knowledgeBaseId } : {}),
    input,
  };
}

export async function submitOperation(
  request: OperationRequest,
  options: { signal?: AbortSignal; onAccepted?: (task: A2ATask) => void } = {},
): Promise<A2ATask> {
  rememberPendingWrite(request);
  let task: A2ATask;
  try {
    const result = await rpc('SendMessage', sendParams(request), options.signal);
    task = taskFrom(result);
  } catch (error) {
    if (error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.code === 'INVALID_RESPONSE' || error.code === 'INVALID_TASK_RESPONSE' || (error.status ?? 0) >= 500)) {
      throw new SubmissionUncertainError(request.requestId, error.message);
    }
    if (!(error instanceof ApiError)) throw new SubmissionUncertainError(request.requestId, '请求结果未知。请用同一请求号重试，以免产生重复写入。');
    clearPendingWrite(request.requestId);
    throw error;
  }
  clearPendingWrite(request.requestId);
  rememberTask(task, { requestId: request.requestId, operation: request.operation });
  options.onAccepted?.(task);
  return task;
}

export async function getTask(id: string, signal?: AbortSignal): Promise<A2ATask> {
  return taskFrom(await rpc('GetTask', { id }, signal));
}

export async function cancelTask(id: string, signal?: AbortSignal): Promise<A2ATask> {
  return taskFrom(await rpc('CancelTask', { id }, signal));
}

export async function retryTask(taskId: string, requestId: string): Promise<{ taskId: string; contextId: string; retryOfTaskId: string }> {
  let response: Response;
  const token = storedToken();
  if (!token) throw new ApiError('登录状态已失效，请重新连接。', 'UNAUTHENTICATED', 401);
  const expectedEpoch = sessionEpoch;
  assertSession(expectedEpoch, token);
  try { window.sessionStorage.setItem(retryStorageKey(taskId), requestId); } catch { /* The same ID is retained in page state. */ }
  try {
    response = await fetch(`/api/manage/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }, token),
      body: JSON.stringify({ requestId }),
      cache: 'no-store',
    });
  } catch {
    throw new SubmissionUncertainError(requestId, '重试任务的提交状态未知。请使用同一请求号重试。');
  }
  if (response.status === 401) announceUnauthorized(token, true);
  assertSession(expectedEpoch, token);
  let parsed: unknown;
  try { parsed = await responseJson(response); }
  catch (error) {
    if (response.ok || response.status >= 500) throw new SubmissionUncertainError(requestId, '重试任务的提交状态未知。请使用同一请求号重试。');
    clearPendingRetry(taskId);
    throw error;
  }
  const body = object(parsed);
  assertSession(expectedEpoch, token);
  if (!response.ok && response.status >= 500) throw new SubmissionUncertainError(requestId, '重试任务的提交状态未知。请使用同一请求号重试。');
  if (!response.ok) { clearPendingRetry(taskId); throw errorFrom(body, response.status); }
  const result = body as { taskId?: string; contextId?: string; retryOfTaskId?: string };
  if (typeof result.taskId !== 'string' || !result.taskId || typeof result.contextId !== 'string' || !result.contextId || typeof result.retryOfTaskId !== 'string' || !result.retryOfTaskId) {
    throw new SubmissionUncertainError(requestId, '重试接口响应不完整。请使用同一请求号重试。');
  }
  const ref: RecentTask = {
    id: result.taskId,
    contextId: result.contextId,
    requestId,
    operation: 'document.save.retry',
    acceptedAt: new Date().toISOString(),
  };
  const recent = [ref, ...readRecentTasks().filter((item) => item.id !== ref.id)].slice(0, MAX_SAVED_TASKS);
  try { window.sessionStorage.setItem(TASKS_KEY, JSON.stringify(recent)); } catch { /* ListTasks remains authoritative. */ }
  clearPendingRetry(taskId);
  return { taskId: result.taskId, contextId: result.contextId, retryOfTaskId: result.retryOfTaskId };
}

export async function listTasks(input: {
  pageSize?: number;
  pageToken?: string;
  status?: string;
  includeArtifacts?: boolean;
}, signal?: AbortSignal): Promise<TaskPage> {
  const raw = object(await rpc('ListTasks', {
    pageSize: input.pageSize ?? 20,
    includeArtifacts: input.includeArtifacts ?? true,
    ...(input.pageToken ? { pageToken: input.pageToken } : {}),
    ...(input.status ? { status: input.status } : {}),
  }, signal));
  return {
    tasks: Array.isArray(raw.tasks) ? raw.tasks as A2ATask[] : [],
    nextPageToken: typeof raw.nextPageToken === 'string' && raw.nextPageToken ? raw.nextPageToken : undefined,
    pageSize: Number(raw.pageSize ?? input.pageSize ?? 20),
    totalSize: Number(raw.totalSize ?? 0),
  };
}

export function artifactData(task: A2ATask): unknown {
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts ?? []) {
      if (part.mediaType === 'application/json' && part.data !== undefined) return part.data;
    }
  }
  return undefined;
}

export function artifactText(task: A2ATask): string | undefined {
  for (const artifact of task.artifacts ?? []) {
    for (const part of artifact.parts ?? []) if (typeof part.text === 'string') return part.text;
  }
  const message = task.status.message;
  return message?.parts?.find((part) => typeof part.text === 'string')?.text;
}

function resultFromTask<T>(task: A2ATask): BusinessResult<T> {
  const value = object(artifactData(task)) as BusinessResult<T>;
  if (value.outcome === 'failed' || task.status.state === 'TASK_STATE_FAILED') {
    const issue: BusinessErrorPayload = value.error ?? { code: 'TASK_FAILED', message: artifactText(task) ?? '任务执行失败。' };
    throw new BusinessTaskError(issue.message, issue.code, task.id, issue.retryable === true, issue.details);
  }
  if (task.status.state === 'TASK_STATE_CANCELED') {
    throw new BusinessTaskError('任务已取消。', 'CANCELED', task.id, false);
  }
  if (value.outcome !== 'succeeded' || value.result === undefined) {
    throw new ApiError('任务已结束，但没有返回业务结果。', 'MISSING_RESULT');
  }
  return value;
}

export async function waitForResult<T = Record<string, unknown>>(
  initial: A2ATask,
  options: { signal?: AbortSignal; onUpdate?: (task: A2ATask) => void; intervalMs?: number; expectedEpoch?: number } = {},
): Promise<{ task: A2ATask; result: BusinessResult<T> }> {
  const expectedEpoch = options.expectedEpoch ?? sessionEpoch;
  let task = initial;
  const startedAt = Date.now();
  while (task.status.state === 'TASK_STATE_SUBMITTED' || task.status.state === 'TASK_STATE_WORKING') {
    if (sessionEpoch !== expectedEpoch) throw new ApiError('登录身份已变化，已停止读取此任务。', 'SESSION_CHANGED');
    if (Date.now() - startedAt > 15 * 60_000) throw new ApiError(`任务仍在运行（${task.id}），可在任务中心查看进度。`, 'TASK_POLL_TIMEOUT');
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        window.clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        reject(new DOMException('Polling aborted', 'AbortError'));
      };
      const timeout = window.setTimeout(() => {
        options.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, options.intervalMs ?? 700);
      options.signal?.addEventListener('abort', onAbort, { once: true });
    });
    if (sessionEpoch !== expectedEpoch) throw new ApiError('登录身份已变化，已停止读取此任务。', 'SESSION_CHANGED');
    if (options.signal?.aborted) throw new DOMException('Polling aborted', 'AbortError');
    task = await getTask(task.id, options.signal);
    if (sessionEpoch !== expectedEpoch) throw new ApiError('登录身份已变化，已停止读取此任务。', 'SESSION_CHANGED');
    rememberTask(task, { naturalLanguage: task.metadata?.naturalLanguage === true });
    options.onUpdate?.(task);
  }
  return { task, result: resultFromTask<T>(task) };
}

export async function runOperation<T = Record<string, unknown>>(
  request: OperationRequest,
  options: { onAccepted?: (task: A2ATask) => void; onUpdate?: (task: A2ATask) => void; signal?: AbortSignal } = {},
): Promise<{ task: A2ATask; result: BusinessResult<T> }> {
  const expectedEpoch = sessionEpoch;
  const initial = await submitOperation(request, options);
  if (sessionEpoch !== expectedEpoch) throw new ApiError('登录身份已变化，已停止读取此任务。', 'SESSION_CHANGED');
  if (initial.status.state !== 'TASK_STATE_SUBMITTED' && initial.status.state !== 'TASK_STATE_WORKING') {
    return { task: initial, result: resultFromTask<T>(initial) };
  }
  return waitForResult<T>(initial, { ...options, expectedEpoch });
}

export async function runTextMessage(
  text: string,
  options: { task?: Pick<A2ATask, 'id' | 'contextId'>; messageId?: string; onAccepted?: (task: A2ATask) => void; onUpdate?: (task: A2ATask) => void } = {},
): Promise<A2ATask> {
  const expectedEpoch = sessionEpoch;
  const messageId = options.messageId ?? crypto.randomUUID();
  const params = {
    message: {
      messageId,
      role: 'ROLE_USER',
      ...(options.task ? { taskId: options.task.id, contextId: options.task.contextId } : {}),
      parts: [{ text, mediaType: 'text/plain' }],
    },
    configuration: { acceptedOutputModes: ['text/plain'], returnImmediately: true },
  };
  if (options.task) rememberPendingText({ taskId: options.task.id, contextId: options.task.contextId, messageId, text });
  let raw: unknown;
  try { raw = await rpc('SendMessage', params); }
  catch (error) {
    if (error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.code === 'INVALID_RESPONSE' || (error.status ?? 0) >= 500)) throw new SubmissionUncertainError(messageId, error.message);
    if (options.task) clearPendingText(options.task.id);
    throw error;
  }
  if (sessionEpoch !== expectedEpoch) throw new ApiError('登录身份已变化，已停止读取此任务。', 'SESSION_CHANGED');
  let task = taskFrom(raw);
  if (options.task) clearPendingText(options.task.id);
  rememberTask(task, { naturalLanguage: true });
  options.onAccepted?.(task);
  while (task.status.state === 'TASK_STATE_SUBMITTED' || task.status.state === 'TASK_STATE_WORKING') {
    if (sessionEpoch !== expectedEpoch) throw new ApiError('登录身份已变化，已停止读取此任务。', 'SESSION_CHANGED');
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    if (sessionEpoch !== expectedEpoch) throw new ApiError('登录身份已变化，已停止读取此任务。', 'SESSION_CHANGED');
    task = await getTask(task.id);
    if (sessionEpoch !== expectedEpoch) throw new ApiError('登录身份已变化，已停止读取此任务。', 'SESSION_CHANGED');
    rememberTask(task, { naturalLanguage: true });
    options.onUpdate?.(task);
  }
  return task;
}

export async function createUpload(knowledgeBaseId: string, file: File): Promise<{ uploadId: string; sha256: string; size: number; mime: string; expiresAt: string }> {
  const token = storedToken();
  if (!token) throw new ApiError('登录状态已失效，请重新连接。', 'UNAUTHENTICATED', 401);
  const expectedEpoch = sessionEpoch;
  assertSession(expectedEpoch, token);
  const form = new FormData();
  form.append('file', file, file.name);
  let response: Response;
  try {
    response = await fetch(`/v1/uploads?knowledgeBaseId=${encodeURIComponent(knowledgeBaseId)}`, {
      method: 'POST',
      headers: authHeaders(undefined, token),
      body: form,
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('文件上传连接中断。请确认上传是否完成后，再继续保存。', 'UPLOAD_NETWORK_ERROR');
  }
  if (response.status === 401) announceUnauthorized(token, true);
  assertSession(expectedEpoch, token);
  const body = await responseJson(response);
  assertSession(expectedEpoch, token);
  if (!response.ok) throw errorFrom(body, response.status);
  return body as { uploadId: string; sha256: string; size: number; mime: string; expiresAt: string };
}

export async function downloadDocument(documentId: string, version: number, title: string): Promise<void> {
  const path = `/v1/documents/${encodeURIComponent(documentId)}/content?version=${encodeURIComponent(String(version))}`;
  const token = storedToken();
  if (!token) throw new ApiError('登录状态已失效，请重新连接。', 'UNAUTHENTICATED', 401);
  const expectedEpoch = sessionEpoch;
  assertSession(expectedEpoch, token);
  let response: Response;
  try { response = await fetch(path, { headers: authHeaders(undefined, token), cache: 'no-store' }); }
  catch { throw new ApiError('原文件下载失败，请检查网络后重试。', 'DOWNLOAD_NETWORK_ERROR'); }
  if (response.status === 401) announceUnauthorized(token, true);
  assertSession(expectedEpoch, token);
  if (!response.ok) throw errorFrom(await responseJson(response), response.status);
  const blob = await response.blob();
  assertSession(expectedEpoch, token);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const safeTitle = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').trim() || 'document';
  const contentType = response.headers.get('content-type') ?? blob.type;
  const suffix = contentType.includes('pdf') ? '.pdf'
    : contentType.includes('wordprocessingml') ? '.docx'
      : contentType.includes('html') ? '.html'
        : contentType.includes('markdown') ? '.md'
          : contentType.includes('text/plain') ? '.txt' : '';
  anchor.download = suffix && !safeTitle.toLowerCase().endsWith(suffix) ? `${safeTitle}${suffix}` : safeTitle;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readDocumentText(documentId: string, version: number): Promise<{ text: string; mimeType: string; size: number }> {
  const path = `/v1/documents/${encodeURIComponent(documentId)}/content?version=${encodeURIComponent(String(version))}`;
  const token = storedToken();
  if (!token) throw new ApiError('登录状态已失效，请重新连接。', 'UNAUTHENTICATED', 401);
  const expectedEpoch = sessionEpoch;
  assertSession(expectedEpoch, token);
  let response: Response;
  try { response = await fetch(path, { headers: authHeaders(undefined, token), cache: 'no-store' }); }
  catch { throw new ApiError('原文读取失败，请检查网络后重试。', 'SOURCE_READ_NETWORK_ERROR'); }
  if (response.status === 401) announceUnauthorized(token, true);
  assertSession(expectedEpoch, token);
  if (!response.ok) throw errorFrom(await responseJson(response), response.status);
  const blob = await response.blob();
  assertSession(expectedEpoch, token);
  if (blob.size > 262144) throw new ApiError('原文超过 256 KiB。请上传新文件替换，不能将解析预览当作原文编辑。', 'TEXT_SOURCE_TOO_LARGE', 413);
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? blob.type;
  if (mimeType !== 'text/plain' && mimeType !== 'text/markdown') {
    throw new ApiError('当前原文不是可直接编辑的纯文本或 Markdown，请上传新文件替换。', 'TEXT_SOURCE_NOT_EDITABLE', 415);
  }
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(await blob.arrayBuffer()); }
  catch { throw new ApiError('原文不是有效的 UTF-8 文本，请上传新文件替换。', 'TEXT_SOURCE_ENCODING', 415); }
  assertSession(expectedEpoch, token);
  return { text, mimeType, size: blob.size };
}

export async function listKnowledgeBases(input: { cursor?: string; limit?: number } = {}, signal?: AbortSignal): Promise<{ knowledgeBases: KnowledgeBase[]; nextCursor?: string }> {
  const request = makeRequest('knowledge_base.list', { limit: input.limit ?? 20, ...(input.cursor ? { cursor: input.cursor } : {}) });
  const { result } = await runOperation<{ knowledgeBases: KnowledgeBase[]; nextCursor?: string }>(request, { signal });
  return result.result!;
}

export async function listDocuments(knowledgeBaseId: string, input: { cursor?: string; limit?: number } = {}, signal?: AbortSignal) {
  const request = makeRequest('document.list', { limit: input.limit ?? 20, ...(input.cursor ? { cursor: input.cursor } : {}) }, knowledgeBaseId);
  const { result } = await runOperation<{ documents: Array<{ documentId: string; version: number; title: string; indexState: string; tags?: string[] }>; nextCursor?: string }>(request, { signal });
  return result.result!;
}

export async function getDocument(knowledgeBaseId: string, documentId: string, options: { version?: number; cursor?: string; limit?: number } = {}, signal?: AbortSignal) {
  const request = makeRequest('document.get', {
    documentId,
    limit: options.limit ?? 8192,
    ...(options.version === undefined ? {} : { version: options.version }),
    ...(options.cursor ? { cursor: options.cursor } : {}),
  }, knowledgeBaseId);
  const { result } = await runOperation<Record<string, unknown>>(request, { signal });
  return result.result!;
}

export async function searchDocuments(knowledgeBaseId: string, input: {
  query: string;
  topK: number;
  mode: 'hybrid' | 'semantic' | 'keyword';
  filters?: { tags?: string[]; documentIds?: string[]; sourceTypes?: string[] };
}, signal?: AbortSignal): Promise<SearchResult> {
  const request = makeRequest('document.search', {
    query: input.query,
    topK: Math.min(50, Math.max(1, Math.floor(input.topK))),
    mode: input.mode,
    ...(input.filters && Object.values(input.filters).some((values) => values?.length) ? { filters: input.filters } : {}),
  }, knowledgeBaseId);
  const { result } = await runOperation<SearchResult>(request, { signal });
  return result.result!;
}

export const managementApi = {
  principals: () => manage<{ principals: AdminPrincipal[] }>('/api/manage/principals'),
  createPrincipal: (id: string, scopes: string[]) => manage<{ principal: AdminPrincipal; token: string }>('/api/manage/principals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, scopes }),
  }),
  rotatePrincipal: (id: string) => manage<{ token: string }>(`/api/manage/principals/${encodeURIComponent(id)}/rotate`, { method: 'POST' }),
  revokePrincipal: (id: string) => manage<{ principal: { id: string; revoked: boolean } }>(`/api/manage/principals/${encodeURIComponent(id)}/revoke`, { method: 'POST' }),
  members: (knowledgeBaseId: string) => manage<{ members: KBMember[] }>(`/api/manage/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/members`),
  putMember: (knowledgeBaseId: string, principalId: string, scopes: string[]) => manage<{ member: KBMember }>(
    `/api/manage/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/members/${encodeURIComponent(principalId)}`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scopes }) },
  ),
  deleteMember: (knowledgeBaseId: string, principalId: string) => manage<void>(
    `/api/manage/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/members/${encodeURIComponent(principalId)}`,
    { method: 'DELETE' },
  ),
  permissions: (knowledgeBaseId: string) => manage<{ knowledgeBaseId: string; scopes: string[] }>(
    `/api/manage/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/permissions`,
  ),
} satisfies {
  principals: () => Promise<{ principals: AdminPrincipal[] }>;
  createPrincipal: (id: string, scopes: string[]) => Promise<{ principal: AdminPrincipal; token: string }>;
  rotatePrincipal: (id: string) => Promise<{ token: string }>;
  revokePrincipal: (id: string) => Promise<{ principal: { id: string; revoked: boolean } }>;
  members: (knowledgeBaseId: string) => Promise<{ members: KBMember[] }>;
  putMember: (knowledgeBaseId: string, principalId: string, scopes: string[]) => Promise<{ member: KBMember }>;
  deleteMember: (knowledgeBaseId: string, principalId: string) => Promise<void>;
  permissions: (knowledgeBaseId: string) => Promise<{ knowledgeBaseId: string; scopes: string[] }>;
};

export function uploadCapability(capabilities: Capabilities): boolean { return capabilities.uploads; }
export type { Principal, SessionInfo };
