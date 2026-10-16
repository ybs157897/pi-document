import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownRight, FileSearch, Hash, Search, SlidersHorizontal } from 'lucide-react';
import { ApiError, managementApi, makeRequest, runOperation } from '../api';
import type { DocumentRow, SearchHit, SearchResult } from '../types';
import { isAdmin } from '../types';
import { useWorkspace } from '../App';
import { Alert, Button, CopyButton, EmptyState, Field, LoadingState, PageHeading, StatusPill } from '../components';
import { DocumentDetailDialog } from '../DocumentDialogs';

export function SearchPage() {
  const { session, knowledgeBases, knowledgeBasesLoading, route, navigate, notify } = useWorkspace();
  const [knowledgeBaseId, setKnowledgeBaseId] = useState(route.knowledgeBaseId ?? '');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'hybrid' | 'semantic' | 'keyword'>('hybrid');
  const [topK, setTopK] = useState(10);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [documentIds, setDocumentIds] = useState('');
  const [tags, setTags] = useState('');
  const [sourceTypes, setSourceTypes] = useState<string[]>([]);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailDocument, setDetailDocument] = useState<DocumentRow | null>(null);
  const [selectedHit, setSelectedHit] = useState<SearchHit | undefined>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');
  const [knowledgeBaseScopes, setKnowledgeBaseScopes] = useState<string[]>([]);
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissionsError, setPermissionsError] = useState<string | null>(null);
  const permissionSequence = useRef(0);
  const permissionKBRef = useRef<string | null>(null);
  const searchController = useRef<AbortController | null>(null);

  useEffect(() => {
    if (route.knowledgeBaseId) setKnowledgeBaseId(route.knowledgeBaseId);
    else if (!knowledgeBaseId && knowledgeBases.length) setKnowledgeBaseId(knowledgeBases[0]!.knowledgeBaseId);
  }, [route.knowledgeBaseId, knowledgeBases]);

  useEffect(() => {
    const sequence = ++permissionSequence.current;
    searchController.current?.abort();
    searchController.current = null;
    permissionKBRef.current = null;
    setKnowledgeBaseScopes([]);
    setPermissionsError(null);
    setResult(null);
    setTaskId(null);
    setBusy(false);
    setError(null);
    if (!knowledgeBaseId) { setPermissionsLoading(false); return; }
    setPermissionsLoading(true);
    void managementApi.permissions(knowledgeBaseId).then((value) => {
      if (sequence === permissionSequence.current) {
        permissionKBRef.current = knowledgeBaseId;
        setKnowledgeBaseScopes(value.scopes);
        if (!isAdmin(session.principal) && (!session.principal.scopes.includes('knowledge:read') || !value.scopes.includes('knowledge:read'))) {
          setPermissionsError('当前身份没有读取此知识库的权限。');
          setResult(null);
          navigate({ screen: 'knowledge' });
        }
      }
    }).catch((cause) => {
      if (sequence !== permissionSequence.current) return;
      setKnowledgeBaseScopes([]);
      setResult(null);
      setPermissionsError(cause instanceof Error ? cause.message : '知识库权限读取失败。');
      if (cause instanceof ApiError && [403, 404].includes(cause.status ?? 0)) navigate({ screen: 'knowledge' });
    }).finally(() => { if (sequence === permissionSequence.current) setPermissionsLoading(false); });
    return () => searchController.current?.abort();
  }, [knowledgeBaseId, session.principal, navigate]);

  function toggleSourceType(value: string) {
    setSourceTypes((items) => items.includes(value) ? items.filter((item) => item !== value) : [...items, value]);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session.capabilities.indexing || permissionsLoading || permissionKBRef.current !== knowledgeBaseId || (!isAdmin(session.principal) && (!session.principal.scopes.includes('knowledge:read') || !knowledgeBaseScopes.includes('knowledge:read')))) return;
    if (!knowledgeBaseId) { setError('先选择一个知识库。'); return; }
    setBusy(true); setError(null); setResult(null); setTaskId(null); setCopyNotice('');
    const inputFilters = {
      ...(documentIds.trim() ? { documentIds: documentIds.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 100) } : {}),
      ...(tags.trim() ? { tags: tags.split(/[\n,]/).map((value) => value.trim()).filter(Boolean).slice(0, 50) } : {}),
      ...(sourceTypes.length ? { sourceTypes } : {}),
    };
    const request = makeRequest('document.search', {
      query: query.trim(),
      mode,
      topK: Math.min(50, Math.max(1, Math.floor(topK))),
      ...(Object.keys(inputFilters).length ? { filters: inputFilters } : {}),
    }, knowledgeBaseId);
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    try {
      const { result: envelope, task } = await runOperation<SearchResult>(request, { signal: controller.signal, onAccepted: (value) => setTaskId(value.id) });
      setTaskId(task.id);
      setResult(envelope.result!);
      notify(`检索完成：${envelope.result!.results.length} 个候选片段`, 'info');
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '检索失败，请重试。');
    } finally {
      if (searchController.current === controller) {
        searchController.current = null;
        setBusy(false);
      }
    }
  }

  const ready = session.capabilities.indexing && knowledgeBases.length > 0 && !permissionsLoading && permissionKBRef.current === knowledgeBaseId && (isAdmin(session.principal) || (session.principal.scopes.includes('knowledge:read') && knowledgeBaseScopes.includes('knowledge:read')));
  return <div className="page-wrap">
    <PageHeading eyebrow="文档检索" title="检索文档" description="在当前知识库中查找相关原文片段。" />
    {!session.capabilities.indexing && <Alert tone="warning" title="检索能力未启用">当前服务可以保存原文，但没有启用索引和搜索。</Alert>}
    {permissionsError && <Alert tone="error" title="无法确认知识库权限">{permissionsError} 已清除当前检索结果。</Alert>}
    {error && <Alert tone="error" title="检索没有完成">{error}</Alert>}
    <section className="panel search-panel">
      <form onSubmit={submit} className="search-form">
        <Field label="知识库" htmlFor="search-kb" required hint="检索结果只来自所选知识库。">
          <select id="search-kb" value={knowledgeBaseId} onChange={(event) => { const value = event.currentTarget.value; setKnowledgeBaseId(value); navigate({ screen: 'search', ...(value ? { knowledgeBaseId: value } : {}) }); }} disabled={knowledgeBasesLoading || !knowledgeBases.length || busy} required>
            {knowledgeBasesLoading && <option value="">正在读取知识库…</option>}
            {!knowledgeBases.length && <option value="">没有可访问的知识库</option>}
            {knowledgeBases.map((base) => <option key={base.knowledgeBaseId} value={base.knowledgeBaseId}>{base.name}</option>)}
          </select>
        </Field>
        <Field label="检索内容" htmlFor="search-query" required hint="可以使用问题、关键词或文档中的原句。">
          <div className="search-input-wrap"><Search size={18} aria-hidden="true" /><input id="search-query" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="例如：版本发布前需要完成哪些检查？" required minLength={1} disabled={!ready || busy} /></div>
        </Field>
        <div className="search-controls">
          <Field label="检索模式" htmlFor="search-mode"><select id="search-mode" value={mode} onChange={(event) => setMode(event.currentTarget.value as typeof mode)} disabled={!ready || busy}>
            <option value="hybrid">混合检索</option><option value="semantic">语义检索</option><option value="keyword">关键词检索</option>
          </select></Field>
          <Field label="候选数量" htmlFor="search-topk" hint="最多 50 条。"><input id="search-topk" type="number" min={1} max={50} step={1} value={topK} onChange={(event) => setTopK(Math.min(50, Math.max(1, Number(event.currentTarget.value) || 1)))} disabled={!ready || busy} /></Field>
          <Button type="submit" variant="primary" disabled={!ready || busy || !query.trim()} className="search-submit">{busy ? <><span className="button-spinner" aria-hidden="true" />正在检索</> : <><Search size={16} aria-hidden="true" />检索</>}</Button>
        </div>
        <div className="filter-toggle-row"><Button variant="quiet" size="sm" type="button" aria-expanded={filtersOpen} aria-controls="search-filters" onClick={() => setFiltersOpen((value) => !value)}><SlidersHorizontal size={15} aria-hidden="true" />{filtersOpen ? '收起筛选' : '高级筛选'}<span className="filter-count">{[documentIds, tags].filter((value) => value.trim()).length + sourceTypes.length || ''}</span></Button></div>
        {filtersOpen && <div className="search-filters" id="search-filters">
          <Field label="限定文档 ID" htmlFor="filter-document-ids" hint="多个 ID 可用换行或逗号分隔。"><textarea id="filter-document-ids" value={documentIds} onChange={(event) => setDocumentIds(event.currentTarget.value)} rows={2} disabled={!ready || busy} /></Field>
          <Field label="标签" htmlFor="filter-tags" hint="命中任一标签的文档。"><input id="filter-tags" value={tags} onChange={(event) => setTags(event.currentTarget.value)} placeholder="规范, 产品" disabled={!ready || busy} /></Field>
          <fieldset className="source-type-filter"><legend>来源类型</legend><label><input type="checkbox" checked={sourceTypes.includes('text')} onChange={() => toggleSourceType('text')} disabled={!ready || busy} />文本</label><label><input type="checkbox" checked={sourceTypes.includes('upload')} onChange={() => toggleSourceType('upload')} disabled={!ready || busy} />上传</label><label><input type="checkbox" checked={sourceTypes.includes('url')} onChange={() => toggleSourceType('url')} disabled={!ready || busy} />网页快照</label></fieldset>
        </div>}
      </form>
    </section>
    <div className="search-disclaimer"><span className="search-disclaimer__mark" aria-hidden="true">i</span><p>搜索返回相似候选片段，不等同于问题答案。请打开原文核对上下文与来源定位。</p></div>
    {busy && !result && <section className="panel"><LoadingState label="正在检索并读取任务结果…" /></section>}
    {result && <section className="search-results" aria-labelledby="search-results-heading">
      <div className="section-heading"><div><h2 id="search-results-heading">候选片段</h2><p>“{result.query}” · {result.results.length} 条结果</p></div>{taskId && <div className="result-task-id"><Hash size={14} aria-hidden="true" /><span>任务</span><code>{taskId}</code><CopyButton value={taskId} onCopy={setCopyNotice} label="复制编号" /></div>}</div>
      {copyNotice && <p role="status" className="copy-feedback">{copyNotice}</p>}
      {result.degraded && <Alert
        tone={result.degradationReason?.includes('embedding_unavailable') ? 'warning' : 'info'}
        title={result.degradationReason?.includes('embedding_unavailable') ? '语义服务暂不可用' : '未启用结果重排'}
      >{result.degradationReason?.includes('embedding_unavailable')
          ? '本次语义向量调用失败，服务已改用关键词检索。候选可能不完整，请调整关键词或稍后重试。'
          : '本次没有启用重排步骤；检索任务仍已成功完成，以下是所选检索模式的原始候选结果。'}</Alert>}
      {result.results.length === 0 && <section className="panel"><EmptyState title="没有找到候选片段" description="可以调整检索词、模式或筛选条件后重试。" icon={<FileSearch size={24} />} /></section>}
      <div className="result-list">{result.results.map((hit) => <article className="result-card" key={`${hit.chunkId ?? hit.documentId}-${hit.rank}`}>
        <div className="result-card__top"><span className="result-card__rank">{String(hit.rank).padStart(2, '0')}</span><div className="result-card__heading"><strong>{hit.title}</strong><div className="result-meta"><span>版本 v{hit.version}</span><span aria-hidden="true">·</span><span>{scoreLabel(hit.scoreType)} · {hit.score.toFixed(3)}</span><span aria-hidden="true">·</span><span>{locatorSummary(hit.locator)}</span></div></div><StatusPill label="可检索" tone="success" /></div>
        <p className="result-snippet">{hit.snippet}</p>
        <div className="result-card__footer"><code>{hit.documentId}</code><Button size="sm" onClick={() => { setSelectedHit(hit); setDetailDocument({ documentId: hit.documentId, title: hit.title, version: hit.version, indexState: 'ready' }); setDetailOpen(true); }}>打开原文 <ArrowDownRight size={15} aria-hidden="true" /></Button></div>
      </article>)}</div>
    </section>}
    <DocumentDetailDialog open={detailOpen} onClose={() => setDetailOpen(false)} knowledgeBaseId={knowledgeBaseId} document={detailDocument} citation={selectedHit} capabilities={session.capabilities} canUpdate={isAdmin(session.principal) || (session.principal.scopes.includes('knowledge:write') && knowledgeBaseScopes.includes('knowledge:write'))} onChanged={() => { setDetailOpen(false); setResult(null); }} />
  </div>;
}

function scoreLabel(kind: string): string {
  if (kind === 'rrf') return '融合排序';
  if (kind === 'cosine') return '语义相似度';
  return '关键词匹配';
}

function locatorSummary(locator: Record<string, unknown>): string {
  const page = locator.page ?? locator.pageNumber;
  const startLine = locator.startLine;
  const endLine = locator.endLine;
  if (typeof page === 'number') return `第 ${page} 页`;
  if (typeof startLine === 'number') return startLine === endLine ? `第 ${startLine} 行` : `第 ${startLine}–${String(endLine ?? startLine)} 行`;
  if (typeof locator.paragraph === 'number') return `段落 ${locator.paragraph}`;
  return '来源位置';
}
