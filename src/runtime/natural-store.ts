import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { DomainError, type DocumentRequest, type Principal, type Scope } from '../domain/types.js';
import { parseRequest } from '../domain/validation.js';

export type NaturalTaskState = 'submitted' | 'working' | 'input_required' | 'cancel_requested' | 'completed' | 'failed' | 'canceled';
export type NaturalTask = {
  id: string;
  contextId: string;
  principal: Principal;
  state: NaturalTaskState;
  turnNo: number;
  answer: string | null;
  clarification: string | null;
  error: { code: string; message: string } | null;
  fence: number;
  createdAt: string;
  updatedAt: string;
};
export type NaturalTurn = {
  taskId: string;
  tenantId: string;
  principalId: string;
  contextId: string;
  turnNo: number;
  sequenceNo: string;
  messageId: string;
  inputHash: string;
  inputText: string;
  submissionKey: string;
  submissionId: string | null;
  generationTaskId: string | null;
  state: 'queued' | 'working' | 'input_required' | 'completed' | 'failed' | 'canceled';
  modelRequests: number;
  toolCalls: number;
  deadlineAt: string;
  clarificationText: string | null;
};
export type NaturalAction = {
  id: string;
  taskId: string;
  turnNo: number;
  requestId: string;
  request: DocumentRequest;
  state: 'intent' | 'admitted' | 'dispatching' | 'working' | 'completed' | 'failed' | 'canceled';
  childTaskId: string | null;
  result: unknown;
  fence: number;
};
export type NaturalContextClosure = {
  contextId: string;
  closedAt: string;
  closeTaskId: string;
  knowledgeBaseId: string;
  reason: string;
};

type PrincipalRow = { tenant_id: string; principal_id: string; scopes: string[]; revoked_at: Date | null };
type TaskRow = {
  task_id: string; tenant_id: string; principal_id: string; context_id: string;
  current_turn_no: number; state: NaturalTaskState; answer_text: string | null;
  clarification_text: string | null; error_code: string | null; error_message: string | null;
  created_at: Date | string; updated_at: Date | string; principal_scopes?: string[];
  fence: string | number;
};
type TurnRow = {
  tenant_id: string; task_id: string; turn_no: number; sequence_no: string;
  principal_id: string; context_id: string; message_id: string; payload_hash: string;
  input_text: string; submission_key: string; pi_submission_id: string | null;
  pi_generation_task_id: string | null; state: NaturalTurn['state']; model_requests: number;
  tool_calls: number; deadline_at: Date | string;
  clarification_text: string | null;
};
type ActionRow = {
  action_id: string; task_id: string; turn_no: number; principal_id: string; context_id: string; request_id: string;
  request: DocumentRequest | string; state: NaturalAction['state']; child_task_id: string | null;
  result: unknown; fence: string | number;
};
type ContextClosureRow = {
  closed_at: Date | string; close_task_id: string; knowledge_base_id: string; reason: string;
};

export const CLOSED_CONTEXT_ANSWER = 'The document deletion is complete. This conversation is closed; start a new conversation to continue.';

const MAX_QUEUED_TURNS_GLOBAL = 128;
const MAX_QUEUED_TURNS_PER_PRINCIPAL = 32;
const QUEUE_CAPACITY_LOCK = "SELECT pg_advisory_xact_lock(hashtext('pi-document-natural-queue-capacity'))";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function timestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function scopesFromRow(scopes: readonly string[] | undefined): Scope[] {
  const known = new Set<Scope>(['knowledge:read', 'knowledge:write', 'knowledge:delete', 'knowledge:admin']);
  return (scopes ?? []).filter((scope): scope is Scope => known.has(scope as Scope));
}

function mapTask(row: TaskRow): NaturalTask {
  return {
    id: row.task_id,
    contextId: row.context_id,
    principal: { tenantId: row.tenant_id, id: row.principal_id, scopes: scopesFromRow(row.principal_scopes) },
    state: row.state,
    turnNo: Number(row.current_turn_no),
    answer: row.answer_text,
    clarification: row.clarification_text,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? 'Natural-language task failed' } : null,
    fence: Number(row.fence),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapTurn(row: TurnRow): NaturalTurn {
  return {
    taskId: row.task_id,
    tenantId: row.tenant_id,
    principalId: row.principal_id,
    contextId: row.context_id,
    turnNo: Number(row.turn_no),
    sequenceNo: row.sequence_no,
    messageId: row.message_id,
    inputHash: row.payload_hash,
    inputText: row.input_text,
    submissionKey: row.submission_key,
    submissionId: row.pi_submission_id,
    generationTaskId: row.pi_generation_task_id,
    state: row.state,
    modelRequests: Number(row.model_requests),
    toolCalls: Number(row.tool_calls),
    deadlineAt: timestamp(row.deadline_at),
    clarificationText: row.clarification_text,
  };
}

function mapAction(row: ActionRow): NaturalAction {
  return {
    id: row.action_id,
    taskId: row.task_id,
    turnNo: Number(row.turn_no),
    requestId: row.request_id,
    request: typeof row.request === 'string' ? JSON.parse(row.request) as DocumentRequest : row.request,
    state: row.state,
    childTaskId: row.child_task_id,
    result: row.result,
    fence: Number(row.fence),
  };
}

function isSuccessfulDocumentDelete(value: unknown): boolean {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); }
    catch { return false; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  const envelope = parsed as { outcome?: unknown; result?: unknown };
  if (envelope.outcome !== 'succeeded' || !envelope.result || typeof envelope.result !== 'object' || Array.isArray(envelope.result)) return false;
  return (envelope.result as { deleted?: unknown }).deleted === true;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function migrateNaturalTasks(pool: Pool): Promise<void> {
  const sql = await readFile(new URL('../../migrations/004_natural_tasks.sql', import.meta.url), 'utf8');
  await transaction(pool, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pi-document-m4-natural-tasks'))");
    await client.query(sql);
  });
}

export class NaturalTaskStore {
  constructor(readonly pool: Pool, readonly turnTimeoutMs = 120_000) {}

  async ensureContext(principal: Principal, requestedId?: string): Promise<{ contextId: string; owner: Principal }> {
    const contextId = requestedId || randomUUID();
    if (contextId.length > 200 || contextId.trim() !== contextId) throw new DomainError('INVALID_CONTEXT_ID', 'Invalid context id', 400);
    return transaction(this.pool, async client => {
      const current = await this.activePrincipal(client, principal);
      await client.query(
        `INSERT INTO pd_contexts (tenant_id, context_id, principal_id)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, context_id) DO NOTHING`,
        [current.tenantId, contextId, current.id],
      );
      const owner = await client.query<{ principal_id: string }>(
        `SELECT principal_id FROM pd_contexts WHERE tenant_id = $1 AND context_id = $2`,
        [current.tenantId, contextId],
      );
      if (!owner.rows[0] || owner.rows[0].principal_id !== current.id) throw new DomainError('CONTEXT_NOT_FOUND', 'Context not found', 404);
      await client.query(
        `INSERT INTO pd_agent_contexts (tenant_id, context_id, principal_id)
         VALUES ($1, $2, $3) ON CONFLICT (tenant_id, context_id) DO NOTHING`,
        [current.tenantId, contextId, current.id],
      );
      await this.assertContextOpen(client, current, contextId);
      return { contextId, owner: current };
    });
  }

  async getContextClosure(principal: Principal, contextId: string): Promise<NaturalContextClosure | undefined> {
    const current = await this.activePrincipal(this.pool, principal);
    await this.assertContextOwner(this.pool, current, contextId);
    const result = await this.pool.query<ContextClosureRow>(
      `SELECT closed_at, close_task_id, knowledge_base_id, reason
       FROM pd_agent_contexts WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 AND closed_at IS NOT NULL`,
      [current.tenantId, contextId, current.id],
    );
    const row = result.rows[0];
    return row ? {
      contextId,
      closedAt: timestamp(row.closed_at),
      closeTaskId: row.close_task_id,
      knowledgeBaseId: row.knowledge_base_id,
      reason: row.reason,
    } : undefined;
  }

  async admitInitial(principal: Principal, messageId: string, text: string, contextId?: string): Promise<NaturalTask> {
    if (!messageId || messageId.length > 200) throw new DomainError('INVALID_MESSAGE_ID', 'Invalid message id', 400);
    if (!text.trim() || Buffer.byteLength(text, 'utf8') > 262144) throw new DomainError('INVALID_TEXT_INPUT', 'Text input must be non-empty and at most 256 KiB', 400);
    const payloadHash = hash({ text });
    return transaction(this.pool, async client => {
      const current = await this.activePrincipal(client, principal);
      await client.query(QUEUE_CAPACITY_LOCK);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`natural:${current.tenantId}:${current.id}:${messageId}`]);
      const existing = await this.findTurnByMessage(client, current, messageId);
      if (existing) {
        if (existing.inputHash !== payloadHash || (contextId && existing.contextId !== contextId)) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Message id was reused with different input', 409);
        return this.getTaskWithClient(client, current, existing.taskId);
      }
      const selectedContext = contextId || randomUUID();
      if (selectedContext.length > 200 || selectedContext.trim() !== selectedContext) throw new DomainError('INVALID_CONTEXT_ID', 'Invalid context id', 400);
      if (contextId) await this.assertContextOpen(client, current, selectedContext);
      await this.assertQueueCapacity(client, current);
      await client.query(`INSERT INTO pd_contexts (tenant_id, context_id, principal_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, context_id) DO NOTHING`, [current.tenantId, selectedContext, current.id]);
      await this.assertContextOwner(client, current, selectedContext);
      await client.query(`INSERT INTO pd_agent_contexts (tenant_id, context_id, principal_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, context_id) DO NOTHING`, [current.tenantId, selectedContext, current.id]);
      await this.assertContextOpen(client, current, selectedContext);
      const sequence = await this.nextSequence(client, current, selectedContext);
      const taskId = `agt_${randomUUID()}`;
      const submissionKey = `agt-sub-${randomUUID()}`;
      const inserted = await client.query<TaskRow>(
        `INSERT INTO pd_agent_tasks (tenant_id, task_id, principal_id, context_id, current_turn_no, state)
         VALUES ($1, $2, $3, $4, 1, 'submitted') RETURNING *`,
        [current.tenantId, taskId, current.id, selectedContext],
      );
      await client.query(
        `INSERT INTO pd_agent_turns
         (tenant_id, task_id, turn_no, sequence_no, principal_id, context_id, message_id, payload_hash, input_text, submission_key, state, deadline_at)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, 'queued', now() + ($10 * interval '1 millisecond'))`,
        [current.tenantId, taskId, sequence, current.id, selectedContext, messageId, payloadHash, text, submissionKey, this.turnTimeoutMs],
      );
      return mapTask({ ...inserted.rows[0]!, principal_scopes: current.scopes });
    });
  }

  async admitContinuation(principal: Principal, taskId: string, suppliedContextId: string, messageId: string, text: string): Promise<NaturalTask> {
    if (!messageId || messageId.length > 200) throw new DomainError('INVALID_MESSAGE_ID', 'Invalid message id', 400);
    if (!text.trim() || Buffer.byteLength(text, 'utf8') > 262144) throw new DomainError('INVALID_TEXT_INPUT', 'Text input must be non-empty and at most 256 KiB', 400);
    const current = await this.activePrincipal(this.pool, principal);
    return transaction(this.pool, async client => {
      await client.query(QUEUE_CAPACITY_LOCK);
      const context = await client.query<{ closed_at: Date | string | null }>(
        `SELECT closed_at FROM pd_agent_contexts WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 FOR UPDATE`,
        [current.tenantId, suppliedContextId, current.id],
      );
      if (!context.rowCount) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      if (context.rows[0]?.closed_at) {
        throw new DomainError('CONTEXT_CLOSED_REQUIRES_NEW', 'This context is closed; start a new conversation.', 409);
      }
      const taskResult = await client.query<TaskRow>(
        `SELECT t.*, p.scopes AS principal_scopes FROM pd_agent_tasks t
         JOIN pd_principals p ON p.tenant_id = t.tenant_id AND p.principal_id = t.principal_id
         WHERE t.tenant_id = $1 AND t.task_id = $2 AND t.principal_id = $3 FOR UPDATE OF t`,
        [current.tenantId, taskId, current.id],
      );
      const task = taskResult.rows[0];
      if (!task || task.context_id !== suppliedContextId) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      const payloadHash = hash({ text });
      const existing = await this.findTurnByMessage(client, current, messageId);
      if (existing) {
        if (existing.inputHash !== payloadHash || existing.taskId !== taskId || existing.contextId !== suppliedContextId) throw new DomainError('IDEMPOTENCY_CONFLICT', 'Message id was reused with different input', 409);
        return this.getTaskWithClient(client, current, taskId);
      }
      if (task.state !== 'input_required') throw new DomainError('TASK_NOT_INPUT_REQUIRED', 'Task is not waiting for input', 409);
      await this.assertQueueCapacity(client, current);
      const turnNo = Number(task.current_turn_no) + 1;
      const sequence = await this.nextSequence(client, current, suppliedContextId);
      const submissionKey = `agt-sub-${randomUUID()}`;
      await client.query(
        `INSERT INTO pd_agent_turns
         (tenant_id, task_id, turn_no, sequence_no, principal_id, context_id, message_id, payload_hash, input_text, submission_key, state, deadline_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'queued', now() + ($11 * interval '1 millisecond'))`,
        [current.tenantId, taskId, turnNo, sequence, current.id, suppliedContextId, messageId, payloadHash, text, submissionKey, this.turnTimeoutMs],
      );
      await client.query(
        `UPDATE pd_agent_tasks SET current_turn_no = $3, state = 'submitted', answer_text = NULL, clarification_text = NULL,
           error_code = NULL, error_message = NULL, updated_at = now()
         WHERE tenant_id = $1 AND task_id = $2`,
        [current.tenantId, taskId, turnNo],
      );
      return this.getTaskWithClient(client, current, taskId);
    });
  }

  async listRecoverableContexts(): Promise<Array<{ principal: Principal; contextId: string; conversationId: string | null; providerSessionId: string | null }>> {
    const result = await this.pool.query<{
      tenant_id: string; principal_id: string; scopes: string[]; context_id: string;
      pi_conversation_id: string | null; provider_session_id: string | null;
    }>(
      `SELECT DISTINCT c.tenant_id, c.principal_id, p.scopes, c.context_id, c.pi_conversation_id, c.provider_session_id
       FROM pd_agent_contexts c
       JOIN pd_principals p ON p.tenant_id = c.tenant_id AND p.principal_id = c.principal_id
       WHERE p.revoked_at IS NULL AND EXISTS (
         SELECT 1 FROM pd_agent_tasks t WHERE t.tenant_id = c.tenant_id AND t.context_id = c.context_id
           AND t.state IN ('submitted', 'working', 'input_required', 'cancel_requested')
       )`,
    );
    return result.rows.map(row => ({
      principal: { tenantId: row.tenant_id, id: row.principal_id, scopes: scopesFromRow(row.scopes) },
      contextId: row.context_id,
      conversationId: row.pi_conversation_id,
      providerSessionId: row.provider_session_id,
    }));
  }

  async bindConversation(principal: Principal, contextId: string, conversationId: string, providerSessionId: string): Promise<void> {
    const current = await this.activePrincipal(this.pool, principal);
    const result = await this.pool.query(
      `UPDATE pd_agent_contexts SET pi_conversation_id = COALESCE(pi_conversation_id, $4),
         provider_session_id = COALESCE(provider_session_id, $5), updated_at = now()
       WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3
         AND (pi_conversation_id IS NULL OR pi_conversation_id = $4)
         AND (provider_session_id IS NULL OR provider_session_id = $5)`,
      [current.tenantId, contextId, current.id, conversationId, providerSessionId],
    );
    if (result.rowCount !== 1) throw new DomainError('CONTEXT_BINDING_CONFLICT', 'Context is bound to another Pi conversation', 409);
  }

  async claimNext(): Promise<{ task: NaturalTask; turn: NaturalTurn; conversationId: string; providerSessionId: string } | undefined> {
    return transaction(this.pool, async client => {
      const contexts = await client.query<{ tenant_id: string; context_id: string; principal_id: string; pi_conversation_id: string; provider_session_id: string }>(
        `SELECT c.tenant_id, c.context_id, c.principal_id, c.pi_conversation_id, c.provider_session_id
         FROM pd_agent_contexts c JOIN pd_principals p ON p.tenant_id = c.tenant_id AND p.principal_id = c.principal_id
         WHERE p.revoked_at IS NULL AND c.closed_at IS NULL AND c.active_task_id IS NULL
           AND c.pi_conversation_id IS NOT NULL AND c.provider_session_id IS NOT NULL
           AND EXISTS (SELECT 1 FROM pd_agent_turns u WHERE u.tenant_id = c.tenant_id AND u.context_id = c.context_id AND u.state = 'queued')
         ORDER BY c.updated_at, c.tenant_id, c.context_id LIMIT 1 FOR UPDATE OF c SKIP LOCKED`,
      );
      const context = contexts.rows[0];
      if (!context) return undefined;
      const candidate = await client.query<{ task_id: string; turn_no: number }>(
        `SELECT task_id, turn_no FROM pd_agent_turns WHERE tenant_id = $1 AND context_id = $2 AND state = 'queued'
         ORDER BY sequence_no LIMIT 1`,
        [context.tenant_id, context.context_id],
      );
      const next = candidate.rows[0];
      if (!next) return undefined;
      const taskResult = await client.query<{ state: NaturalTaskState }>(
        `SELECT state FROM pd_agent_tasks WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE`,
        [context.tenant_id, next.task_id],
      );
      if (taskResult.rows[0]?.state !== 'submitted') return undefined;
      const turnResult = await client.query<TurnRow>(
        `SELECT * FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 AND state = 'queued' FOR UPDATE`,
        [context.tenant_id, next.task_id, next.turn_no],
      );
      const turnRow = turnResult.rows[0];
      if (!turnRow) return undefined;
      await client.query(
        `UPDATE pd_agent_contexts SET active_task_id = $3, active_turn_no = $4, updated_at = now()
         WHERE tenant_id = $1 AND context_id = $2`,
        [context.tenant_id, context.context_id, turnRow.task_id, turnRow.turn_no],
      );
      await client.query(
        `UPDATE pd_agent_turns SET state = 'working', started_at = COALESCE(started_at, now()),
           deadline_at = now() + ($4 * interval '1 millisecond'), updated_at = now()
         WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`,
        [context.tenant_id, turnRow.task_id, turnRow.turn_no, this.turnTimeoutMs],
      );
      await client.query(
        `UPDATE pd_agent_tasks SET state = 'working', updated_at = now()
         WHERE tenant_id = $1 AND task_id = $2 AND state = 'submitted'`,
        [context.tenant_id, turnRow.task_id],
      );
      const task = await this.getTaskWithClient(client, { tenantId: context.tenant_id, id: context.principal_id, scopes: [] }, turnRow.task_id);
      const refreshed = await client.query<TurnRow>(
        `SELECT * FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`,
        [context.tenant_id, turnRow.task_id, turnRow.turn_no],
      );
      return { task, turn: mapTurn(refreshed.rows[0]!), conversationId: context.pi_conversation_id, providerSessionId: context.provider_session_id };
    });
  }

  async activeTurns(): Promise<Array<{ task: NaturalTask; turn: NaturalTurn; conversationId: string; providerSessionId: string }>> {
    const result = await this.pool.query<{
      task: TaskRow; turn: TurnRow; pi_conversation_id: string; provider_session_id: string;
    }>(
      `SELECT (to_jsonb(t) || jsonb_build_object('principal_scopes', p.scopes)) AS task,
         row_to_json(u) AS turn, c.pi_conversation_id, c.provider_session_id
       FROM pd_agent_contexts c
       JOIN pd_agent_tasks t ON t.tenant_id = c.tenant_id AND t.task_id = c.active_task_id
       JOIN pd_agent_turns u ON u.tenant_id = c.tenant_id AND u.task_id = c.active_task_id AND u.turn_no = c.active_turn_no
       JOIN pd_principals p ON p.tenant_id = t.tenant_id AND p.principal_id = t.principal_id
       WHERE p.revoked_at IS NULL AND t.state = 'working'`,
    );
    return result.rows.map(row => ({
      task: mapTask(row.task),
      turn: mapTurn(row.turn),
      conversationId: row.pi_conversation_id,
      providerSessionId: row.provider_session_id,
    }));
  }

  async setPiSubmission(taskId: string, turnNo: number, submissionId: string, generationTaskId: string): Promise<void> {
    await this.pool.query(
      `UPDATE pd_agent_turns SET pi_submission_id = COALESCE(pi_submission_id, $3),
         pi_generation_task_id = COALESCE(pi_generation_task_id, $4), updated_at = now()
       WHERE task_id = $1 AND turn_no = $2 AND (pi_submission_id IS NULL OR pi_submission_id = $3)
         AND (pi_generation_task_id IS NULL OR pi_generation_task_id = $4)`,
      [taskId, turnNo, submissionId, generationTaskId],
    );
  }

  async setSubmissionId(taskId: string, turnNo: number, submissionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE pd_agent_turns SET pi_submission_id = COALESCE(pi_submission_id, $3), updated_at = now()
       WHERE task_id = $1 AND turn_no = $2 AND (pi_submission_id IS NULL OR pi_submission_id = $3)`,
      [taskId, turnNo, submissionId],
    );
  }

  async setGenerationTaskId(taskId: string, turnNo: number, generationTaskId: string): Promise<void> {
    await this.pool.query(
      `UPDATE pd_agent_turns SET pi_generation_task_id = COALESCE(pi_generation_task_id, $3), updated_at = now()
       WHERE task_id = $1 AND turn_no = $2 AND (pi_generation_task_id IS NULL OR pi_generation_task_id = $3)`,
      [taskId, turnNo, generationTaskId],
    );
  }

  async getTurn(taskId: string, turnNo: number): Promise<NaturalTurn | undefined> {
    const result = await this.pool.query<TurnRow>(`SELECT * FROM pd_agent_turns WHERE task_id = $1 AND turn_no = $2`, [taskId, turnNo]);
    return result.rows[0] ? mapTurn(result.rows[0]) : undefined;
  }

  async requeueBusy(taskId: string, turnNo: number, tenantId: string): Promise<void> {
    await transaction(this.pool, async client => {
      const identity = await client.query<{ context_id: string }>(`SELECT context_id FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`, [tenantId, taskId, turnNo]);
      const contextId = identity.rows[0]?.context_id;
      if (!contextId) return;
      const context = await client.query(`SELECT 1 FROM pd_agent_contexts WHERE tenant_id = $1 AND context_id = $2 FOR UPDATE`, [tenantId, contextId]);
      if (!context.rowCount) return;
      const task = await client.query<{ state: NaturalTaskState }>(`SELECT state FROM pd_agent_tasks WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE`, [tenantId, taskId]);
      if (task.rows[0]?.state !== 'working') return;
      const turn = await client.query<{ state: NaturalTurn['state'] }>(`SELECT state FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 FOR UPDATE`, [tenantId, taskId, turnNo]);
      if (turn.rows[0]?.state !== 'working') return;
      await client.query(`UPDATE pd_agent_turns SET state = 'queued', updated_at = now() WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 AND state = 'working'`, [tenantId, taskId, turnNo]);
      await client.query(`UPDATE pd_agent_tasks SET state = 'submitted', updated_at = now() WHERE tenant_id = $1 AND task_id = $2 AND state = 'working'`, [tenantId, taskId]);
      await client.query(`UPDATE pd_agent_contexts SET active_task_id = NULL, active_turn_no = NULL, updated_at = now() WHERE tenant_id = $1 AND context_id = $2 AND active_task_id = $3 AND active_turn_no = $4`, [tenantId, contextId, taskId, turnNo]);
    });
  }

  async modelRequestGate(providerSessionId: string, limit: number): Promise<'allow' | 'bypass' | 'block'> {
    return transaction(this.pool, async client => {
      const contextResult = await client.query<{
        tenant_id: string; context_id: string; active_task_id: string | null; active_turn_no: number | null;
        closed_at: Date | string | null; revoked_at: Date | null;
      }>(
        `SELECT c.tenant_id, c.context_id, c.active_task_id, c.active_turn_no, c.closed_at, p.revoked_at
         FROM pd_agent_contexts c JOIN pd_principals p ON p.tenant_id = c.tenant_id AND p.principal_id = c.principal_id
         WHERE c.provider_session_id = $1 FOR UPDATE OF c`,
        [providerSessionId],
      );
      const context = contextResult.rows[0];
      if (!context) return 'bypass';
      if (context.revoked_at || context.closed_at) return 'block';
      if (!context.active_task_id || context.active_turn_no === null) {
        const recent = await client.query<{ state: NaturalTaskState }>(
          `SELECT state FROM pd_agent_tasks WHERE tenant_id = $1 AND context_id = $2
           ORDER BY updated_at DESC LIMIT 1`,
          [context.tenant_id, context.context_id],
        );
        return ['submitted', 'input_required', 'cancel_requested'].includes(recent.rows[0]?.state ?? '') ? 'block' : 'bypass';
      }
      const turnResult = await client.query<{ task_state: NaturalTaskState; model_requests: number; deadline_at: Date; clarification_text: string | null }>(
        `SELECT a.state AS task_state, t.model_requests, t.deadline_at, t.clarification_text FROM pd_agent_tasks a
         JOIN pd_agent_turns t ON t.tenant_id = a.tenant_id AND t.task_id = a.task_id AND t.turn_no = $4
         WHERE a.tenant_id = $1 AND a.task_id = $2 AND a.context_id = $3 FOR UPDATE OF a, t`,
        [context.tenant_id, context.active_task_id, context.context_id, context.active_turn_no],
      );
      const turn = turnResult.rows[0];
      if (!turn || turn.task_state !== 'working' || turn.clarification_text || turn.deadline_at.getTime() <= Date.now()) return 'block';
      const current = Number(turn.model_requests);
      if (current >= limit) return 'block';
      const next = current + 1;
      await client.query(
        `UPDATE pd_agent_turns SET model_requests = $4, updated_at = now()
         WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`,
        [context.tenant_id, context.active_task_id, context.active_turn_no, next],
      );
      return 'allow';
    });
  }

  async incrementModelRequest(conversationId: string, limit: number): Promise<{ allowed: boolean; taskId?: string; turnNo?: number }> {
    return transaction(this.pool, async client => {
      const active = await client.query<{ tenant_id: string; task_id: string; turn_no: number; model_requests: number; deadline_at: Date }>(
        `SELECT t.tenant_id, t.task_id, t.turn_no, t.model_requests, t.deadline_at
         FROM pd_agent_contexts c JOIN pd_agent_turns t
           ON t.tenant_id = c.tenant_id AND t.task_id = c.active_task_id AND t.turn_no = c.active_turn_no
         JOIN pd_agent_tasks a ON a.tenant_id = t.tenant_id AND a.task_id = t.task_id
         WHERE c.pi_conversation_id = $1 AND a.state = 'working' AND p.revoked_at IS NULL FOR UPDATE OF a, t`,
        [conversationId],
      );
      const row = active.rows[0];
      if (!row) return { allowed: false };
      if (Date.parse(row.deadline_at.toISOString()) <= Date.now()) return { allowed: false, taskId: row.task_id, turnNo: row.turn_no };
      const count = Number(row.model_requests) + 1;
      await client.query(`UPDATE pd_agent_turns SET model_requests = $4, updated_at = now() WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`, [row.tenant_id, row.task_id, row.turn_no, count]);
      return { allowed: count <= limit, taskId: row.task_id, turnNo: row.turn_no };
    });
  }

  async reserveToolCall(conversationId: string, limit: number): Promise<{ task: NaturalTask; turn: NaturalTurn } | undefined> {
    return transaction(this.pool, async client => {
      const active = await client.query<{ task_id: string; tenant_id: string; principal_id: string; context_id: string; current_turn_no: number; state: NaturalTaskState; answer_text: string | null; clarification_text: string | null; error_code: string | null; error_message: string | null; created_at: Date; updated_at: Date; principal_scopes: string[]; fence: string | number; turn_no: number; sequence_no: string; message_id: string; payload_hash: string; input_text: string; submission_key: string; pi_submission_id: string | null; pi_generation_task_id: string | null; turn_state: NaturalTurn['state']; model_requests: number; tool_calls: number; deadline_at: Date; turn_clarification_text: string | null }>(
        `SELECT a.*, p.scopes AS principal_scopes, t.turn_no, t.sequence_no, t.message_id, t.payload_hash,
           t.input_text, t.submission_key, t.pi_submission_id, t.pi_generation_task_id,
           t.state AS turn_state, t.model_requests, t.tool_calls, t.deadline_at, t.clarification_text AS turn_clarification_text
         FROM pd_agent_contexts c
         JOIN pd_agent_tasks a ON a.tenant_id = c.tenant_id AND a.task_id = c.active_task_id
         JOIN pd_agent_turns t ON t.tenant_id = c.tenant_id AND t.task_id = a.task_id AND t.turn_no = c.active_turn_no
         JOIN pd_principals p ON p.tenant_id = a.tenant_id AND p.principal_id = a.principal_id
         WHERE c.pi_conversation_id = $1 AND a.state = 'working' FOR UPDATE OF a, t`,
        [conversationId],
      );
      const row = active.rows[0];
      if (!row || Number(row.tool_calls) >= limit || row.turn_clarification_text || row.deadline_at.getTime() <= Date.now()) return undefined;
      await client.query(`UPDATE pd_agent_turns SET tool_calls = tool_calls + 1, updated_at = now() WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`, [row.tenant_id, row.task_id, row.turn_no]);
      const { turn_state: state, ...base } = row;
      const taskRow: TaskRow = { ...base, state: row.state, fence: row.fence };
      const turnRow: TurnRow = {
        tenant_id: row.tenant_id, task_id: row.task_id, turn_no: row.turn_no, sequence_no: row.sequence_no,
        principal_id: row.principal_id, context_id: row.context_id, message_id: row.message_id,
        payload_hash: row.payload_hash, input_text: row.input_text, submission_key: row.submission_key,
        pi_submission_id: row.pi_submission_id, pi_generation_task_id: row.pi_generation_task_id,
        state, model_requests: row.model_requests, tool_calls: Number(row.tool_calls) + 1,
        deadline_at: row.deadline_at, clarification_text: row.turn_clarification_text,
      };
      return { task: mapTask(taskRow), turn: mapTurn(turnRow) };
    });
  }

  async createActionIntent(conversationId: string, operation: DocumentRequest['operation'], requestWithoutId: Record<string, unknown>, toolLimit = 20): Promise<NaturalAction> {
    const reservation = await this.reserveToolCall(conversationId, toolLimit);
    if (!reservation) throw new DomainError('NATURAL_TOOL_LIMIT', 'The natural-language tool or turn limit was reached', 429);
    const payloadHash = hash(requestWithoutId);
    return transaction(this.pool, async client => {
      const task = reservation.task;
      const turn = reservation.turn;
      const active = await client.query<{ state: NaturalTaskState; fence: string | number; clarification_text: string | null }>(
        `SELECT a.state, a.fence, t.clarification_text FROM pd_agent_tasks a
         JOIN pd_agent_turns t ON t.tenant_id = a.tenant_id AND t.task_id = a.task_id AND t.turn_no = $3
         WHERE a.tenant_id = $1 AND a.task_id = $2 FOR UPDATE OF a, t`,
        [task.principal.tenantId, task.id, turn.turnNo],
      );
      if (active.rows[0]?.state !== 'working' || active.rows[0]?.clarification_text) {
        throw new DomainError('NATURAL_TASK_NOT_ACTIVE', 'Natural task stopped accepting tools', 409);
      }
      if (Number(active.rows[0].fence) !== task.fence) throw new DomainError('NATURAL_TASK_FENCED', 'Natural task action was fenced', 409);
      const existing = await client.query<ActionRow>(
        `SELECT * FROM pd_agent_actions WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 AND operation = $4 AND payload_hash = $5 FOR UPDATE`,
        [task.principal.tenantId, task.id, turn.turnNo, operation, payloadHash],
      );
      if (existing.rows[0]) return mapAction(existing.rows[0]);
      const requestId = `agt-op-${randomUUID()}`;
      const request = parseRequest({ ...requestWithoutId, requestId });
      const actionId = randomUUID();
      const result = await client.query<ActionRow>(
        `INSERT INTO pd_agent_actions (tenant_id, action_id, task_id, turn_no, principal_id, context_id,
           operation, payload_hash, request_id, request, state, fence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'intent', $11) RETURNING *`,
        [task.principal.tenantId, actionId, task.id, turn.turnNo, task.principal.id, task.contextId,
          operation, payloadHash, requestId, request, task.fence],
      );
      return mapAction(result.rows[0]!);
    });
  }

  async linkChildTask(actionId: string, tenantId: string, childTaskId: string): Promise<{ mayDispatch: boolean; action: NaturalAction }> {
    return transaction(this.pool, async client => {
      const identity = await client.query<{ task_id: string }>(`SELECT task_id FROM pd_agent_actions WHERE tenant_id = $1 AND action_id = $2`, [tenantId, actionId]);
      if (!identity.rows[0]) throw new DomainError('NATURAL_ACTION_NOT_FOUND', 'Natural action not found', 404);
      const taskResult = await client.query<{ principal_id: string; context_id: string; state: NaturalTaskState; fence: string | number }>(
        `SELECT principal_id, context_id, state, fence FROM pd_agent_tasks WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE`,
        [tenantId, identity.rows[0].task_id],
      );
      const parent = taskResult.rows[0];
      if (!parent) throw new DomainError('NATURAL_ACTION_NOT_FOUND', 'Natural action not found', 404);
      const actionResult = await client.query<ActionRow>(
        `SELECT * FROM pd_agent_actions WHERE tenant_id = $1 AND action_id = $2 FOR UPDATE`,
        [tenantId, actionId],
      );
      const row = actionResult.rows[0];
      if (!row) throw new DomainError('NATURAL_ACTION_NOT_FOUND', 'Natural action not found', 404);
      if (row.child_task_id && row.child_task_id !== childTaskId) throw new DomainError('NATURAL_ACTION_CHILD_CONFLICT', 'Natural action was linked to a different domain task', 409);
      await client.query(
        `UPDATE pd_agent_actions SET child_task_id = COALESCE(child_task_id, $3),
           state = CASE WHEN state = 'intent' THEN 'admitted' ELSE state END, updated_at = now()
         WHERE tenant_id = $1 AND action_id = $2`,
        [tenantId, actionId, childTaskId],
      );
      const refreshed = await client.query<ActionRow>(`SELECT * FROM pd_agent_actions WHERE tenant_id = $1 AND action_id = $2`, [tenantId, actionId]);
      const action = mapAction(refreshed.rows[0]!);
      return {
        action,
        mayDispatch: parent.state === 'working' && Number(parent.fence) === Number(action.fence)
          && action.childTaskId === childTaskId && ['admitted', 'dispatching'].includes(action.state),
      };
    });
  }

  async beginDispatch(actionId: string, tenantId: string): Promise<boolean> {
    return transaction(this.pool, async client => {
      const identity = await client.query<{ task_id: string }>(`SELECT task_id FROM pd_agent_actions WHERE tenant_id = $1 AND action_id = $2`, [tenantId, actionId]);
      if (!identity.rows[0]) return false;
      const taskResult = await client.query<{ state: NaturalTaskState; fence: string | number }>(
        `SELECT state, fence FROM pd_agent_tasks WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE`,
        [tenantId, identity.rows[0].task_id],
      );
      const task = taskResult.rows[0];
      const actionResult = await client.query<{ fence: string | number; state: NaturalAction['state'] }>(
        `SELECT fence, state FROM pd_agent_actions WHERE tenant_id = $1 AND action_id = $2 FOR UPDATE`,
        [tenantId, actionId],
      );
      const action = actionResult.rows[0];
      if (!task || !action || task.state !== 'working' || Number(task.fence) !== Number(action.fence)) return false;
      if (action.state === 'dispatching') return true;
      if (action.state !== 'admitted') return false;
      await client.query(`UPDATE pd_agent_actions SET state = 'dispatching', updated_at = now() WHERE tenant_id = $1 AND action_id = $2`, [tenantId, actionId]);
      return true;
    });
  }

  async markAction(actionId: string, tenantId: string, state: NaturalAction['state'], result?: unknown): Promise<void> {
    await transaction(this.pool, async client => {
      const selected = await client.query<ActionRow>(
        `SELECT * FROM pd_agent_actions WHERE tenant_id = $1 AND action_id = $2`, [tenantId, actionId],
      );
      if (!selected.rows[0]) return;
      const initial = mapAction(selected.rows[0]);
      const closesContext = state === 'completed' && initial.request.operation === 'document.delete'
        && Boolean(initial.childTaskId) && typeof initial.request.knowledgeBaseId === 'string'
        && isSuccessfulDocumentDelete(result);
      if (!closesContext) {
        await client.query(
          `UPDATE pd_agent_actions SET state = $3, result = COALESCE($4, result), updated_at = now()
           WHERE tenant_id = $1 AND action_id = $2`,
          [tenantId, actionId, state, result ?? null],
        );
        return;
      }

      const context = await client.query<{ closed_at: Date | string | null }>(
        `SELECT closed_at FROM pd_agent_contexts
         WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 FOR UPDATE`,
        [tenantId, selected.rows[0]!.context_id, selected.rows[0]!.principal_id],
      );
      if (!context.rows[0]) throw new DomainError('NATURAL_CONTEXT_NOT_FOUND', 'The natural-language context is no longer available', 404);
      const parent = await client.query<{ current_turn_no: number }>(
        `SELECT current_turn_no FROM pd_agent_tasks WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE`,
        [tenantId, initial.taskId],
      );
      if (!parent.rows[0]) throw new DomainError('NATURAL_TASK_NOT_FOUND', 'The parent natural-language task is no longer available', 404);
      const turn = await client.query(
        `SELECT 1 FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 FOR UPDATE`,
        [tenantId, initial.taskId, initial.turnNo],
      );
      if (!turn.rowCount) throw new DomainError('NATURAL_TURN_NOT_FOUND', 'The natural-language turn is no longer available', 404);
      const refreshed = await client.query<ActionRow>(
        `SELECT * FROM pd_agent_actions WHERE tenant_id = $1 AND action_id = $2 FOR UPDATE`, [tenantId, actionId],
      );
      if (!refreshed.rows[0]) throw new DomainError('NATURAL_ACTION_NOT_FOUND', 'Natural action not found', 404);
      const action = mapAction(refreshed.rows[0]);
      if (action.request.operation !== 'document.delete' || !action.childTaskId || !isSuccessfulDocumentDelete(result)) {
        await client.query(
          `UPDATE pd_agent_actions SET state = $3, result = COALESCE($4, result), updated_at = now()
           WHERE tenant_id = $1 AND action_id = $2`,
          [tenantId, actionId, state, result ?? null],
        );
        return;
      }

      const knowledgeBaseId = action.request.knowledgeBaseId;
      const safeAnswer = CLOSED_CONTEXT_ANSWER;
      const safeReceipt = {
        schemaVersion: '1.0', operation: 'document.delete', requestId: action.request.requestId,
        outcome: 'succeeded', result: { completed: true },
      };
      await client.query(
        `UPDATE pd_agent_contexts SET closed_at = COALESCE(closed_at, now()),
           close_task_id = COALESCE(close_task_id, $4), knowledge_base_id = COALESCE(knowledge_base_id, $5),
           reason = COALESCE(reason, 'document.delete'), active_task_id = NULL, active_turn_no = NULL, updated_at = now()
         WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3`,
        [tenantId, refreshed.rows[0]!.context_id, refreshed.rows[0]!.principal_id, action.taskId, knowledgeBaseId],
      );
      await client.query(
        `WITH canceled_turns AS (
           UPDATE pd_agent_turns SET state = 'canceled', error_code = 'CONTEXT_CLOSED_REQUIRES_NEW',
             error_message = 'This context was closed; start a new conversation.',
             completed_at = COALESCE(completed_at, now()), updated_at = now()
           WHERE tenant_id = $1 AND context_id = $2 AND state = 'queued'
           RETURNING task_id, turn_no
         )
         UPDATE pd_agent_tasks t SET state = 'canceled', answer_text = NULL, clarification_text = NULL,
           error_code = 'CONTEXT_CLOSED_REQUIRES_NEW',
           error_message = 'This context was closed; start a new conversation.', updated_at = now()
         WHERE t.tenant_id = $1 AND t.state = 'submitted'
           AND EXISTS (
             SELECT 1 FROM canceled_turns u
             WHERE u.task_id = t.task_id AND u.turn_no = t.current_turn_no
           )`,
        [tenantId, refreshed.rows[0]!.context_id],
      );
      await client.query(
        `UPDATE pd_agent_actions SET state = 'completed', result = $3, updated_at = now()
         WHERE tenant_id = $1 AND action_id = $2`,
        [tenantId, actionId, safeReceipt],
      );
      await client.query(
        `UPDATE pd_agent_turns SET state = 'completed', answer_text = $4, clarification_text = NULL,
           error_code = NULL, error_message = NULL, completed_at = COALESCE(completed_at, now()), updated_at = now()
         WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`,
        [tenantId, action.taskId, action.turnNo, safeAnswer],
      );
      await client.query(
        `UPDATE pd_agent_tasks SET state = 'completed', answer_text = $3, clarification_text = NULL,
           error_code = NULL, error_message = NULL, updated_at = now()
         WHERE tenant_id = $1 AND task_id = $2`,
        [tenantId, action.taskId, safeAnswer],
      );
    });
  }

  async requestClarification(conversationId: string, question: string): Promise<NaturalTask> {
    if (!question.trim() || Buffer.byteLength(question, 'utf8') > 8000) throw new DomainError('INVALID_CLARIFICATION', 'Clarification text is empty or too long', 400);
    return transaction(this.pool, async client => {
      const contextResult = await client.query<{ tenant_id: string; context_id: string; principal_id: string; task_id: string | null; turn_no: number | null }>(
        `SELECT tenant_id, context_id, principal_id, active_task_id AS task_id, active_turn_no AS turn_no
         FROM pd_agent_contexts WHERE pi_conversation_id = $1 FOR UPDATE`,
        [conversationId],
      );
      const context = contextResult.rows[0];
      if (!context?.task_id || context.turn_no === null) throw new DomainError('NATURAL_TASK_NOT_ACTIVE', 'No active natural-language task', 409);
      const taskResult = await client.query<{ tenant_id: string; task_id: string; principal_id: string; context_id: string; state: NaturalTaskState }>(
        `SELECT a.tenant_id, a.task_id, a.principal_id, a.context_id, a.state FROM pd_agent_tasks a
         JOIN pd_principals p ON p.tenant_id = a.tenant_id AND p.principal_id = a.principal_id
         WHERE a.tenant_id = $1 AND a.task_id = $2 AND p.revoked_at IS NULL FOR UPDATE OF a`,
        [context.tenant_id, context.task_id],
      );
      const task = taskResult.rows[0];
      if (!task || task.state !== 'working') throw new DomainError('NATURAL_TASK_NOT_ACTIVE', 'No active natural-language task', 409);
      const turnResult = await client.query<{ clarification_text: string | null }>(
        `SELECT clarification_text FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 FOR UPDATE`,
        [context.tenant_id, task.task_id, context.turn_no],
      );
      if (!turnResult.rows[0]) throw new DomainError('NATURAL_TASK_NOT_ACTIVE', 'The active natural-language turn is missing', 409);
      const row = { ...task, turn_clarification_text: turnResult.rows[0]?.clarification_text ?? null, turn_no: context.turn_no };
      if (row.turn_clarification_text) return this.getTaskWithClient(client, { tenantId: row.tenant_id, id: row.principal_id, scopes: [] }, row.task_id);
      const pending = await client.query(
        `SELECT 1 FROM pd_agent_actions WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3
         AND state NOT IN ('completed', 'failed', 'canceled') LIMIT 1`,
        [row.tenant_id, row.task_id, row.turn_no],
      );
      if (pending.rowCount) throw new DomainError('NATURAL_ACTION_IN_FLIGHT', 'Wait for the current document operation before requesting clarification', 409, true);
      await client.query(
        `UPDATE pd_agent_turns SET clarification_text = $4, updated_at = now()
         WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`,
        [row.tenant_id, row.task_id, row.turn_no, question.trim()],
      );
      return this.getTaskWithClient(client, { tenantId: row.tenant_id, id: row.principal_id, scopes: [] }, row.task_id);
    });
  }

  async finishClarification(taskId: string, turnNo: number): Promise<NaturalTask | undefined> {
    return transaction(this.pool, async client => {
      const identity = await client.query<{ tenant_id: string; task_id: string; turn_no: number; principal_id: string; context_id: string }>(
        `SELECT tenant_id, task_id, turn_no, principal_id, context_id FROM pd_agent_turns WHERE task_id = $1 AND turn_no = $2`,
        [taskId, turnNo],
      );
      const turnIdentity = identity.rows[0];
      if (!turnIdentity) return undefined;
      const context = await client.query(`SELECT 1 FROM pd_agent_contexts WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 FOR UPDATE`, [turnIdentity.tenant_id, turnIdentity.context_id, turnIdentity.principal_id]);
      if (!context.rowCount) return undefined;
      const taskResult = await client.query<{ state: NaturalTaskState; current_turn_no: number }>(
        `SELECT state, current_turn_no FROM pd_agent_tasks WHERE tenant_id = $1 AND task_id = $2 FOR UPDATE`,
        [turnIdentity.tenant_id, taskId],
      );
      const task = taskResult.rows[0];
      if (!task || task.state !== 'working' || Number(task.current_turn_no) !== turnNo) return undefined;
      const turnResult = await client.query<{ clarification_text: string | null }>(
        `SELECT clarification_text FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 FOR UPDATE`,
        [turnIdentity.tenant_id, taskId, turnNo],
      );
      const question = turnResult.rows[0]?.clarification_text;
      if (!question) return undefined;
      const pending = await client.query(`SELECT 1 FROM pd_agent_actions WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 AND state NOT IN ('completed', 'failed', 'canceled') LIMIT 1`, [turnIdentity.tenant_id, taskId, turnNo]);
      if (pending.rowCount) return undefined;
      await client.query(`UPDATE pd_agent_turns SET state = 'input_required', completed_at = now(), updated_at = now() WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`, [turnIdentity.tenant_id, taskId, turnNo]);
      await client.query(`UPDATE pd_agent_tasks SET state = 'input_required', clarification_text = $3, updated_at = now() WHERE tenant_id = $1 AND task_id = $2`, [turnIdentity.tenant_id, taskId, question]);
      await client.query(`UPDATE pd_agent_contexts SET active_task_id = NULL, active_turn_no = NULL, updated_at = now() WHERE tenant_id = $1 AND context_id = $2 AND active_task_id = $3 AND active_turn_no = $4`, [turnIdentity.tenant_id, turnIdentity.context_id, taskId, turnNo]);
      return this.getTaskWithClient(client, { tenantId: turnIdentity.tenant_id, id: turnIdentity.principal_id, scopes: [] }, taskId);
    });
  }

  async completeTurn(conversationId: string, answer: string): Promise<NaturalTask | undefined> {
    return transaction(this.pool, async client => {
      const result = await client.query<{ tenant_id: string; task_id: string; turn_no: number; principal_id: string; context_id: string; state: NaturalTaskState }>(
        `SELECT c.tenant_id, c.active_task_id AS task_id, c.active_turn_no AS turn_no, a.principal_id, a.context_id, a.state
         FROM pd_agent_contexts c JOIN pd_agent_tasks a ON a.tenant_id = c.tenant_id AND a.task_id = c.active_task_id
         WHERE c.pi_conversation_id = $1 AND c.active_task_id IS NOT NULL FOR UPDATE OF c, a`,
        [conversationId],
      );
      const row = result.rows[0];
      if (!row || row.state !== 'working') return undefined;
      await client.query(`UPDATE pd_agent_tasks SET state = 'completed', answer_text = $3, clarification_text = NULL, updated_at = now() WHERE tenant_id = $1 AND task_id = $2`, [row.tenant_id, row.task_id, answer]);
      await client.query(`UPDATE pd_agent_turns SET state = 'completed', answer_text = $4, completed_at = now(), updated_at = now() WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`, [row.tenant_id, row.task_id, row.turn_no, answer]);
      await client.query(`UPDATE pd_agent_contexts SET active_task_id = NULL, active_turn_no = NULL, updated_at = now() WHERE tenant_id = $1 AND context_id = $2 AND active_task_id = $3 AND active_turn_no = $4`, [row.tenant_id, row.context_id, row.task_id, row.turn_no]);
      return this.getTaskWithClient(client, { tenantId: row.tenant_id, id: row.principal_id, scopes: [] }, row.task_id);
    });
  }

  async failTurn(conversationId: string, code: string, message: string): Promise<void> {
    await transaction(this.pool, async client => {
      const result = await client.query<{ tenant_id: string; task_id: string; turn_no: number; context_id: string }>(
        `SELECT c.tenant_id, c.active_task_id AS task_id, c.active_turn_no AS turn_no, c.context_id
         FROM pd_agent_contexts c JOIN pd_agent_tasks a ON a.tenant_id = c.tenant_id AND a.task_id = c.active_task_id
         WHERE c.pi_conversation_id = $1 AND a.state = 'working' FOR UPDATE OF c, a`,
        [conversationId],
      );
      const row = result.rows[0];
      if (!row) return;
      await client.query(`UPDATE pd_agent_tasks SET state = 'failed', error_code = $3, error_message = $4, updated_at = now() WHERE tenant_id = $1 AND task_id = $2`, [row.tenant_id, row.task_id, code, message]);
      await client.query(`UPDATE pd_agent_turns SET state = 'failed', error_code = $4, error_message = $5, completed_at = now(), updated_at = now() WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3`, [row.tenant_id, row.task_id, row.turn_no, code, message]);
      await client.query(`UPDATE pd_agent_contexts SET active_task_id = NULL, active_turn_no = NULL, updated_at = now() WHERE tenant_id = $1 AND context_id = $2 AND active_task_id = $3 AND active_turn_no = $4`, [row.tenant_id, row.context_id, row.task_id, row.turn_no]);
    });
  }

  async getTask(principal: Principal, taskId: string): Promise<NaturalTask> {
    const current = await this.activePrincipal(this.pool, principal);
    return transaction(this.pool, client => this.getTaskWithClient(client, current, taskId));
  }

  async listTasks(principal: Principal, contextId?: string): Promise<NaturalTask[]> {
    const current = await this.activePrincipal(this.pool, principal);
    if (contextId) await this.assertContextOwner(this.pool, current, contextId);
    const rows = await this.pool.query<TaskRow>(
      `SELECT t.*, p.scopes AS principal_scopes FROM pd_agent_tasks t
       JOIN pd_principals p ON p.tenant_id = t.tenant_id AND p.principal_id = t.principal_id
       WHERE t.tenant_id = $1 AND t.principal_id = $2 AND ($3::text IS NULL OR t.context_id = $3)
       ORDER BY t.created_at, t.task_id`,
      [current.tenantId, current.id, contextId ?? null],
    );
    return rows.rows.map(mapTask);
  }

  async startCancel(principal: Principal, taskId: string, failure?: { code: string; message: string }): Promise<{
    task: NaturalTask; actions: NaturalAction[]; submissionId: string | null; generationTaskId: string | null;
    contextId: string; conversationId: string | null; failureRequested: boolean;
  }> {
    const current = await this.activePrincipal(this.pool, principal);
    return transaction(this.pool, async client => {
      const identity = await client.query<{ context_id: string }>(
        `SELECT context_id FROM pd_agent_tasks WHERE tenant_id = $1 AND principal_id = $2 AND task_id = $3`,
        [current.tenantId, current.id, taskId],
      );
      if (!identity.rows[0]) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      const contextResult = await client.query<{ context_id: string; pi_conversation_id: string | null }>(
        `SELECT context_id, pi_conversation_id FROM pd_agent_contexts
         WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 FOR UPDATE`,
        [current.tenantId, identity.rows[0].context_id, current.id],
      );
      const context = contextResult.rows[0];
      if (!context) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      const taskResult = await client.query<TaskRow>(
        `SELECT a.*, p.scopes AS principal_scopes FROM pd_agent_tasks a
         JOIN pd_principals p ON p.tenant_id = a.tenant_id AND p.principal_id = a.principal_id
         WHERE a.tenant_id = $1 AND a.principal_id = $2 AND a.task_id = $3 FOR UPDATE OF a`,
        [current.tenantId, current.id, taskId],
      );
      const taskRow = taskResult.rows[0];
      if (!taskRow) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      const turnResult = await client.query<{ pi_submission_id: string | null; pi_generation_task_id: string | null }>(
        `SELECT pi_submission_id, pi_generation_task_id FROM pd_agent_turns
         WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 FOR UPDATE`,
        [current.tenantId, taskId, taskRow.current_turn_no],
      );
      if (['completed', 'failed'].includes(taskRow.state)) throw new DomainError('TASK_NOT_CANCELABLE', 'Task is not cancelable', 409);
      if (taskRow.state === 'canceled') {
        return {
          task: mapTask(taskRow), actions: [], submissionId: turnResult.rows[0]?.pi_submission_id ?? null,
          generationTaskId: turnResult.rows[0]?.pi_generation_task_id ?? null, contextId: taskRow.context_id,
          conversationId: context.pi_conversation_id, failureRequested: false,
        };
      }
      if (failure) {
        if (taskRow.state === 'cancel_requested' && taskRow.error_code !== failure.code) {
          return {
            task: mapTask(taskRow), actions: [], submissionId: turnResult.rows[0]?.pi_submission_id ?? null,
            generationTaskId: turnResult.rows[0]?.pi_generation_task_id ?? null, contextId: taskRow.context_id,
            conversationId: context.pi_conversation_id, failureRequested: false,
          };
        }
        if (taskRow.state !== 'cancel_requested') {
          await client.query(
            `UPDATE pd_agent_tasks SET state = 'cancel_requested', fence = fence + 1, error_code = $3, error_message = $4, updated_at = now()
             WHERE tenant_id = $1 AND task_id = $2`,
            [current.tenantId, taskId, failure.code, failure.message],
          );
        }
      } else {
        if (taskRow.state === 'cancel_requested' && taskRow.error_code) throw new DomainError('TASK_NOT_CANCELABLE', 'Task failure is already being finalized', 409);
        if (taskRow.state !== 'cancel_requested') {
          await client.query(
            `UPDATE pd_agent_tasks SET state = 'cancel_requested', fence = fence + 1, updated_at = now()
             WHERE tenant_id = $1 AND task_id = $2`,
            [current.tenantId, taskId],
          );
        }
      }
      const actions = await client.query<ActionRow>(`SELECT * FROM pd_agent_actions WHERE tenant_id = $1 AND task_id = $2 AND state NOT IN ('completed', 'failed', 'canceled') ORDER BY created_at`, [current.tenantId, taskId]);
      const task = await this.getTaskWithClient(client, current, taskId);
      return {
        task,
        actions: actions.rows.map(mapAction),
        submissionId: turnResult.rows[0]?.pi_submission_id ?? null,
        generationTaskId: turnResult.rows[0]?.pi_generation_task_id ?? null,
        contextId: taskRow.context_id,
        conversationId: context.pi_conversation_id,
        failureRequested: failure ? task.state === 'cancel_requested' && task.error?.code === failure.code : false,
      };
    });
  }

  async finalizeCancel(principal: Principal, taskId: string): Promise<NaturalTask> {
    const current = await this.activePrincipal(this.pool, principal);
    return transaction(this.pool, async client => {
      const identity = await client.query<{ context_id: string }>(`SELECT context_id FROM pd_agent_tasks WHERE tenant_id = $1 AND principal_id = $2 AND task_id = $3`, [current.tenantId, current.id, taskId]);
      if (!identity.rows[0]) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      const context = await client.query(`SELECT 1 FROM pd_agent_contexts WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 FOR UPDATE`, [current.tenantId, identity.rows[0].context_id, current.id]);
      if (!context.rowCount) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      const task = await client.query<TaskRow>(`SELECT * FROM pd_agent_tasks WHERE tenant_id = $1 AND principal_id = $2 AND task_id = $3 FOR UPDATE`, [current.tenantId, current.id, taskId]);
      const row = task.rows[0];
      if (!row) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      if (['completed', 'failed', 'canceled'].includes(row.state)) return this.getTaskWithClient(client, current, taskId);
      if (row.state !== 'cancel_requested' || row.error_code) return this.getTaskWithClient(client, current, taskId);
      await client.query(`SELECT 1 FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 FOR UPDATE`, [current.tenantId, taskId, row.current_turn_no]);
      const liveActions = await client.query(`SELECT 1 FROM pd_agent_actions WHERE tenant_id = $1 AND task_id = $2 AND state NOT IN ('completed', 'failed', 'canceled') LIMIT 1`, [current.tenantId, taskId]);
      if (liveActions.rowCount) throw new DomainError('CHILD_OPERATIONS_PENDING', 'Natural task still has active child operations', 409, true);
      await client.query(`UPDATE pd_agent_tasks SET state = 'canceled', error_code = NULL, error_message = NULL, updated_at = now() WHERE tenant_id = $1 AND task_id = $2`, [current.tenantId, taskId]);
      await client.query(`UPDATE pd_agent_turns SET state = 'canceled', completed_at = now(), updated_at = now() WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 AND state IN ('working', 'queued')`, [current.tenantId, taskId, row.current_turn_no]);
      await client.query(`UPDATE pd_agent_contexts SET active_task_id = NULL, active_turn_no = NULL, updated_at = now() WHERE tenant_id = $1 AND context_id = $2 AND active_task_id = $3`, [current.tenantId, row.context_id, taskId]);
      return this.getTaskWithClient(client, current, taskId);
    });
  }

  async finalizeFailure(principal: Principal, taskId: string, code: string, message: string): Promise<NaturalTask> {
    const current = await this.activePrincipal(this.pool, principal);
    return transaction(this.pool, async client => {
      const identity = await client.query<{ context_id: string }>(`SELECT context_id FROM pd_agent_tasks WHERE tenant_id = $1 AND principal_id = $2 AND task_id = $3`, [current.tenantId, current.id, taskId]);
      if (!identity.rows[0]) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      const context = await client.query(`SELECT 1 FROM pd_agent_contexts WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 FOR UPDATE`, [current.tenantId, identity.rows[0].context_id, current.id]);
      if (!context.rowCount) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      const result = await client.query<TaskRow>(`SELECT * FROM pd_agent_tasks WHERE tenant_id = $1 AND principal_id = $2 AND task_id = $3 FOR UPDATE`, [current.tenantId, current.id, taskId]);
      const task = result.rows[0];
      if (!task) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
      if (['completed', 'failed', 'canceled'].includes(task.state)) return this.getTaskWithClient(client, current, taskId);
      if (task.state !== 'cancel_requested' || task.error_code !== code) return this.getTaskWithClient(client, current, taskId);
      await client.query(`SELECT 1 FROM pd_agent_turns WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 FOR UPDATE`, [current.tenantId, taskId, task.current_turn_no]);
      const pending = await client.query(`SELECT 1 FROM pd_agent_actions WHERE tenant_id = $1 AND task_id = $2 AND state NOT IN ('completed', 'failed', 'canceled') LIMIT 1`, [current.tenantId, taskId]);
      if (pending.rowCount) throw new DomainError('CHILD_OPERATIONS_PENDING', 'Natural task still has active child operations', 409, true);
      await client.query(`UPDATE pd_agent_tasks SET state = 'failed', error_code = $3, error_message = $4, updated_at = now() WHERE tenant_id = $1 AND task_id = $2`, [current.tenantId, taskId, code, message]);
      await client.query(`UPDATE pd_agent_turns SET state = 'failed', error_code = $4, error_message = $5, completed_at = now(), updated_at = now() WHERE tenant_id = $1 AND task_id = $2 AND turn_no = $3 AND state IN ('working', 'queued')`, [current.tenantId, taskId, task.current_turn_no, code, message]);
      await client.query(`UPDATE pd_agent_contexts SET active_task_id = NULL, active_turn_no = NULL, updated_at = now() WHERE tenant_id = $1 AND context_id = $2 AND active_task_id = $3`, [current.tenantId, task.context_id, taskId]);
      return this.getTaskWithClient(client, current, taskId);
    });
  }

  async canceledTasks(): Promise<NaturalTask[]> {
    const rows = await this.pool.query<TaskRow>(
      `SELECT t.*, p.scopes AS principal_scopes FROM pd_agent_tasks t
       JOIN pd_principals p ON p.tenant_id = t.tenant_id AND p.principal_id = t.principal_id
       WHERE t.state = 'cancel_requested' AND t.error_code IS NULL AND p.revoked_at IS NULL ORDER BY t.updated_at LIMIT 20`,
    );
    return rows.rows.map(mapTask);
  }

  async failureRequestedTasks(): Promise<NaturalTask[]> {
    const rows = await this.pool.query<TaskRow>(
      `SELECT t.*, p.scopes AS principal_scopes FROM pd_agent_tasks t
       JOIN pd_principals p ON p.tenant_id = t.tenant_id AND p.principal_id = t.principal_id
       WHERE t.state = 'cancel_requested' AND t.error_code IS NOT NULL AND p.revoked_at IS NULL ORDER BY t.updated_at LIMIT 20`,
    );
    return rows.rows.map(mapTask);
  }

  async actionsForTask(principal: Principal, taskId: string): Promise<NaturalAction[]> {
    const current = await this.activePrincipal(this.pool, principal);
    const rows = await this.pool.query<ActionRow>(`SELECT * FROM pd_agent_actions WHERE tenant_id = $1 AND task_id = $2 ORDER BY created_at`, [current.tenantId, taskId]);
    return rows.rows.map(mapAction);
  }

  async actionsForContext(principal: Principal, contextId: string): Promise<NaturalAction[]> {
    const current = await this.activePrincipal(this.pool, principal);
    await this.assertContextOwner(this.pool, current, contextId);
    const rows = await this.pool.query<ActionRow>(
      `SELECT * FROM pd_agent_actions WHERE tenant_id = $1 AND principal_id = $2 AND context_id = $3 ORDER BY created_at`,
      [current.tenantId, current.id, contextId],
    );
    return rows.rows.map(mapAction);
  }

  async markActiveActionsForCancel(taskId: string, tenantId: string): Promise<void> {
    await this.pool.query(
      `UPDATE pd_agent_actions SET state = 'canceled', updated_at = now()
       WHERE tenant_id = $1 AND task_id = $2 AND child_task_id IS NULL AND state = 'intent'
         AND EXISTS (SELECT 1 FROM pd_agent_tasks t WHERE t.tenant_id = $1 AND t.task_id = $2 AND t.state = 'cancel_requested')`,
      [tenantId, taskId],
    );
  }

  async recoverActions(): Promise<Array<{ principal: Principal; task: NaturalTask; action: NaturalAction }>> {
    const rows = await this.pool.query<{ task: TaskRow; action: ActionRow }>(
      `SELECT (to_jsonb(t) || jsonb_build_object('principal_scopes', p.scopes)) AS task, row_to_json(a) AS action
       FROM pd_agent_actions a JOIN pd_agent_tasks t ON t.tenant_id = a.tenant_id AND t.task_id = a.task_id
       JOIN pd_principals p ON p.tenant_id = t.tenant_id AND p.principal_id = t.principal_id
       WHERE t.state IN ('working', 'cancel_requested') AND a.state IN ('intent', 'admitted', 'dispatching', 'working')`,
    );
    return rows.rows.map(row => ({
      task: mapTask(row.task),
      principal: { tenantId: row.task.tenant_id, id: row.task.principal_id, scopes: scopesFromRow(row.task.principal_scopes) },
      action: mapAction(row.action),
    }));
  }

  async getActiveTaskForConversation(conversationId: string): Promise<{ task: NaturalTask; turn: NaturalTurn } | undefined> {
    const result = await this.pool.query<{ task: TaskRow; turn: TurnRow }>(
      `SELECT (to_jsonb(a) || jsonb_build_object('principal_scopes', p.scopes)) AS task, row_to_json(t) AS turn FROM pd_agent_contexts c
       JOIN pd_agent_tasks a ON a.tenant_id = c.tenant_id AND a.task_id = c.active_task_id
       JOIN pd_agent_turns t ON t.tenant_id = c.tenant_id AND t.task_id = c.active_task_id AND t.turn_no = c.active_turn_no
       JOIN pd_principals p ON p.tenant_id = a.tenant_id AND p.principal_id = a.principal_id
       WHERE c.pi_conversation_id = $1 AND p.revoked_at IS NULL AND a.state = 'working'`,
      [conversationId],
    );
    const row = result.rows[0];
    return row ? { task: mapTask(row.task), turn: mapTurn(row.turn) } : undefined;
  }

  async getTaskByConversationTurn(conversationId: string): Promise<{ task: NaturalTask; turn: NaturalTurn } | undefined> {
    return this.getActiveTaskForConversation(conversationId);
  }

  private async nextSequence(client: PoolClient, principal: Principal, contextId: string): Promise<string> {
    const result = await client.query<{ next_sequence: string }>(
      `SELECT next_sequence FROM pd_agent_contexts WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 FOR UPDATE`,
      [principal.tenantId, contextId, principal.id],
    );
    const sequence = result.rows[0]?.next_sequence;
    if (!sequence) throw new DomainError('CONTEXT_NOT_FOUND', 'Context not found', 404);
    await client.query(`UPDATE pd_agent_contexts SET next_sequence = next_sequence + 1, updated_at = now() WHERE tenant_id = $1 AND context_id = $2`, [principal.tenantId, contextId]);
    return sequence;
  }

  private async assertQueueCapacity(client: PoolClient, principal: Principal): Promise<void> {
    const counts = await client.query<{ global_count: number; principal_count: number }>(
      `SELECT count(*) FILTER (WHERE state = 'queued')::int AS global_count,
         count(*) FILTER (WHERE state = 'queued' AND tenant_id = $1 AND principal_id = $2)::int AS principal_count
       FROM pd_agent_turns`,
      [principal.tenantId, principal.id],
    );
    const total = counts.rows[0]?.global_count ?? 0;
    const owned = counts.rows[0]?.principal_count ?? 0;
    if (total >= MAX_QUEUED_TURNS_GLOBAL) throw new DomainError('NATURAL_QUEUE_FULL', 'The natural-language task queue is full.', 429, true);
    if (owned >= MAX_QUEUED_TURNS_PER_PRINCIPAL) throw new DomainError('NATURAL_PRINCIPAL_QUEUE_FULL', 'The natural-language task queue limit was reached for this principal.', 429, true);
  }

  private async findTurnByMessage(client: PoolClient, principal: Principal, messageId: string): Promise<NaturalTurn | undefined> {
    const result = await client.query<TurnRow>(
      `SELECT * FROM pd_agent_turns WHERE tenant_id = $1 AND principal_id = $2 AND message_id = $3 FOR UPDATE`,
      [principal.tenantId, principal.id, messageId],
    );
    return result.rows[0] ? mapTurn(result.rows[0]) : undefined;
  }

  private async getTaskWithClient(client: PoolClient, principal: Principal, taskId: string): Promise<NaturalTask> {
    const result = await client.query<TaskRow>(
      `SELECT t.*, p.scopes AS principal_scopes FROM pd_agent_tasks t
       JOIN pd_principals p ON p.tenant_id = t.tenant_id AND p.principal_id = t.principal_id
       WHERE t.tenant_id = $1 AND t.principal_id = $2 AND t.task_id = $3 AND p.revoked_at IS NULL`,
      [principal.tenantId, principal.id, taskId],
    );
    if (!result.rows[0]) throw new DomainError('TASK_NOT_FOUND', 'Task not found', 404);
    return mapTask(result.rows[0]);
  }

  private async activePrincipal(queryable: Pool | PoolClient, principal: Principal): Promise<Principal> {
    const result = await queryable.query<PrincipalRow>(
      `SELECT tenant_id, principal_id, scopes, revoked_at FROM pd_principals WHERE tenant_id = $1 AND principal_id = $2`,
      [principal.tenantId, principal.id],
    );
    const row = result.rows[0];
    if (!row || row.revoked_at) throw new DomainError('UNAUTHENTICATED', 'The principal is not active', 401);
    return { tenantId: row.tenant_id, id: row.principal_id, scopes: scopesFromRow(row.scopes) };
  }

  private async assertContextOwner(queryable: Pool | PoolClient, principal: Principal, contextId: string): Promise<void> {
    const result = await queryable.query<{ principal_id: string }>(`SELECT principal_id FROM pd_contexts WHERE tenant_id = $1 AND context_id = $2`, [principal.tenantId, contextId]);
    if (!result.rows[0] || result.rows[0].principal_id !== principal.id) throw new DomainError('CONTEXT_NOT_FOUND', 'Context not found', 404);
  }

  private async assertContextOpen(client: PoolClient, principal: Principal, contextId: string): Promise<void> {
    const result = await client.query<{ closed_at: Date | string | null }>(
      `SELECT closed_at FROM pd_agent_contexts
       WHERE tenant_id = $1 AND context_id = $2 AND principal_id = $3 FOR UPDATE`,
      [principal.tenantId, contextId, principal.id],
    );
    if (result.rows[0]?.closed_at) {
      throw new DomainError('CONTEXT_CLOSED_REQUIRES_NEW', 'This context is closed; start a new conversation.', 409);
    }
  }
}
