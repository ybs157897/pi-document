import type { PiDocumentAgentDataPartRequestPlannedContract } from './request.generated.js';

export type DocumentRequest = PiDocumentAgentDataPartRequestPlannedContract;
export type Scope = 'knowledge:read' | 'knowledge:write' | 'knowledge:delete' | 'knowledge:admin';
export type Principal = { tenantId: string; id: string; scopes: Scope[] };
export type TaskState = 'submitted' | 'working' | 'completed' | 'failed' | 'canceled';
export type BusinessResult = {
  schemaVersion: '1.0'; operation: DocumentRequest['operation']; requestId: string;
  outcome: 'succeeded' | 'failed'; result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
};
export type IndexedChunk = {
  ordinal: number; text: string; locator: Record<string, unknown>; lexicalTokens: string[]; embedding: number[];
};
export interface DocumentPipeline {
  readonly profile: { id: string; dimensions: number; version: string };
  parse(bytes: Buffer, mimeType: string, signal: AbortSignal): Promise<{ text: string; chunks: Omit<IndexedChunk, 'embedding'>[]; warnings: string[] }>;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
  tokenize(text: string): string[];
}
export type StoredTask = {
  id: string; contextId: string; principal: Principal; request: DocumentRequest;
  kind: 'operation' | 'ingestion' | 'purge'; parentTaskId: string | null;
  state: TaskState; result: BusinessResult | null;
  piTaskId: number | null; piConversationId: number | null;
  createdAt: string; updatedAt: string;
};
export class DomainError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly retryable = false) { super(message); }
}

export interface DocumentBackend {
  readonly indexingEnabled?: boolean;
  authenticate(token: string): Promise<Principal | undefined>;
  admit(principal: Principal, request: DocumentRequest, contextId?: string): Promise<StoredTask>;
  retryFailedTask?(principal: Principal, originalTaskId: string, requestId: string): Promise<StoredTask>;
  getTask(principal: Principal, id: string): Promise<StoredTask>;
  listTasks(principal: Principal, contextId?: string): Promise<StoredTask[]>;
  listTaskPage?(principal: Principal, input: {
    contextId?: string; states?: string[]; updatedAfter?: string; limit: number; cursor?: string; includeArtifacts?: boolean; includeNatural?: boolean;
  }): Promise<{ taskIds: string[]; nextCursor?: string; totalSize: number }>;
  pendingTasks(): Promise<StoredTask[]>;
  bindTask(id: string, piTaskId: number, piConversationId: number): Promise<void>;
  execute(id: string, signal: AbortSignal, checkpoint?: (step: string) => Promise<void>): Promise<BusinessResult>;
  failTask(id: string, code: string, message: string, retryable: boolean): Promise<BusinessResult>;
  cancel(principal: Principal, id: string): Promise<StoredTask>;
  readContent(principal: Principal, id: string, version?: number): Promise<{ bytes: Buffer; mimeType: string; sha256: string }>;
  createUpload?(principal: Principal, knowledgeBaseId: string, bytes: Buffer, mimeType: string): Promise<{ uploadId: string; sha256: string; size: number; mime: string; expiresAt: string }>;
}

export interface GatewayRuntime {
  backend: DocumentBackend;
  readonly ready?: boolean;
  submit(principal: Principal, request: DocumentRequest, contextId?: string): Promise<StoredTask>;
  cancel(principal: Principal, id: string): Promise<StoredTask>;
}
