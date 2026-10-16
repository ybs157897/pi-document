import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Activity, AlertTriangle, Ban, CheckCircle2, CircleHelp, Clock3, FileOutput, Hash, RotateCcw, Send, XCircle } from 'lucide-react';
import {
  ApiError, artifactData, artifactText, cancelTask, getPendingRetryRequestId, getPendingTextMessages, getPendingWriteRequests, getTask, listTasks, retryTask, runOperation, runTextMessage, SubmissionUncertainError,
  type OperationRequest,
} from '../api';
import type { A2ATask, BusinessErrorPayload } from '../types';
import { isTaskActive as taskActive, taskStateLabel } from '../types';
import { useWorkspace } from '../App';
import { Alert, Button, CopyButton, EmptyState, LoadingState, PageHeading, StatusPill } from '../components';

const statusFilters = [
  { label: '全部任务', value: '' },
  { label: '处理中', value: 'TASK_STATE_WORKING' },
  { label: '等待补充', value: 'TASK_STATE_INPUT_REQUIRED' },
  { label: '已完成', value: 'TASK_STATE_COMPLETED' },
  { label: '失败', value: 'TASK_STATE_FAILED' },
  { label: '已取消', value: 'TASK_STATE_CANCELED' },
];

export function TasksPage() {
  const { notify, session } = useWorkspace();
  const [tasks, setTasks] = useState<A2ATask[]>([]);
  const [nextPageToken, setNextPageToken] = useState<string | undefined>();
  const [pageToken, setPageToken] = useState<string | undefined>();
  const [totalSize, setTotalSize] = useState(0);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Record<string, string>>({});
  const [actionBusy, setActionBusy] = useState<Record<string, boolean>>({});
  const [clarifications, setClarifications] = useState<Record<string, string>>({});
  const [retryRequestIds, setRetryRequestIds] = useState<Record<string, string>>({});
  const [copyNotice, setCopyNotice] = useState('');
  const [pendingWrites, setPendingWrites] = useState<OperationRequest[]>(() => getPendingWriteRequests());
  const [pendingWriteErrors, setPendingWriteErrors] = useState<Record<string, string>>({});
  const [pendingWriteBusy, setPendingWriteBusy] = useState<Record<string, boolean>>({});
  const [continuationMessageIds, setContinuationMessageIds] = useState<Record<string, string>>(() => Object.fromEntries(getPendingTextMessages().map((item) => [item.taskId, item.messageId])));
  const intervalRef = useRef<number | undefined>(undefined);
  const controllerRef = useRef<AbortController | null>(null);
  const loadSequence = useRef(0);
  const requestGuard = useRef(false);

  const loadPage = useCallback(async (cursor?: string, append = false) => {
    if (append && requestGuard.current) return;
    if (!append) controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++loadSequence.current;
    requestGuard.current = true;
    if (append) setLoadingMore(true); else setLoading(true);
    setError(null);
    try {
      const page = await listTasks({ pageSize: 20, ...(cursor ? { pageToken: cursor } : {}), ...(filter ? { status: filter } : {}), includeArtifacts: true }, controller.signal);
      if (sequence !== loadSequence.current || controller.signal.aborted) return;
      setTasks((current) => {
        if (!append) return page.tasks;
        const seen = new Set(current.map((task) => task.id));
        return [...current, ...page.tasks.filter((task) => !seen.has(task.id))];
      });
      setNextPageToken(page.nextPageToken);
      setTotalSize(page.totalSize);
      setPageToken(cursor);
    } catch (cause) {
      if (sequence === loadSequence.current && !controller.signal.aborted && !(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(cause instanceof Error ? cause.message : '任务列表加载失败。');
        if (cause instanceof ApiError && ([403, 404].includes(cause.status ?? 0) || cause.code === 'SESSION_CHANGED')) setTasks([]);
      }
    } finally {
      if (sequence === loadSequence.current) {
        requestGuard.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filter]);

  useEffect(() => {
    controllerRef.current?.abort();
    loadSequence.current += 1;
    requestGuard.current = false;
    setTasks([]); setPageToken(undefined); setNextPageToken(undefined); setTotalSize(0);
    void loadPage(undefined, false);
    return () => {
      loadSequence.current += 1;
      controllerRef.current?.abort();
    };
  }, [filter, loadPage]);

  useEffect(() => {
    const pending = getPendingTextMessages();
    if (!pending.length) return;
    const visibleIds = new Set(tasks.map((task) => task.id));
    setClarifications((current) => {
      const next = { ...current };
      for (const item of pending) if (visibleIds.has(item.taskId) && !next[item.taskId]) next[item.taskId] = item.text;
      return next;
    });
    setContinuationMessageIds((current) => {
      const next = { ...current };
      for (const item of pending) if (visibleIds.has(item.taskId)) next[item.taskId] = item.messageId;
      return next;
    });
  }, [tasks]);

  const hasActiveTasks = useMemo(() => tasks.some(taskActive), [tasks]);
  useEffect(() => {
    if (!hasActiveTasks) return;
    intervalRef.current = window.setInterval(() => {
      if (requestGuard.current) return;
      void loadPage(pageToken, false);
    }, 1800);
    return () => { if (intervalRef.current) window.clearInterval(intervalRef.current); };
  }, [hasActiveTasks, pageToken, loadPage]);

  async function refreshTask(taskId: string) {
    try {
      const updated = await getTask(taskId);
      setTasks((current) => current.map((task) => task.id === taskId ? updated : task));
      return updated;
    } catch (cause) { throw cause; }
  }

  async function cancel(task: A2ATask) {
    setActionBusy((current) => ({ ...current, [task.id]: true }));
    setActionError((current) => ({ ...current, [task.id]: '' }));
    try {
      const updated = await cancelTask(task.id);
      setTasks((current) => current.map((item) => item.id === task.id ? updated : item));
      notify('取消请求已提交', 'info');
    } catch (cause) {
      setActionError((current) => ({ ...current, [task.id]: cause instanceof Error ? cause.message : '取消失败。' }));
    } finally { setActionBusy((current) => ({ ...current, [task.id]: false })); }
  }

  async function continueNatural(task: A2ATask, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = clarifications[task.id]?.trim();
    if (!text) return;
    setActionBusy((current) => ({ ...current, [task.id]: true }));
    setActionError((current) => ({ ...current, [task.id]: '' }));
    const messageId = continuationMessageIds[task.id] ?? crypto.randomUUID();
    setContinuationMessageIds((current) => ({ ...current, [task.id]: messageId }));
    try {
      const updated = await runTextMessage(text, {
        task,
        messageId,
        onAccepted: () => setContinuationMessageIds((current) => { const { [task.id]: _removed, ...rest } = current; return rest; }),
        onUpdate: (value) => setTasks((items) => items.map((item) => item.id === task.id ? value : item)),
      });
      setTasks((items) => items.map((item) => item.id === task.id ? updated : item));
      setClarifications((current) => ({ ...current, [task.id]: '' }));
      notify('补充信息已提交', 'success');
    } catch (cause) {
      if (!(cause instanceof SubmissionUncertainError)) setContinuationMessageIds((current) => { const { [task.id]: _removed, ...rest } = current; return rest; });
      setActionError((current) => ({ ...current, [task.id]: cause instanceof Error ? cause.message : '补充信息提交失败。' }));
    } finally { setActionBusy((current) => ({ ...current, [task.id]: false })); }
  }

  async function retryIndex(task: A2ATask) {
    const requestId = retryRequestIds[task.id] ?? getPendingRetryRequestId(task.id) ?? crypto.randomUUID();
    setRetryRequestIds((current) => ({ ...current, [task.id]: requestId }));
    setActionBusy((current) => ({ ...current, [task.id]: true }));
    setActionError((current) => ({ ...current, [task.id]: '' }));
    try {
      const created = await retryTask(task.id, requestId);
      setRetryRequestIds((current) => { const { [task.id]: _removed, ...rest } = current; return rest; });
      notify(`索引重试任务已创建：${created.taskId}`, 'success');
      await loadPage(undefined, false);
    } catch (cause) {
      if (cause instanceof SubmissionUncertainError) setActionError((current) => ({ ...current, [task.id]: `${cause.message} 请求号 ${requestId} 已保留，请继续用相同请求号重试。` }));
      else {
        setRetryRequestIds((current) => { const { [task.id]: _removed, ...rest } = current; return rest; });
        setActionError((current) => ({ ...current, [task.id]: cause instanceof Error ? cause.message : '索引重试失败。' }));
      }
    } finally { setActionBusy((current) => ({ ...current, [task.id]: false })); }
  }

  async function retryPendingWrite(request: OperationRequest) {
    setPendingWriteBusy((current) => ({ ...current, [request.requestId]: true }));
    setPendingWriteErrors((current) => ({ ...current, [request.requestId]: '' }));
    let acceptedTaskId: string | undefined;
    try {
      const { task } = await runOperation(request, {
        onAccepted: (accepted) => {
          acceptedTaskId = accepted.id;
          setPendingWrites((current) => current.filter((item) => item.requestId !== request.requestId));
          notify(`写请求已受理：${accepted.id}`, 'info');
        },
      });
      setPendingWrites((current) => current.filter((item) => item.requestId !== request.requestId));
      await loadPage(undefined, false);
      notify(`任务 ${task.id} 已完成`, 'success');
    } catch (cause) {
      if (!(cause instanceof SubmissionUncertainError)) setPendingWrites((current) => current.filter((item) => item.requestId !== request.requestId));
      setPendingWriteErrors((current) => ({ ...current, [request.requestId]: cause instanceof Error ? cause.message : '请求状态仍未确认。' }));
      if (acceptedTaskId) void loadPage(undefined, false);
    } finally { setPendingWriteBusy((current) => ({ ...current, [request.requestId]: false })); }
  }

  return <div className="page-wrap">
    <PageHeading eyebrow="运行状态" title="任务中心" description="查看文档保存、索引、检索与自然语言任务的真实状态。" actions={<Button variant="quiet" onClick={() => void loadPage(pageToken)} disabled={loading}><span className="button-icon"><RefreshIcon /></span>刷新</Button>} />
    <div className="task-summary-bar"><div><strong>{totalSize}</strong><span>项任务</span></div><p>任务编号在刷新后仍可通过服务端列表恢复。</p></div>
    <div className="task-filters" role="tablist" aria-label="任务状态筛选">
      {statusFilters.map((item) => <button key={item.value || 'all'} type="button" role="tab" aria-selected={filter === item.value} className={filter === item.value ? 'task-filter task-filter--active' : 'task-filter'} onClick={() => setFilter(item.value)}>{item.label}</button>)}
    </div>
    {error && <Alert tone="error" title="任务列表加载失败">{error}<Button size="sm" onClick={() => void loadPage(pageToken)}>重试读取</Button></Alert>}
    {pendingWrites.length > 0 && <section className="pending-write-panel" aria-labelledby="pending-write-heading">
      <div className="pending-write-panel__heading"><div><h2 id="pending-write-heading">待确认的写请求</h2><p>服务尚未返回任务编号。继续提交会沿用原请求号；若服务已接受，会返回同一任务。</p></div><StatusPill label={`${pendingWrites.length} 项`} tone="warning" /></div>
      {pendingWrites.map((request) => <div className="pending-write-row" key={request.requestId}>
        <div><strong>{pendingOperationLabel(request.operation)}</strong><small>{request.knowledgeBaseId ? `知识库 ${request.knowledgeBaseId}` : '服务级操作'}</small><code>{request.requestId}</code></div>
        {pendingWriteErrors[request.requestId] && <span className="pending-write-error">{pendingWriteErrors[request.requestId]}</span>}
        <Button variant="primary" size="sm" onClick={() => void retryPendingWrite(request)} disabled={Boolean(pendingWriteBusy[request.requestId])}>{pendingWriteBusy[request.requestId] ? '正在确认…' : '用原请求号继续'}</Button>
      </div>)}
    </section>}
    {loading && tasks.length === 0 && <section className="panel"><LoadingState label="正在从服务端读取任务…" /></section>}
    {!loading && !error && tasks.length === 0 && <section className="panel"><EmptyState title="没有符合条件的任务" description="保存文档或执行检索后，任务会显示在这里。" icon={<Activity size={24} />} /></section>}
    {tasks.length > 0 && <div className="task-list">
      {tasks.map((task) => <TaskCard
        key={task.id}
        task={task}
        busy={Boolean(actionBusy[task.id])}
        error={actionError[task.id] || ''}
        clarification={clarifications[task.id] ?? ''}
        onClarification={(value) => setClarifications((current) => ({ ...current, [task.id]: value }))}
        retryRequestId={retryRequestIds[task.id] ?? getPendingRetryRequestId(task.id)}
        continuationMessageId={continuationMessageIds[task.id]}
        onCancel={() => void cancel(task)}
        onContinue={(event) => void continueNatural(task, event)}
        onRetry={() => void retryIndex(task)}
        onCopy={setCopyNotice}
        onRefresh={() => void refreshTask(task.id)}
        capabilities={session.capabilities}
      />)}
    </div>}
    {nextPageToken && <div className="table-footer"><Button onClick={() => void loadPage(nextPageToken, true)} disabled={loadingMore}>{loadingMore ? '正在读取…' : '加载更多任务'}</Button></div>}
    {copyNotice && <div className="visually-hidden" role="status">{copyNotice}</div>}
  </div>;
}

function TaskCard({
  task, busy, error, clarification, onClarification, retryRequestId, continuationMessageId, onCancel, onContinue, onRetry, onCopy, onRefresh, capabilities,
}: {
  task: A2ATask;
  busy: boolean;
  error: string;
  clarification: string;
  onClarification: (value: string) => void;
  retryRequestId?: string;
  continuationMessageId?: string;
  onCancel: () => void;
  onContinue: (event: FormEvent<HTMLFormElement>) => void;
  onRetry: () => void;
  onCopy: (message: string) => void;
  onRefresh: () => void;
  capabilities: { indexing: boolean; natural: boolean; uploads: boolean };
}) {
  const isNatural = task.metadata?.naturalLanguage === true;
  const operation = typeof task.metadata?.operation === 'string' ? task.metadata.operation : isNatural ? '自然语言任务' : '文档任务';
  const requestId = typeof task.metadata?.requestId === 'string' ? task.metadata.requestId : undefined;
  const state = task.status.state;
  const active = taskActive(task);
  const data = artifactData(task) as Record<string, unknown> | undefined;
  const businessError = data?.error && typeof data.error === 'object' ? data.error as BusinessErrorPayload : undefined;
  const statusMessage = task.status.message?.parts?.find((part) => typeof part.text === 'string')?.text;
  const textOutput = artifactText(task);
  const canRetryIndex = state === 'TASK_STATE_FAILED'
    && operation === 'document.save'
    && businessError?.retryable === true
    && capabilities.indexing;

  return <article className="task-card">
    <div className="task-card__top">
      <div className="task-card__title"><span className={`task-type-icon task-type-icon--${stateTone(state)}`} aria-hidden="true">{iconForTask(state, isNatural)}</span><div><h2>{operationLabel(operation, isNatural)}</h2><p>{task.status.timestamp ? formatDate(task.status.timestamp) : '提交时间不可用'}</p></div></div>
      <StatusPill label={taskStateLabel(state)} tone={stateTone(state)} dot />
    </div>
    <div className="task-card__ids"><span><Hash size={14} aria-hidden="true" />Task ID</span><code>{task.id}</code><CopyButton value={task.id} label="复制" onCopy={onCopy} />{isNatural && <span className="task-kind-badge">自然语言</span>}</div>
    {requestId && <div className="task-card__ids task-card__ids--secondary"><span>请求号</span><code>{requestId}</code><CopyButton value={requestId} label="复制" onCopy={onCopy} /></div>}
    {(state === 'TASK_STATE_INPUT_REQUIRED' || Boolean(continuationMessageId)) && <div className="clarification-box">
      <div className="clarification-box__label"><CircleHelp size={16} aria-hidden="true" /><strong>{continuationMessageId && state !== 'TASK_STATE_INPUT_REQUIRED' ? '补充请求状态未确认' : '需要补充信息'}</strong></div>
      {statusMessage && <p>{statusMessage}</p>}
      <form onSubmit={onContinue} className="clarification-form"><label htmlFor={`clarification-${task.id}`}>补充说明</label><textarea id={`clarification-${task.id}`} value={clarification} onChange={(event) => onClarification(event.currentTarget.value)} rows={3} placeholder="输入需要补充的内容…" disabled={busy || Boolean(continuationMessageId)} required aria-describedby={continuationMessageId ? `continuation-hint-${task.id}` : undefined} />{continuationMessageId && <p className="field__hint" id={`continuation-hint-${task.id}`}>提交状态未知，文本和消息号已保留。请用同一消息号重试。</p>}<Button type="submit" variant="primary" disabled={busy || !clarification.trim()}>{busy ? '正在提交…' : continuationMessageId ? <><Send size={15} aria-hidden="true" />用原消息号重试</> : <><Send size={15} aria-hidden="true" />继续任务</>}</Button></form>
    </div>}
    {state === 'TASK_STATE_COMPLETED' && textOutput && isNatural && <div className="task-output"><div className="task-output__label"><CheckCircle2 size={16} aria-hidden="true" />任务回复</div><p>{textOutput}</p></div>}
    {businessError && <div className="task-error"><div className="task-error__title"><XCircle size={16} aria-hidden="true" /><strong>{businessError.code}</strong></div><p>{businessError.message}</p><span>{businessError.retryable ? '服务标记为可重试' : '服务未标记为可重试'}</span></div>}
    {error && <Alert tone="error" title="操作没有完成">{error}</Alert>}
    {task.metadata && <details className="task-advanced"><summary>任务详情</summary><dl><div><dt>Context ID</dt><dd><code>{task.contextId}</code></dd></div>{typeof task.metadata.turnNo === 'number' && <div><dt>对话轮次</dt><dd>{task.metadata.turnNo}</dd></div>}{task.artifacts?.length ? <div><dt>结果字段</dt><dd><code>{Object.keys(data ?? {}).join(', ') || 'TextPart'}</code></dd></div> : null}</dl></details>}
    <div className="task-card__actions">
      {active && <Button variant="danger" size="sm" onClick={onCancel} disabled={busy}><Ban size={15} aria-hidden="true" />{busy ? '处理中…' : '取消任务'}</Button>}
      {canRetryIndex && <Button variant="secondary" size="sm" onClick={onRetry} disabled={busy}><RotateCcw size={15} aria-hidden="true" />{busy ? '正在重试…' : retryRequestId ? '用原请求号重试索引' : '重试索引'}</Button>}
      {state === 'TASK_STATE_FAILED' && operation === 'document.save' && businessError && !businessError.retryable && <span className="task-action-hint">此任务未被服务标记为可重试</span>}
      <Button variant="quiet" size="sm" onClick={onRefresh} disabled={busy}><RefreshIcon />刷新状态</Button>
    </div>
  </article>;
}

function operationLabel(operation: string, isNatural: boolean) {
  if (isNatural) return '自然语言任务';
  const labels: Record<string, string> = {
    'document.save': '文档保存 / 索引',
    'document.update': '文档更新',
    'document.delete': '文档删除',
    'document.get': '文档读取',
    'document.list': '文档列表',
    'document.search': '文档检索',
    'knowledge_base.create': '创建知识库',
    'knowledge_base.list': '知识库列表',
    'document.save.retry': '索引重试',
  };
  return labels[operation] ?? operation;
}

function pendingOperationLabel(operation: string) {
  return operationLabel(operation, false);
}

function stateTone(state: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  if (state === 'TASK_STATE_COMPLETED') return 'success';
  if (state === 'TASK_STATE_FAILED') return 'danger';
  if (state === 'TASK_STATE_CANCELED') return 'neutral';
  if (state === 'TASK_STATE_INPUT_REQUIRED') return 'warning';
  if (state === 'TASK_STATE_WORKING') return 'info';
  return 'neutral';
}

function iconForTask(state: string, natural: boolean) {
  if (natural) return <CircleHelp size={17} />;
  if (state === 'TASK_STATE_COMPLETED') return <CheckCircle2 size={17} />;
  if (state === 'TASK_STATE_FAILED') return <XCircle size={17} />;
  if (state === 'TASK_STATE_CANCELED') return <Ban size={17} />;
  if (state === 'TASK_STATE_WORKING') return <Activity size={17} />;
  return <FileOutput size={17} />;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(date);
}

function RefreshIcon() { return <span className="refresh-icon" aria-hidden="true"><Clock3 size={15} /></span>; }
