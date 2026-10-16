import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, BookOpenText, CirclePlus, Database, FilePlus2, FolderOpen, RefreshCw, Search } from 'lucide-react';
import { ApiError, BusinessTaskError, getPendingWriteRequests, listDocuments, makeRequest, managementApi, runOperation, SubmissionUncertainError, type OperationRequest } from '../api';
import type { A2ATask, DocumentRow, KnowledgeBase } from '../types';
import { hasScope, isAdmin } from '../types';
import { useWorkspace } from '../App';
import { Alert, Button, Dialog, EmptyState, Field, LoadingState, PageHeading, StatusPill } from '../components';
import { DeleteDocumentDialog, DocumentDetailDialog, DocumentEditorDialog } from '../DocumentDialogs';

export function KnowledgePage() {
  const workspace = useWorkspace();
  const { session, knowledgeBases, knowledgeBasesLoading, knowledgeBasesError, reloadKnowledgeBases, route, navigate, notify } = workspace;
  const kbId = route.knowledgeBaseId;
  const selectedKB = knowledgeBases.find((item) => item.knowledgeBaseId === kbId);
  const admin = isAdmin(session.principal);
  const permissionSequence = useRef(0);
  const permissionKBRef = useRef<string | null>(null);
  const [knowledgeBaseScopes, setKnowledgeBaseScopes] = useState<string[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(Boolean(kbId));
  const [permissionsError, setPermissionsError] = useState<string | null>(null);
  const permissionsReady = Boolean(kbId && !permissionsLoading && !permissionsError && permissionKBRef.current === kbId);
  const canWrite = !kbId ? hasScope(session.principal, 'knowledge:write') : permissionsReady && (admin || (hasScope(session.principal, 'knowledge:write') && knowledgeBaseScopes.includes('knowledge:write')));
  const canDelete = Boolean(permissionsReady && (admin || (hasScope(session.principal, 'knowledge:delete') && knowledgeBaseScopes.includes('knowledge:delete'))));
  const [createKBOpen, setCreateKBOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [selectedDocument, setSelectedDocument] = useState<DocumentRow | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [documentsCursor, setDocumentsCursor] = useState<string | undefined>();
  const [documentsHasMore, setDocumentsHasMore] = useState(false);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsMoreLoading, setDocumentsMoreLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState<string | null>(null);
  const documentController = useRef<AbortController | null>(null);
  const documentSequence = useRef(0);
  const documentLoadingRef = useRef(false);
  const kbIdRef = useRef(kbId);
  kbIdRef.current = kbId;
  const cursorRef = useRef<string | undefined>(undefined);

  const loadDocuments = useCallback(async (append = false) => {
    if (!kbId) return;
    if (permissionKBRef.current !== kbId) return;
    if (append && (documentLoadingRef.current || !cursorRef.current)) return;
    if (!append) documentController.current?.abort();
    const controller = new AbortController();
    documentController.current = controller;
    const sequence = ++documentSequence.current;
    const requestedKB = kbId;
    documentLoadingRef.current = true;
    setDocumentsError(null);
    if (append) setDocumentsMoreLoading(true); else setDocumentsLoading(true);
    try {
      const result = await listDocuments(requestedKB, { limit: 20, ...(append && cursorRef.current ? { cursor: cursorRef.current } : {}) }, controller.signal);
      if (controller.signal.aborted || sequence !== documentSequence.current || kbIdRef.current !== requestedKB) return;
      setDocuments((current) => append ? [...current, ...result.documents] : result.documents);
      cursorRef.current = result.nextCursor;
      setDocumentsCursor(result.nextCursor);
      setDocumentsHasMore(Boolean(result.nextCursor));
    } catch (error) {
      if (sequence === documentSequence.current && kbIdRef.current === requestedKB && !controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        setDocumentsError(error instanceof Error ? error.message : '文档列表加载失败。');
        if ((error instanceof ApiError && [403, 404].includes(error.status ?? 0))
          || (error instanceof BusinessTaskError && ['FORBIDDEN', 'KNOWLEDGE_BASE_NOT_FOUND', 'DOCUMENTS_UNAVAILABLE'].includes(error.code))) {
          setDocuments([]);
          setDocumentsCursor(undefined);
          setDocumentsHasMore(false);
          void reloadKnowledgeBases();
          navigate({ screen: 'knowledge' });
        }
      }
    } finally {
      if (sequence === documentSequence.current && kbIdRef.current === requestedKB) {
        documentLoadingRef.current = false;
        setDocumentsLoading(false);
        setDocumentsMoreLoading(false);
      }
    }
  }, [kbId, admin, reloadKnowledgeBases, navigate]);

  useEffect(() => {
    documentController.current?.abort();
    documentSequence.current += 1;
    documentLoadingRef.current = false;
    if (!kbId) { cursorRef.current = undefined; setDocuments([]); setDocumentsCursor(undefined); setDocumentsHasMore(false); setDocumentsError(null); setDocumentsLoading(false); return; }
    cursorRef.current = undefined;
    setDocuments([]); setDocumentsCursor(undefined); setDocumentsHasMore(false); setDocumentsError(null); setDocumentsLoading(true);
    return () => documentController.current?.abort();
  }, [kbId]);

  useEffect(() => {
    const sequence = ++permissionSequence.current;
    permissionKBRef.current = null;
    setKnowledgeBaseScopes([]);
    setPermissionsError(null);
    if (!kbId) { setPermissionsLoading(false); return; }
    setPermissionsLoading(true);
    void managementApi.permissions(kbId).then((value) => {
      if (sequence === permissionSequence.current) {
        permissionKBRef.current = kbId;
        setKnowledgeBaseScopes(value.scopes);
        if (admin || (hasScope(session.principal, 'knowledge:read') && value.scopes.includes('knowledge:read'))) {
          void loadDocuments(false);
        } else {
          setPermissionsError('当前身份没有读取此知识库的权限。');
          setDocuments([]);
          setDocumentsLoading(false);
        }
      }
    }).catch((cause) => {
      if (sequence !== permissionSequence.current) return;
      setPermissionsError(cause instanceof Error ? cause.message : '知识库权限读取失败。');
      setKnowledgeBaseScopes([]);
      if (cause instanceof ApiError && [403, 404].includes(cause.status ?? 0)) {
        setDocuments([]);
        void reloadKnowledgeBases();
        navigate({ screen: 'knowledge' });
      }
    }).finally(() => {
      if (sequence === permissionSequence.current) setPermissionsLoading(false);
    });
  }, [kbId, admin, session.principal.scopes, reloadKnowledgeBases, navigate, loadDocuments]);

  useEffect(() => {
    if (!kbId || !session.capabilities.indexing || documents.length === 0 || documents.every((item) => item.indexState === 'ready')) return;
    const timer = window.setInterval(() => {
      if (documentLoadingRef.current) return;
      void loadDocuments(false);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [kbId, documents, session.capabilities.indexing, loadDocuments]);

  if (!kbId) return <KnowledgeBaseList
    items={knowledgeBases}
    loading={knowledgeBasesLoading}
    error={knowledgeBasesError}
    onRefresh={reloadKnowledgeBases}
    canWrite={canWrite}
    onCreate={() => setCreateKBOpen(true)}
    onSelect={(item) => navigate({ screen: 'knowledge', knowledgeBaseId: item.knowledgeBaseId })}
    createOpen={createKBOpen}
    onCreateClose={() => setCreateKBOpen(false)}
    onCreated={async (item) => {
      setCreateKBOpen(false);
      await reloadKnowledgeBases();
      navigate({ screen: 'knowledge', knowledgeBaseId: item.knowledgeBaseId });
    }}
  />;

  if (!selectedKB && knowledgeBasesLoading) return <div className="page-wrap"><LoadingState label="正在读取知识库…" /></div>;
  if (!selectedKB) return <div className="page-wrap">
    <PageHeading title="知识库不可用" description="此知识库可能已删除，或当前身份没有访问权限。" actions={<Button onClick={() => navigate({ screen: 'knowledge' })}>返回知识库</Button>} />
    {knowledgeBasesError && <Alert tone="error">{knowledgeBasesError}</Alert>}
  </div>;

  return <div className="page-wrap">
    <PageHeading
      eyebrow="知识库"
      title={selectedKB.name}
      description={<span className="id-line">知识库 ID <code>{selectedKB.knowledgeBaseId}</code></span>}
      actions={<>
        <Button onClick={() => navigate({ screen: 'search', knowledgeBaseId: selectedKB.knowledgeBaseId })}><Search size={16} aria-hidden="true" />检索此知识库</Button>
        {canWrite && <Button variant="primary" onClick={() => setEditorOpen(true)}><FilePlus2 size={16} aria-hidden="true" />添加文档</Button>}
      </>}
    />
    <section className="panel document-panel">
      <div className="panel__header">
        <div><h2>文档</h2><p>显示当前可访问的文档、版本与索引状态。</p></div>
        <div className="panel__header-actions"><Button variant="quiet" size="sm" onClick={() => void loadDocuments(false)} disabled={documentsLoading}><RefreshCw size={15} aria-hidden="true" />刷新</Button><span className="subtle-count">{documents.length}{documentsHasMore ? '+' : ''} 条</span></div>
      </div>
      {permissionsError && <Alert tone="warning" title="无法确认此知识库的访问范围">{permissionsError} 写入和删除入口已隐藏，请刷新列表后重试。</Alert>}
      {permissionsLoading && <div className="inline-loading"><LoadingState label="正在确认此知识库的权限…" /></div>}
      {documentsError && <Alert tone="error" title="列表读取失败"><span>{documentsError}</span><Button size="sm" onClick={() => void loadDocuments(false)}>重试读取</Button></Alert>}
      {documentsLoading && documents.length === 0 && <LoadingState label="正在读取文档列表…" />}
      {!documentsLoading && !documentsError && documents.length === 0 && <EmptyState
        title="这个知识库还没有文档"
        description={canWrite ? '添加文本、上传文件或导入公开网页，内容会保存在此知识库。' : '当前身份可以读取此知识库，尚无可查看文档。'}
        icon={<FolderOpen size={24} />}
        action={canWrite && <Button variant="primary" onClick={() => setEditorOpen(true)}><FilePlus2 size={16} aria-hidden="true" />添加第一份文档</Button>}
      />}
      {documents.length > 0 && <div className="table-scroll" role="region" aria-label="文档列表，可横向滚动" tabIndex={0}>
        <table className="data-table document-table">
          <thead><tr><th scope="col">名称</th><th scope="col">版本</th><th scope="col">标签</th><th scope="col">处理状态</th><th scope="col"><span className="visually-hidden">操作</span></th></tr></thead>
          <tbody>{documents.map((item) => <tr key={item.documentId}>
            <td><button type="button" className="document-title-link" onClick={() => { setSelectedDocument(item); setDetailOpen(true); }}><span className="document-title-link__icon"><BookOpenText size={17} aria-hidden="true" /></span><span><strong>{item.title}</strong><small>{item.documentId}</small></span></button></td>
            <td><span className="version-cell">v{item.version}</span></td>
            <td><div className="tag-list">{item.tags?.length ? item.tags.slice(0, 3).map((tag) => <span key={tag} className="tag-chip">{tag}</span>) : <span className="muted">—</span>}{(item.tags?.length ?? 0) > 3 && <span className="tag-overflow">+{item.tags!.length - 3}</span>}</div></td>
            <td><StatusPill label={item.indexState === 'ready' ? '已索引' : item.indexState === 'indexing' ? '索引中' : '已存储'} tone={item.indexState === 'ready' ? 'success' : item.indexState === 'indexing' ? 'info' : 'warning'} dot /></td>
            <td><div className="row-actions"><Button size="sm" onClick={() => { setSelectedDocument(item); setDetailOpen(true); }}>查看详情</Button>{canDelete && <Button size="sm" variant="quiet" onClick={() => { setSelectedDocument(item); setDeleteOpen(true); }}>删除</Button>}</div></td>
          </tr>)}</tbody>
        </table>
      </div>}
      {documentsHasMore && <div className="table-footer"><Button onClick={() => void loadDocuments(true)} disabled={documentsMoreLoading}>{documentsMoreLoading ? '正在加载…' : '加载更多文档'}</Button></div>}
    </section>
    <div className="page-note"><span className="page-note__dot" aria-hidden="true" /><span>文档正文保存在原文版本中；“已存储”表示可读取原文，“已索引”表示已生成可检索内容。</span></div>
    <DocumentEditorDialog open={editorOpen} onClose={() => setEditorOpen(false)} knowledgeBaseId={selectedKB.knowledgeBaseId} capabilities={session.capabilities} mode="create" onSaved={() => void loadDocuments(false)} />
    <DocumentDetailDialog open={detailOpen} onClose={() => setDetailOpen(false)} knowledgeBaseId={selectedKB.knowledgeBaseId} document={selectedDocument} capabilities={session.capabilities} canUpdate={canWrite} onChanged={() => void loadDocuments(false)} />
    <DeleteDocumentDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} knowledgeBaseId={selectedKB.knowledgeBaseId} document={selectedDocument} onDeleted={() => void loadDocuments(false)} />
  </div>;
}

function KnowledgeBaseList({
  items, loading, error, onRefresh, canWrite, onCreate, onSelect, createOpen, onCreateClose, onCreated,
}: {
  items: KnowledgeBase[];
  loading: boolean;
  error: string | null;
  onRefresh: () => Promise<void>;
  canWrite: boolean;
  onCreate: () => void;
  onSelect: (item: KnowledgeBase) => void;
  createOpen: boolean;
  onCreateClose: () => void;
  onCreated: (item: KnowledgeBase) => Promise<void>;
}) {
  return <div className="page-wrap">
    <PageHeading
      eyebrow="文档管理"
      title="知识库"
      description="集中管理文档集合、原文版本与检索状态。"
      actions={<>
        <Button variant="quiet" onClick={() => void onRefresh()} disabled={loading}><RefreshCw size={16} aria-hidden="true" />刷新</Button>
        {canWrite && <Button variant="primary" onClick={onCreate}><CirclePlus size={17} aria-hidden="true" />新建知识库</Button>}
      </>}
    />
    {error && <Alert tone="error" title="知识库读取失败">{error}<Button size="sm" onClick={() => void onRefresh()}>重试</Button></Alert>}
    {loading && items.length === 0 && <LoadingState label="正在读取你有权限访问的知识库…" />}
    {!loading && !error && items.length === 0 && <section className="panel"><EmptyState
      title="还没有可访问的知识库"
      description={canWrite ? '创建知识库后，即可开始保存、索引和检索文档。' : '请联系管理员为当前身份授权知识库访问权限。'}
      icon={<BookOpenText size={24} />}
      action={canWrite && <Button variant="primary" onClick={onCreate}><CirclePlus size={16} aria-hidden="true" />创建知识库</Button>}
    /></section>}
    {items.length > 0 && <div className="kb-grid">
      {items.map((item) => <button type="button" className="kb-card" key={item.knowledgeBaseId} onClick={() => onSelect(item)}>
        <span className="kb-card__icon"><Database size={19} aria-hidden="true" /></span>
        <span className="kb-card__content"><strong>{item.name}</strong><small>{item.knowledgeBaseId}</small></span>
        <span className="kb-card__arrow" aria-hidden="true"><ArrowRight size={17} /></span>
      </button>)}
    </div>}
    <CreateKnowledgeBaseDialog open={createOpen} onClose={onCreateClose} onCreated={onCreated} />
  </div>;
}

function CreateKnowledgeBaseDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (item: KnowledgeBase) => Promise<void> }) {
  const { notify, navigate } = useWorkspace();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<OperationRequest | null>(null);
  const [acceptedTask, setAcceptedTask] = useState<A2ATask | null>(null);
  const operationController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      operationController.current?.abort();
      operationController.current = null;
      return;
    }
    const pending = getPendingWriteRequests().find((item) => item.operation === 'knowledge_base.create');
    setName(typeof pending?.input.name === 'string' ? pending.input.name : '');
    setDescription(typeof pending?.input.description === 'string' ? pending.input.description : '');
    setBusy(false);
    setError(pending ? '检测到尚未确认的知识库创建请求。名称与说明已锁定，继续提交会原样使用同一请求号。' : null);
    setRequest(pending ?? null);
    setAcceptedTask(null);
    return () => { operationController.current?.abort(); };
  }, [open]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    const activeRequest = request ?? makeRequest('knowledge_base.create', { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
    if (!request) setRequest(activeRequest);
    operationController.current?.abort();
    const controller = new AbortController();
    operationController.current = controller;
    try {
      const { result } = await runOperation<{ knowledgeBaseId: string; name: string }>(activeRequest, { signal: controller.signal, onAccepted: (task) => { setAcceptedTask(task); setRequest(null); } });
      const item = { knowledgeBaseId: result.result!.knowledgeBaseId, name: result.result!.name };
      notify('知识库已创建');
      await onCreated(item);
    } catch (cause) {
      if (cause instanceof SubmissionUncertainError) setError(`${cause.message} 请求号 ${cause.requestId} 已保留。`);
      else { setRequest(null); setError(cause instanceof Error ? cause.message : '创建失败。'); }
    } finally {
      if (operationController.current === controller) {
        operationController.current = null;
        setBusy(false);
      }
    }
  }

  return <Dialog open={open} title="新建知识库" description="创建后，当前身份会自动获得该知识库的完整访问权限。" onClose={onClose} className="editor-dialog" footer={<>
    <Button onClick={onClose} disabled={busy}>取消</Button>{acceptedTask && <Button onClick={() => { onClose(); navigate({ screen: 'tasks' }); }}>打开任务中心</Button>}<Button type="submit" form="create-kb-form" variant="primary" disabled={busy || Boolean(acceptedTask) || (!request && !name.trim())}>{busy ? '正在创建…' : acceptedTask ? '任务已受理' : request ? '用原请求号重试' : '创建知识库'}</Button>
  </>}>
    {error && <Alert tone="error" title="创建失败">{error}</Alert>}
    {acceptedTask && <div className="task-accepted-note"><span>创建任务已受理：</span><code>{acceptedTask.id}</code></div>}
    <form id="create-kb-form" className="editor-form" onSubmit={submit}>
      <Field label="名称" htmlFor="kb-name" required hint="名称会显示在工作区和知识库列表中。"><input id="kb-name" value={name} onChange={(event) => setName(event.currentTarget.value)} required maxLength={120} disabled={busy || Boolean(request)} /></Field>
      <Field label="说明" htmlFor="kb-description" hint="可选，用一句话描述知识库用途。"><textarea id="kb-description" value={description} onChange={(event) => setDescription(event.currentTarget.value)} rows={4} maxLength={500} disabled={busy || Boolean(request)} /></Field>
      {request && <p className="request-id-note">请求号已固定：<code>{request.requestId}</code></p>}
    </form>
  </Dialog>;
}
