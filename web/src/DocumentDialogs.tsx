import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, Check, ChevronDown, FileText, Hash, RefreshCw, RotateCcw, Upload, X } from 'lucide-react';
import {
  ApiError, BusinessTaskError, createUpload, downloadDocument, getDocument, getPendingWriteRequests, makeRequest, readDocumentText, runOperation,
  SubmissionUncertainError,
  type OperationRequest,
} from './api';
import type { A2ATask, DocumentRow, SearchHit } from './types';
import { useWorkspace } from './App';
import { Alert, Button, CopyButton, Dialog, Field, LoadingState, StatusPill } from './components';

type DetailResult = {
  documentId: string;
  version: number;
  title: string;
  indexState: string;
  source: { sha256: string; mimeType: string };
  content: { text: string; truncated: boolean; nextCursor?: string };
  downloadUri: string;
};

const acceptedFiles = '.txt,.md,.markdown,.pdf,.docx,.html,.htm,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/html';

function findPendingDocumentWrite(mode: 'create' | 'update', knowledgeBaseId: string, documentId?: string): OperationRequest | undefined {
  const operation = mode === 'create' ? 'document.save' : 'document.update';
  return getPendingWriteRequests().find((request) => request.operation === operation
    && request.knowledgeBaseId === knowledgeBaseId
    && (mode === 'create' || request.input.documentId === documentId));
}

export function DocumentEditorDialog({
  open, onClose, knowledgeBaseId, capabilities, mode, document, initialText, initialMimeType, initialSourceMode, sourceNotice, onSaved,
}: {
  open: boolean;
  onClose: () => void;
  knowledgeBaseId: string;
  capabilities: { indexing: boolean; uploads: boolean };
  mode: 'create' | 'update';
  document?: DocumentRow;
  initialText?: string;
  initialMimeType?: string;
  initialSourceMode?: 'text' | 'upload';
  sourceNotice?: string;
  onSaved: () => void;
}) {
  const { notify, navigate } = useWorkspace();
  const [sourceMode, setSourceMode] = useState<'text' | 'upload' | 'url'>('text');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [textMimeType, setTextMimeType] = useState<'text/plain' | 'text/markdown'>('text/plain');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [tags, setTags] = useState('');
  const [tagsChanged, setTagsChanged] = useState(false);
  const [waitFor, setWaitFor] = useState<'stored' | 'indexed'>('indexed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<OperationRequest | null>(null);
  const [acceptedTask, setAcceptedTask] = useState<A2ATask | null>(null);
  const [lastUpload, setLastUpload] = useState<{ name: string; sha256: string } | null>(null);
  const [copyNotice, setCopyNotice] = useState('');
  const operationController = useRef<AbortController | null>(null);
  const isUpdate = mode === 'update';
  const formId = isUpdate ? `update-document-${document?.documentId}` : `create-document-${knowledgeBaseId}`;
  const textBytes = new TextEncoder().encode(text).byteLength;
  const tooLong = sourceMode === 'text' && textBytes > 262144;

  useEffect(() => {
    if (!open) {
      operationController.current?.abort();
      operationController.current = null;
      return;
    }
    const pending = findPendingDocumentWrite(mode, knowledgeBaseId, document?.documentId);
    const pendingSource = pending?.input.source && typeof pending.input.source === 'object'
      ? pending.input.source as Record<string, unknown>
      : undefined;
    const pendingText = pendingSource?.kind === 'text' && typeof pendingSource.text === 'string' ? pendingSource.text : undefined;
    const pendingUrl = pendingSource?.kind === 'url' && typeof pendingSource.url === 'string' ? pendingSource.url : '';
    setSourceMode(pendingSource?.kind === 'upload' ? 'upload' : pendingUrl ? 'url' : initialSourceMode ?? 'text');
    setTitle(typeof pending?.input.title === 'string' ? pending.input.title : isUpdate ? document?.title ?? '' : '');
    setText(pendingText ?? initialText ?? '');
    const pendingMime = pendingSource?.mimeType;
    setTextMimeType((pendingMime === 'text/markdown' || (!pending && initialMimeType === 'text/markdown')) ? 'text/markdown' : 'text/plain');
    setUrl(pendingUrl);
    setFile(null);
    const pendingTags = pending?.input.tags;
    setTags(Array.isArray(pendingTags) ? pendingTags.filter((tag): tag is string => typeof tag === 'string').join(', ') : document?.tags?.join(', ') ?? '');
    setTagsChanged(Boolean(pending && Object.hasOwn(pending.input, 'tags')));
    setWaitFor(pending?.input.waitFor === 'stored' ? 'stored' : capabilities.indexing ? 'indexed' : 'stored');
    setBusy(false);
    setError(pending ? '检测到这份文档有一个尚未确认的写请求。字段已锁定，重试会原样发送已保存的请求内容。' : null);
    setErrorCode(pending ? 'SUBMISSION_UNCERTAIN' : null);
    setPendingRequest(pending ?? null);
    setAcceptedTask(null);
    setLastUpload(null);
    setCopyNotice('');
    return () => { operationController.current?.abort(); };
  }, [open, mode, knowledgeBaseId, document?.documentId, initialMimeType, initialSourceMode]);

  const canSelectUpload = capabilities.uploads;
  const canSelectUrl = !isUpdate && capabilities.indexing;
  const sourceModeLocked = Boolean(pendingRequest || acceptedTask || busy);
  const tagsList = useMemo(() => tags.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 50), [tags]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setErrorCode(null);
    setBusy(true);
    operationController.current?.abort();
    const controller = new AbortController();
    operationController.current = controller;
    try {
      let request = pendingRequest;
      if (!request) {
        if (!document && isUpdate) throw new Error('要更新的文档信息已失效，请重新打开文档详情。');
        if (sourceMode === 'text' && !text.trim()) throw new Error('请输入文档正文。');
        if (sourceMode === 'text' && tooLong) throw new Error('正文超过 256 KiB，请改用文件上传。');
        if (sourceMode === 'upload' && !file) throw new Error('请选择一个文件。');
        if (sourceMode === 'upload' && file!.size > 50 * 1024 * 1024) throw new Error('文件超过 50 MiB，请选择较小的文件。');
        if (sourceMode === 'url' && !/^https:\/\//i.test(url.trim())) throw new Error('请输入以 https:// 开头的公开网页地址。');
        const source = sourceMode === 'text'
          ? { kind: 'text', text, mimeType: textMimeType }
          : sourceMode === 'url'
            ? { kind: 'url', url: url.trim() }
            : undefined;
        if (sourceMode === 'upload') {
          const uploaded = await createUpload(knowledgeBaseId, file!);
          setLastUpload({ name: file!.name, sha256: uploaded.sha256 });
          const input = {
            documentId: document?.documentId,
            ...(isUpdate ? { expectedVersion: document!.version } : {}),
            source: { kind: 'upload', uploadId: uploaded.uploadId },
            ...(!isUpdate || title.trim() ? { title: title.trim() } : {}),
            ...(tagsChanged || tagsList.length ? { tags: tagsList } : {}),
            ...(capabilities.indexing ? { waitFor } : { waitFor: 'stored' }),
          };
          request = makeRequest(isUpdate ? 'document.update' : 'document.save', input, knowledgeBaseId);
        } else {
          const input = {
            documentId: document?.documentId,
            ...(isUpdate ? { expectedVersion: document!.version } : {}),
            source,
            ...(title.trim() ? { title: title.trim() } : {}),
            ...(tagsChanged || tagsList.length ? { tags: tagsList } : {}),
            ...(capabilities.indexing ? { waitFor } : { waitFor: 'stored' }),
          };
          request = makeRequest(isUpdate ? 'document.update' : 'document.save', input, knowledgeBaseId);
        }
        setPendingRequest(request);
      }
      const { result } = await runOperation<Record<string, unknown>>(request, {
        signal: controller.signal,
        onAccepted: (task) => {
          setAcceptedTask(task);
          setPendingRequest(null);
        },
        onUpdate: (task) => setAcceptedTask(task),
      });
      setPendingRequest(null);
      const stored = result.result?.indexState === 'stored';
      const ingestionTaskId = typeof result.result?.ingestionTaskId === 'string' ? result.result.ingestionTaskId : undefined;
      notify(stored && ingestionTaskId
        ? `原文已保存，索引任务 ${ingestionTaskId} 正在后台运行`
        : stored ? '原文已保存；当前服务未启用索引' : '文档已保存并完成索引', stored ? 'info' : 'success');
      onSaved();
      onClose();
    } catch (cause) {
      if (cause instanceof SubmissionUncertainError) {
        setError(`${cause.message} 请求号 ${cause.requestId} 会保留；点击“用原请求号重试”可以安全确认提交状态。`);
        setErrorCode('SUBMISSION_UNCERTAIN');
      } else if (cause instanceof BusinessTaskError) {
        setPendingRequest(null);
        setErrorCode(cause.code);
        setError(cause.code === 'VERSION_CONFLICT' || cause.code === 'STALE_VERSION'
          ? `文档版本已变化，当前编辑没有覆盖新版本。请刷新详情后重新编辑。服务信息：${cause.message}`
          : `${cause.message}（任务 ${cause.taskId}）`);
      } else {
        if (cause instanceof ApiError && cause.code !== 'NETWORK_ERROR') setPendingRequest(null);
        setErrorCode(cause instanceof ApiError ? cause.code : null);
        setError(cause instanceof Error ? cause.message : '保存失败，请稍后重试。');
      }
    } finally {
      if (operationController.current === controller) {
        operationController.current = null;
        setBusy(false);
      }
    }
  }

  const footer = <>
    <Button type="button" onClick={onClose} disabled={busy}>取消</Button>
    {acceptedTask && <Button type="button" onClick={() => { onClose(); navigate({ screen: 'tasks' }); }}>打开任务中心</Button>}
    <Button type="submit" form={formId} variant="primary" disabled={busy || Boolean(acceptedTask) || (sourceMode === 'text' && (!text.trim() || tooLong))}>
      {busy ? '正在处理…' : acceptedTask ? '任务已受理' : pendingRequest ? '用原请求号重试' : isUpdate ? '保存新版本' : '保存文档'}
    </Button>
  </>;

  return <Dialog
    open={open}
    title={isUpdate ? `编辑文档 · v${document?.version ?? ''}` : '添加文档'}
    description={isUpdate ? '保存会创建新版本，服务会用当前版本号校验，避免覆盖并发修改。' : '选择一种来源。原文件会由服务端解析并保留来源与版本信息。'}
    onClose={onClose}
    className="editor-dialog"
    footer={footer}
  >
    {error && <Alert tone="error" title={errorCode === 'SUBMISSION_UNCERTAIN' ? '提交状态尚未确认' : '保存失败'}>{error}</Alert>}
    {sourceNotice && <Alert tone="info" title="编辑方式说明">{sourceNotice}</Alert>}
    {acceptedTask && <div className="task-accepted-note" role="status"><Check size={16} aria-hidden="true" /><span>任务已受理：<code>{acceptedTask.id}</code></span></div>}
    <form id={formId} className="editor-form" onSubmit={submit}>
      <Field label="文档标题" htmlFor={`${formId}-title`} required={!isUpdate} hint={isUpdate ? '留空时保持原标题。' : '填写便于检索和辨认的名称。'}>
        <input id={`${formId}-title`} value={title} onChange={(event) => setTitle(event.currentTarget.value)} required={!isUpdate} maxLength={240} disabled={sourceModeLocked} />
      </Field>
      <Field label="标签" htmlFor={`${formId}-tags`} hint="可选，使用英文逗号分隔，最多 50 项。">
        <input id={`${formId}-tags`} value={tags} onChange={(event) => { setTags(event.currentTarget.value); setTagsChanged(true); }} placeholder="例如：产品, 规范, 2026" disabled={sourceModeLocked} />
      </Field>
      <fieldset className="source-picker">
        <legend>内容来源</legend>
        <div className="source-picker__tabs" role="group" aria-label="选择内容来源">
          <button type="button" className={sourceMode === 'text' ? 'is-selected' : ''} onClick={() => setSourceMode('text')} disabled={sourceModeLocked}><FileText size={16} aria-hidden="true" />粘贴文本</button>
          <button type="button" className={sourceMode === 'upload' ? 'is-selected' : ''} onClick={() => setSourceMode('upload')} disabled={!canSelectUpload || sourceModeLocked} title={!canSelectUpload ? '当前服务未启用上传功能' : undefined}><Upload size={16} aria-hidden="true" />上传文件</button>
          {canSelectUrl && <button type="button" className={sourceMode === 'url' ? 'is-selected' : ''} onClick={() => setSourceMode('url')} disabled={sourceModeLocked}><RefreshCw size={15} aria-hidden="true" />公开网页</button>}
        </div>
        {sourceMode === 'text' && <div className="source-panel">
          <label htmlFor={`${formId}-text`}>文档正文</label>
          {isUpdate && initialMimeType !== 'text/plain' && initialMimeType !== 'text/markdown' && <p className="field__hint">此文本来自解析预览。保存会创建新的纯文本版本，不会保留原文件布局。</p>}
          <label className="text-format-label" htmlFor={`${formId}-text-format`}>文本格式</label>
          <select id={`${formId}-text-format`} value={textMimeType} onChange={(event) => setTextMimeType(event.currentTarget.value as 'text/plain' | 'text/markdown')} disabled={sourceModeLocked}><option value="text/plain">纯文本</option><option value="text/markdown">Markdown</option></select>
          <textarea id={`${formId}-text`} rows={9} value={text} onChange={(event) => setText(event.currentTarget.value)} placeholder="在此粘贴文档内容…" maxLength={262144} aria-describedby={`${formId}-text-count ${formId}-text-hint ${tooLong ? `${formId}-text-error` : ''}`} disabled={sourceModeLocked} />
          <div className="source-panel__meta"><span id={`${formId}-text-count`}>{textBytes.toLocaleString()} / 262,144 字节</span><span id={`${formId}-text-hint`}>支持纯文本与 Markdown。</span></div>
          {tooLong && <p className="field__error" id={`${formId}-text-error`} role="alert">正文超过服务限制；请上传文件。</p>}
        </div>}
        {sourceMode === 'upload' && <div className="source-panel">
          <label htmlFor={`${formId}-file`}>选择文件</label>
          <input id={`${formId}-file`} type="file" accept={acceptedFiles} onChange={(event) => setFile(event.currentTarget.files?.[0] ?? null)} disabled={sourceModeLocked} />
          <p className="field__hint">支持 TXT、Markdown、PDF、DOCX 与 HTML，单个文件最大 50 MiB。文件会发送到当前服务。</p>
          {file && <div className="file-choice"><FileText size={16} aria-hidden="true" /><span>{file.name}</span><span>{formatBytes(file.size)}</span><button type="button" aria-label="移除所选文件" onClick={() => setFile(null)}><X size={15} /></button></div>}
          {lastUpload && <div className="file-choice file-choice--complete"><Check size={16} aria-hidden="true" /><span>上传完成 · {lastUpload.name}</span><code>{lastUpload.sha256.slice(0, 12)}…</code></div>}
        </div>}
        {sourceMode === 'url' && <div className="source-panel">
          <Field label="公开网页地址" htmlFor={`${formId}-url`} required hint="服务端会安全抓取并保存网页快照。仅支持公开 HTTPS 地址。">
            <input id={`${formId}-url`} type="url" inputMode="url" value={url} onChange={(event) => setUrl(event.currentTarget.value)} placeholder="https://example.com/guide" autoComplete="url" disabled={sourceModeLocked} />
          </Field>
        </div>}
      </fieldset>
      {capabilities.indexing && <fieldset className="wait-picker">
        <legend>保存后处理</legend>
        <label className="radio-row"><input type="radio" name={`${formId}-wait`} value="indexed" checked={waitFor === 'indexed'} onChange={() => setWaitFor('indexed')} disabled={sourceModeLocked} /><span><strong>等待索引完成</strong><small>完成后再关闭窗口，可立即检索。</small></span></label>
        <label className="radio-row"><input type="radio" name={`${formId}-wait`} value="stored" checked={waitFor === 'stored'} onChange={() => setWaitFor('stored')} disabled={sourceModeLocked} /><span><strong>先保存原文</strong><small>索引任务在后台继续，可到任务中心查看。</small></span></label>
      </fieldset>}
      {pendingRequest && <div className="request-id-note"><Hash size={14} aria-hidden="true" /><span>请求号已固定：<code>{pendingRequest.requestId}</code></span><CopyButton value={pendingRequest.requestId} label="复制" onCopy={setCopyNotice} /></div>}
      {copyNotice && <p className="copy-feedback" role="status">{copyNotice}</p>}
    </form>
  </Dialog>;
}

export function DocumentDetailDialog({
  open, onClose, knowledgeBaseId, document, citation, capabilities, canUpdate = false, onChanged,
}: {
  open: boolean;
  onClose: () => void;
  knowledgeBaseId: string;
  document: DocumentRow | null;
  citation?: SearchHit;
  capabilities: { indexing: boolean; uploads: boolean };
  canUpdate?: boolean;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<DetailResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(undefined);
  const [locator, setLocator] = useState<Record<string, unknown> | undefined>(citation?.locator);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorSeed, setEditorSeed] = useState('');
  const [editorMimeType, setEditorMimeType] = useState('text/plain');
  const [editorSourceMode, setEditorSourceMode] = useState<'text' | 'upload'>('text');
  const [editorNotice, setEditorNotice] = useState('');
  const [editorPreparing, setEditorPreparing] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');

  useEffect(() => {
    if (!open || !document) return;
    setDetail(null);
    setError(null);
    setDownloadError(null);
    setSelectedVersion(document.version);
    setLocator(citation?.locator);
    setCopyNotice('');
    const controller = new AbortController();
    setLoading(true);
    void getDocument(knowledgeBaseId, document.documentId, { version: document.version, limit: 8192 }, controller.signal)
      .then((value) => setDetail(value as unknown as DetailResult))
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (isMissingResource(cause)) { setDetail(null); onChanged(); onClose(); }
        else setError(cause instanceof Error ? cause.message : '文档详情读取失败。');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, knowledgeBaseId, document?.documentId, document?.version]);

  async function loadMore() {
    if (!document || !detail?.content.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await getDocument(knowledgeBaseId, document.documentId, {
        version: detail.version, cursor: detail.content.nextCursor, limit: 8192,
      });
      const data = next as unknown as DetailResult;
      setDetail((current) => current ? { ...data, content: { ...data.content, text: current.content.text + data.content.text } } : data);
    } catch (cause) {
      if (isMissingResource(cause)) { setDetail(null); onChanged(); onClose(); }
      else setError(cause instanceof Error ? cause.message : '后续正文读取失败。');
    }
    finally { setLoadingMore(false); }
  }

  async function selectVersion(version: number) {
    if (!document || !Number.isInteger(version) || version < 1) return;
    setSelectedVersion(version);
    setLoading(true);
    setError(null);
    try {
      const result = await getDocument(knowledgeBaseId, document.documentId, { version, limit: 8192 });
      setDetail(result as unknown as DetailResult);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '这个版本不可读取。'); }
    finally { setLoading(false); }
  }

  async function download() {
    if (!document || !detail) return;
    setDownloadError(null);
    try { await downloadDocument(document.documentId, detail.version, detail.title); }
    catch (cause) {
      if (isMissingResource(cause)) { setDetail(null); onChanged(); onClose(); }
      else setDownloadError(cause instanceof Error ? cause.message : '原文件下载失败。');
    }
  }

  async function edit() {
    if (!document || !detail || !canUpdate || !capabilities.indexing) return;
    setEditorPreparing(true);
    setError(null);
    const originalMime = detail.source.mimeType;
    if (originalMime === 'text/plain' || originalMime === 'text/markdown') {
      try {
        const original = await readDocumentText(document.documentId, detail.version);
        setEditorSeed(original.text);
        setEditorMimeType(original.mimeType);
        setEditorSourceMode('text');
        setEditorNotice(original.mimeType === 'text/markdown'
          ? '已读取认证原文件中的 UTF-8 Markdown 正文，标题与标记会原样保留。'
          : '已读取认证原文件中的 UTF-8 纯文本。');
      } catch (cause) {
        if (cause instanceof ApiError && ['TEXT_SOURCE_TOO_LARGE', 'TEXT_SOURCE_NOT_EDITABLE', 'TEXT_SOURCE_ENCODING'].includes(cause.code)) {
          setEditorSeed('');
          setEditorMimeType(originalMime);
          setEditorSourceMode('upload');
          setEditorNotice(`${cause.message} 上传新文件可以创建下一版本。`);
        } else {
          if (isMissingResource(cause)) { setDetail(null); onChanged(); onClose(); }
          else setError(cause instanceof Error ? cause.message : '原文件读取失败。');
          setEditorPreparing(false);
          return;
        }
      }
    } else {
      setEditorSeed('');
      setEditorMimeType(originalMime);
      setEditorSourceMode('upload');
      setEditorNotice(`${originalMime} 的正文预览经过解析转换。请选择新文件替换原文；如手动切到文本，会创建一个新的纯文本版本。`);
    }
    setEditorOpen(true);
    setEditorPreparing(false);
  }

  const canEditSource = Boolean(detail && selectedVersion === document?.version && (detail.source.mimeType === 'text/plain' || detail.source.mimeType === 'text/markdown' || capabilities.uploads));
  const editorDocument = document && detail ? { ...document, version: detail.version, title: detail.title } : document ?? undefined;
  const onSaved = () => { setEditorOpen(false); onChanged(); onClose(); };
  return <>
    <Dialog
      open={open}
      title={detail?.title ?? document?.title ?? '文档详情'}
      description={document ? `${document.documentId} · 当前版本 v${detail?.version ?? document.version}` : undefined}
      onClose={onClose}
      className="detail-dialog"
      footer={<>
        {document && <Button type="button" onClick={download} disabled={!detail}><ArrowDownToLine size={16} aria-hidden="true" />下载原文件</Button>}
        {document && canUpdate && canEditSource && <Button type="button" variant="primary" onClick={() => void edit()} disabled={!detail || editorPreparing || !capabilities.indexing}>{editorPreparing ? '正在读取原文件…' : '编辑并创建新版本'}</Button>}
      </>}
    >
      {loading && !detail && <LoadingState label="正在读取文档与版本信息…" />}
      {error && <Alert tone="error" title="详情读取失败">{error}</Alert>}
      {downloadError && <Alert tone="error" title="原文件下载失败">{downloadError}</Alert>}
      {detail && <div className="document-detail">
        <div className="document-detail__status">
          <StatusPill label={detail.indexState === 'ready' ? '已索引，可检索' : detail.indexState === 'indexing' ? '索引处理中' : '已存储原文'} tone={detail.indexState === 'ready' ? 'success' : detail.indexState === 'indexing' ? 'info' : 'warning'} dot />
          <span>版本 <strong>v{detail.version}</strong></span>
          {selectedVersion !== undefined && selectedVersion !== document?.version && <StatusPill label="历史版本" tone="neutral" />}
        </div>
        <section className="detail-section">
          <div className="detail-section__heading"><h3>正文预览</h3><span>{detail.source.mimeType}</span></div>
          <pre className="document-content">{detail.content.text || '此版本没有可展示的规范化文本。'}</pre>
          {detail.content.truncated && <div className="load-more-row"><span>正文预览还有后续内容。</span><Button size="sm" onClick={loadMore} disabled={loadingMore}>{loadingMore ? '加载中…' : '加载更多'}</Button></div>}
          {!detail.content.truncated && <p className="document-content__complete">正文预览已读取完成</p>}
          {selectedVersion !== document?.version && <p className="document-content__complete">当前显示历史版本。创建新版本时仍会使用服务当前版本校验。</p>}
        </section>
        <details className="advanced-details">
          <summary>高级详情 <ChevronDown size={15} aria-hidden="true" /></summary>
          <dl className="metadata-grid">
            <div><dt>文档 ID</dt><dd><code>{detail.documentId}</code><CopyButton value={detail.documentId} onCopy={setCopyNotice} /></dd></div>
            <div><dt>内容 SHA-256</dt><dd><code className="hash-value">{detail.source.sha256}</code><CopyButton value={detail.source.sha256} onCopy={setCopyNotice} /></dd></div>
            <div><dt>内容类型</dt><dd><code>{detail.source.mimeType}</code></dd></div>
            <div><dt>版本读取</dt><dd className="version-reader"><label htmlFor="version-number">输入版本号</label><input id="version-number" type="number" min={1} max={document?.version} value={selectedVersion ?? ''} onChange={(event) => setSelectedVersion(Number(event.currentTarget.value))} /><Button size="sm" onClick={() => selectedVersion && void selectVersion(selectedVersion)} disabled={loading || !selectedVersion}>读取</Button></dd></div>
            <div className="metadata-grid__wide"><dt>引用定位</dt><dd>{locator ? <pre className="locator-value">{JSON.stringify(locator, null, 2)}</pre> : <span className="muted">从检索结果打开时显示对应片段的来源定位。</span>}</dd></div>
            <div className="metadata-grid__wide"><dt>下载地址</dt><dd><code className="hash-value">{detail.downloadUri}</code></dd></div>
          </dl>
          {copyNotice && <p className="copy-feedback" role="status">{copyNotice}</p>}
        </details>
      </div>}
    </Dialog>
    {editorDocument && <DocumentEditorDialog open={editorOpen} onClose={() => setEditorOpen(false)} knowledgeBaseId={knowledgeBaseId} capabilities={capabilities} mode="update" document={editorDocument} initialText={editorSeed} initialMimeType={editorMimeType} initialSourceMode={editorSourceMode} sourceNotice={editorNotice} onSaved={onSaved} />}
  </>;
}

export function DeleteDocumentDialog({
  open, onClose, knowledgeBaseId, document, onDeleted,
}: {
  open: boolean;
  onClose: () => void;
  knowledgeBaseId: string;
  document: DocumentRow | null;
  onDeleted: () => void;
}) {
  const { notify, navigate } = useWorkspace();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRequest, setPendingRequest] = useState<OperationRequest | null>(null);
  const [task, setTask] = useState<A2ATask | null>(null);
  const operationController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      operationController.current?.abort();
      operationController.current = null;
      return;
    }
    setBusy(false); setError(null); setPendingRequest(null); setTask(null);
    return () => { operationController.current?.abort(); };
  }, [open, document?.documentId]);

  async function confirm() {
    if (!document) return;
    setBusy(true); setError(null);
    const request = pendingRequest ?? makeRequest('document.delete', {
      documentId: document.documentId,
      expectedVersion: document.version,
    }, knowledgeBaseId);
    setPendingRequest(request);
    operationController.current?.abort();
    const controller = new AbortController();
    operationController.current = controller;
    try {
      await runOperation(request, { signal: controller.signal, onAccepted: (accepted) => { setTask(accepted); setPendingRequest(null); } });
      setPendingRequest(null);
      notify('文档已删除并进入清理流程', 'success');
      onDeleted();
      onClose();
    } catch (cause) {
      if (cause instanceof SubmissionUncertainError) setError(`提交状态未知。保留原请求号 ${cause.requestId}，可安全重试。`);
      else {
        if (!(cause instanceof ApiError && cause.code === 'NETWORK_ERROR')) setPendingRequest(null);
        setError(cause instanceof Error ? cause.message : '删除失败。');
      }
    } finally {
      if (operationController.current === controller) {
        operationController.current = null;
        setBusy(false);
      }
    }
  }

  return <Dialog open={open} title="删除文档" description="文档会立即从列表与检索中隐藏，后台清理任务随后处理原文。" onClose={onClose} className="confirm-dialog" footer={<>
    <Button type="button" onClick={onClose} disabled={busy}>取消</Button>
    {task && <Button type="button" onClick={() => { onClose(); navigate({ screen: 'tasks' }); }}>打开任务中心</Button>}
    <Button type="button" variant="danger" onClick={() => void confirm()} disabled={busy || Boolean(task)}>{busy ? '正在删除…' : task ? '任务已受理' : pendingRequest ? '用原请求号重试' : '确认删除'}</Button>
  </>}>
    {document && <div className="delete-summary"><div className="delete-summary__icon"><X size={18} aria-hidden="true" /></div><div><strong>{document.title}</strong><p>将删除版本 v{document.version}</p><code>{document.documentId}</code></div></div>}
    {task && <p className="task-accepted-note"><Check size={16} aria-hidden="true" />删除任务已受理：<code>{task.id}</code></p>}
    {error && <Alert tone="error" title="删除未完成">{error}</Alert>}
    {pendingRequest && <p className="request-id-note"><Hash size={14} aria-hidden="true" />固定请求号：<code>{pendingRequest.requestId}</code></p>}
  </Dialog>;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function isMissingResource(error: unknown): boolean {
  if (error instanceof ApiError) return [403, 404].includes(error.status ?? 0);
  return error instanceof BusinessTaskError && ['FORBIDDEN', 'DOCUMENT_NOT_FOUND', 'KNOWLEDGE_BASE_NOT_FOUND', 'RESOURCE_NOT_FOUND'].includes(error.code);
}
