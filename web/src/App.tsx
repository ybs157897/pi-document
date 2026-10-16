import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, BookOpenText, Check, CircleHelp, Database, FileSearch, KeyRound, LogOut,
  Menu, PanelLeftClose, PanelLeftOpen, Shield, X,
} from 'lucide-react';
import {
  ApiError, getSessionInfo, getSessionToken, listKnowledgeBases, saveSessionToken, clearSession, validateToken,
  getSessionEpoch,
} from './api';
import type { KnowledgeBase, SessionInfo } from './types';
import { isAdmin } from './types';
import { AccessPage } from './pages/AccessPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { SearchPage } from './pages/SearchPage';
import { TasksPage } from './pages/TasksPage';
import { Alert, Button, IconButton, LoadingState, StatusPill } from './components';
import './styles.css';

export type Screen = 'knowledge' | 'search' | 'tasks' | 'access';
export type Route = { screen: Screen; knowledgeBaseId?: string };
type Toast = { id: number; text: string; tone: 'success' | 'error' | 'info' };

type WorkspaceValue = {
  session: SessionInfo;
  knowledgeBases: KnowledgeBase[];
  knowledgeBasesLoading: boolean;
  knowledgeBasesError: string | null;
  reloadKnowledgeBases: () => Promise<void>;
  route: Route;
  navigate: (route: Route) => void;
  notify: (text: string, tone?: Toast['tone']) => void;
  clearNotifications: () => void;
  logout: () => void;
};

const WorkspaceContext = createContext<WorkspaceValue | null>(null);
export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('Workspace context is missing.');
  return value;
}

function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [path = 'knowledge', query = ''] = raw.split('?');
  let parts: string[];
  try { parts = path.split('/').filter(Boolean).map((part) => decodeURIComponent(part)); }
  catch { return { screen: 'knowledge' }; }
  const screen = parts[0];
  const knowledgeBaseId = parts[1];
  const params = new URLSearchParams(query);
  if (screen === 'search') return { screen: 'search', ...(knowledgeBaseId ?? params.get('kb') ? { knowledgeBaseId: knowledgeBaseId ?? params.get('kb')! } : {}) };
  if (screen === 'tasks') return { screen: 'tasks' };
  if (screen === 'access') return { screen: 'access', ...(knowledgeBaseId ? { knowledgeBaseId } : {}) };
  return { screen: 'knowledge', ...(knowledgeBaseId ? { knowledgeBaseId } : {}) };
}

function routeHash(route: Route): string {
  const base = route.screen === 'knowledge' ? 'knowledge-bases'
    : route.screen === 'search' ? 'search'
      : route.screen === 'tasks' ? 'tasks' : 'access';
  return `#${base}${route.knowledgeBaseId ? `/${encodeURIComponent(route.knowledgeBaseId)}` : ''}`;
}

function originLabel(): string {
  return window.location.origin;
}

export default function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [authChecking, setAuthChecking] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBase[]>([]);
  const [knowledgeBasesLoading, setKnowledgeBasesLoading] = useState(false);
  const [knowledgeBasesError, setKnowledgeBasesError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tokenInput, setTokenInput] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState<string | null>(null);
  const mainRef = useRef<HTMLElement>(null);
  const toastSequence = useRef(0);
  const sessionRef = useRef<SessionInfo | null>(session);
  const kbLoadController = useRef<AbortController | null>(null);
  const kbLoadSequence = useRef(0);
  sessionRef.current = session;

  const notify = useCallback((text: string, tone: Toast['tone'] = 'success') => {
    const id = ++toastSequence.current;
    setToasts((items) => [...items.filter((item) => item.id !== id), { id, text, tone }]);
    window.setTimeout(() => setToasts((items) => items.filter((item) => item.id !== id)), 4200);
  }, []);
  const clearNotifications = useCallback(() => setToasts([]), []);
  const navigate = useCallback((next: Route) => {
    const hash = routeHash(next);
    if (window.location.hash !== hash) window.location.hash = hash;
    else setRoute(next);
    setMobileNavOpen(false);
  }, []);
  const reloadKnowledgeBases = useCallback(async () => {
    if (!session) return;
    kbLoadController.current?.abort();
    const controller = new AbortController();
    kbLoadController.current = controller;
    const sequence = ++kbLoadSequence.current;
    const expectedEpoch = getSessionEpoch();
    const expectedPrincipal = session.principal.id;
    setKnowledgeBasesLoading(true);
    setKnowledgeBasesError(null);
    try {
      const result = await listKnowledgeBases({ limit: 50 }, controller.signal);
      if (controller.signal.aborted || getSessionEpoch() !== expectedEpoch || sessionRef.current?.principal.id !== expectedPrincipal || sequence !== kbLoadSequence.current) return;
      setKnowledgeBases(result.knowledgeBases);
      setConnectionIssue(null);
    } catch (error) {
      if (controller.signal.aborted || getSessionEpoch() !== expectedEpoch || sessionRef.current?.principal.id !== expectedPrincipal || sequence !== kbLoadSequence.current) return;
      const message = error instanceof Error ? error.message : '知识库加载失败。';
      setKnowledgeBasesError(message);
      if (error instanceof ApiError && error.status === 401) setConnectionIssue('身份已失效，请重新连接。');
    } finally {
      if (sequence === kbLoadSequence.current && getSessionEpoch() === expectedEpoch && sessionRef.current?.principal.id === expectedPrincipal) setKnowledgeBasesLoading(false);
    }
  }, [session]);
  const logout = useCallback(() => {
    kbLoadController.current?.abort();
    kbLoadController.current = null;
    kbLoadSequence.current += 1;
    clearSession();
    setSession(null);
    setKnowledgeBases([]);
    setKnowledgeBasesError(null);
    setConnectionIssue(null);
    setAuthError(null);
    setTokenInput('');
    setMobileNavOpen(false);
    setToasts([]);
    setRoute({ screen: 'knowledge' });
    if (window.location.hash) window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }, []);

  useEffect(() => {
    const sync = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => { window.removeEventListener('hashchange', sync); window.removeEventListener('popstate', sync); };
  }, []);

  useEffect(() => {
    const token = getSessionToken();
    if (!token) { setAuthReady(true); return; }
    setAuthChecking(true);
    void getSessionInfo().then((identity) => {
      setSession(identity);
      setAuthError(null);
    }).catch(() => {
      clearSession();
      setAuthError('保存的连接凭据已失效，请输入新的访问令牌。');
    }).finally(() => { setAuthChecking(false); setAuthReady(true); });
  }, []);

  useEffect(() => {
    if (!session) return;
    void reloadKnowledgeBases();
    return () => { kbLoadController.current?.abort(); };
  }, [session, reloadKnowledgeBases]);
  useEffect(() => {
    window.addEventListener('pi-document:unauthorized', logout);
    return () => window.removeEventListener('pi-document:unauthorized', logout);
  }, [logout]);
  useEffect(() => { if (session) mainRef.current?.focus(); }, [route.screen, route.knowledgeBaseId, session]);

  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = tokenInput.trim();
    if (!token) { setAuthError('请输入访问令牌。'); return; }
    setAuthBusy(true);
    setAuthError(null);
    try {
      const identity = await validateToken(token);
      saveSessionToken(token);
      setSession(identity);
      setTokenInput('');
      setConnectionIssue(null);
      if (!window.location.hash) window.location.hash = '#knowledge-bases';
      notify('连接成功', 'success');
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '连接失败。请检查令牌后重试。');
    } finally { setAuthBusy(false); }
  }

  if (!authReady || authChecking) return <main className="auth-loading"><LoadingState label="正在恢复当前标签页的连接…" /></main>;
  if (!session) return <ConnectPage
    token={tokenInput}
    onToken={setTokenInput}
    showToken={showToken}
    onToggleShow={() => setShowToken((value) => !value)}
    busy={authBusy}
    error={authError}
    onSubmit={connect}
  />;

  const workspace: WorkspaceValue = {
    session, knowledgeBases, knowledgeBasesLoading, knowledgeBasesError, reloadKnowledgeBases,
    route, navigate, notify, clearNotifications, logout,
  };
  const currentBase = knowledgeBases.find((item) => item.knowledgeBaseId === route.knowledgeBaseId);
  const admin = isAdmin(session.principal);
  const title = route.screen === 'knowledge' ? currentBase?.name ?? '知识库'
    : route.screen === 'search' ? '文档检索'
      : route.screen === 'tasks' ? '任务中心' : '访问权限';

  return <WorkspaceContext.Provider value={workspace}>
    <a className="skip-link" href="#main-content" onClick={(event) => { event.preventDefault(); mainRef.current?.focus(); }}>跳转到主要内容</a>
    <div className={`app-shell ${collapsed ? 'app-shell--collapsed' : ''}`}>
      {mobileNavOpen && <button type="button" className="mobile-scrim" aria-label="关闭导航" onClick={() => setMobileNavOpen(false)} />}
      <aside className={`sidebar ${mobileNavOpen ? 'sidebar--mobile-open' : ''}`} aria-label="主导航">
        <div className="sidebar__brand">
          <div className="brand-mark" aria-hidden="true"><BookOpenText size={19} strokeWidth={2} /></div>
          <div className="brand-copy"><strong>文档工作台</strong><span>PI DOCUMENT</span></div>
          <IconButton label="关闭导航" className="sidebar__mobile-close" onClick={() => setMobileNavOpen(false)}><X size={18} aria-hidden="true" /></IconButton>
        </div>
        <div className="sidebar__section-label">工作区</div>
        <nav className="sidebar__nav">
          <NavItem active={route.screen === 'knowledge'} icon={<Database size={18} />} label="知识库" onClick={() => navigate({ screen: 'knowledge' })} />
          <NavItem active={route.screen === 'search'} icon={<FileSearch size={18} />} label="文档检索" onClick={() => navigate({ screen: 'search', ...(route.knowledgeBaseId ? { knowledgeBaseId: route.knowledgeBaseId } : {})})} />
          <NavItem active={route.screen === 'tasks'} icon={<Activity size={18} />} label="任务中心" onClick={() => navigate({ screen: 'tasks' })} />
        </nav>
        <div className="sidebar__section-label sidebar__section-label--spaced">管理</div>
        <nav className="sidebar__nav">
          <NavItem active={route.screen === 'access'} icon={<Shield size={18} />} label="访问权限" onClick={() => navigate({ screen: 'access', ...(route.knowledgeBaseId ? { knowledgeBaseId: route.knowledgeBaseId } : {})})} />
        </nav>
        <div className="sidebar__spacer" />
        <div className="sidebar__capabilities" aria-label="服务能力">
          <div className="sidebar__capabilities-title"><span className="live-dot" aria-hidden="true" />服务能力</div>
          <Capability enabled={session.capabilities.indexing} label="文档索引" />
          <Capability enabled={session.capabilities.uploads} label="文件上传" />
          <Capability enabled={session.capabilities.natural} label="自然语言任务" />
        </div>
        <div className="sidebar__footer">
          <span className="sidebar__footer-icon"><CircleHelp size={16} aria-hidden="true" /></span>
          <span>仅连接当前服务</span>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="topbar__left">
            <IconButton label={collapsed ? '展开侧边导航' : '收起侧边导航'} className="collapse-control" onClick={() => setCollapsed((value) => !value)}>
              {collapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
            </IconButton>
            <IconButton label="打开导航菜单" className="mobile-menu-control" onClick={() => setMobileNavOpen(true)}><Menu size={19} aria-hidden="true" /></IconButton>
            <nav className="breadcrumbs" aria-label="面包屑">
              <span className="breadcrumbs__root">工作区</span><span aria-hidden="true">/</span><strong>{title}</strong>
            </nav>
          </div>
          <div className="topbar__right">
            <span className="connection-state"><span className={`connection-state__dot ${connectionIssue ? 'connection-state__dot--warning' : ''}`} aria-hidden="true" />{connectionIssue ? '连接异常' : '已连接'}</span>
            <div className="identity-chip" title={`${session.principal.tenantId} · ${session.principal.id}`}>
              <span className="identity-chip__avatar" aria-hidden="true">{session.principal.id.slice(0, 1).toUpperCase()}</span>
              <span className="identity-chip__name">{session.principal.id}</span>
              {admin && <StatusPill label="管理员" tone="info" />}
            </div>
            <Button variant="quiet" size="sm" className="logout-button" onClick={logout}><LogOut size={15} aria-hidden="true" /><span>退出</span></Button>
          </div>
        </header>
        {connectionIssue && <div className="connection-banner"><Alert tone="warning">{connectionIssue}</Alert></div>}
        <main id="main-content" ref={mainRef} className="main-content" tabIndex={-1}>
          {route.screen === 'knowledge' && <KnowledgePage />}
          {route.screen === 'search' && <SearchPage />}
          {route.screen === 'tasks' && <TasksPage />}
          {route.screen === 'access' && <AccessPage />}
        </main>
      </div>
    </div>
    <div className="toast-region" aria-live="polite" aria-atomic="true">
      {toasts.map((toast) => <div className={`toast toast--${toast.tone}`} key={toast.id}><Check size={16} aria-hidden="true" /><span>{toast.text}</span></div>)}
    </div>
  </WorkspaceContext.Provider>;
}

function NavItem({ active, icon, label, onClick }: { active: boolean; icon: ReactNode; label: string; onClick: () => void }) {
  return <button className={`nav-item ${active ? 'nav-item--active' : ''}`} type="button" aria-label={label} title={label} aria-current={active ? 'page' : undefined} onClick={onClick}>
    <span className="nav-item__icon" aria-hidden="true">{icon}</span><span>{label}</span>
  </button>;
}

function Capability({ enabled, label }: { enabled: boolean; label: string }) {
  return <div className="capability-row"><span className={`capability-row__state ${enabled ? 'is-on' : ''}`} aria-hidden="true" /><span>{label}</span><span className="capability-row__value">{enabled ? '已启用' : '未启用'}</span></div>;
}

function ConnectPage({
  token, onToken, showToken, onToggleShow, busy, error, onSubmit,
}: {
  token: string;
  onToken: (token: string) => void;
  showToken: boolean;
  onToggleShow: () => void;
  busy: boolean;
  error: string | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return <main className="connect-page">
    <div className="connect-page__top"><div className="brand-mark" aria-hidden="true"><BookOpenText size={20} /></div><span>PI DOCUMENT</span></div>
    <section className="connect-card" aria-labelledby="connect-title">
      <div className="connect-card__icon"><KeyRound size={20} aria-hidden="true" /></div>
      <p className="eyebrow">安全连接</p>
      <h1 id="connect-title">连接文档服务</h1>
      <p className="connect-card__intro">使用管理员为你签发的访问令牌。连接后可查看当前身份实际拥有的知识库与权限。</p>
      {error && <Alert tone="error" title="连接失败">{error}</Alert>}
      <form className="connect-form" onSubmit={onSubmit}>
        <label htmlFor="access-token">访问令牌</label>
        <div className="token-input-wrap">
          <input
            id="access-token"
            type={showToken ? 'text' : 'password'}
            value={token}
            onChange={(event) => onToken(event.currentTarget.value)}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            aria-describedby="token-hint"
            placeholder="粘贴服务访问令牌"
          />
          <button className="token-visibility" type="button" onClick={onToggleShow} aria-pressed={showToken}>{showToken ? '隐藏' : '显示'}</button>
        </div>
        <p id="token-hint" className="field__hint">令牌仅保存在当前标签页，退出后清除。</p>
        <Button type="submit" variant="primary" className="connect-submit" disabled={busy || !token.trim()}>
          {busy ? <><span className="button-spinner" aria-hidden="true" />正在验证</> : '验证并连接'}
        </Button>
      </form>
      <div className="connect-security"><Shield size={16} aria-hidden="true" /><span>此页面只向当前服务地址发送令牌</span></div>
      <div className="connect-origin"><span>当前服务</span><code>{originLabel()}</code></div>
    </section>
    <p className="connect-page__footer">私有文档工作区 <span>·</span> 身份与权限由服务端验证</p>
  </main>;
}
