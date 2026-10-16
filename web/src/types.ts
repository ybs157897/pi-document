export type Scope = 'knowledge:read' | 'knowledge:write' | 'knowledge:delete' | 'knowledge:admin';

export type Principal = {
  id: string;
  tenantId: string;
  scopes: Scope[];
  revoked?: boolean;
  createdAt?: string;
};

export type Capabilities = { indexing: boolean; natural: boolean; uploads: boolean };
export type SessionInfo = { principal: Principal; capabilities: Capabilities };

export type KnowledgeBase = { knowledgeBaseId: string; name: string };
export type DocumentRow = {
  documentId: string;
  version: number;
  title: string;
  indexState: 'stored' | 'ready' | 'indexing' | string;
  tags?: string[];
};
export type SearchHit = {
  documentId: string;
  version: number;
  generationId?: string;
  chunkId?: string;
  title: string;
  snippet: string;
  locator: Record<string, unknown>;
  rank: number;
  scoreType: string;
  score: number;
  contentUri: string;
  sourceUri?: string;
};

export type BusinessErrorPayload = { code: string; message: string; retryable?: boolean; details?: Record<string, unknown> };
export type BusinessResult<T = Record<string, unknown>> = {
  schemaVersion: '1.0';
  operation: string;
  requestId: string;
  outcome: 'succeeded' | 'failed';
  result?: T;
  error?: BusinessErrorPayload;
};

export type A2AMessage = {
  role?: string;
  messageId?: string;
  parts?: Array<{ text?: string; data?: unknown; mediaType?: string }>;
};
export type A2ATask = {
  id: string;
  contextId: string;
  status: { state: string; timestamp?: string; message?: A2AMessage };
  artifacts?: Array<{ artifactId?: string; name?: string; parts?: Array<{ data?: unknown; text?: string; mediaType?: string }> }>;
  metadata?: Record<string, unknown>;
};
export type TaskPage = { tasks: A2ATask[]; nextPageToken?: string; pageSize: number; totalSize: number };
export type SearchResult = { query: string; results: SearchHit[]; degraded?: boolean; degradationReason?: string };

export type AdminPrincipal = { id: string; tenantId?: string; scopes: Scope[]; revoked: boolean; createdAt: string };
export type KBMember = { principalId: string; scopes: string[] };

export function hasScope(principal: Principal | undefined, scope: Scope): boolean {
  return Boolean(principal?.scopes.includes(scope));
}

export function isAdmin(principal: Principal | undefined): boolean {
  return hasScope(principal, 'knowledge:admin');
}

export function isTaskActive(task: A2ATask): boolean {
  return task.status.state === 'TASK_STATE_SUBMITTED' || task.status.state === 'TASK_STATE_WORKING';
}

export function taskStateLabel(state: string): string {
  const labels: Record<string, string> = {
    TASK_STATE_SUBMITTED: '已提交',
    TASK_STATE_WORKING: '处理中',
    TASK_STATE_INPUT_REQUIRED: '等待补充',
    TASK_STATE_COMPLETED: '已完成',
    TASK_STATE_FAILED: '失败',
    TASK_STATE_CANCELED: '已取消',
    TASK_STATE_UNSPECIFIED: '未知状态',
  };
  return labels[state] ?? state.replace(/^TASK_STATE_/, '').toLowerCase();
}
