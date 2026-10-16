import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Check, CircleAlert, KeyRound, Plus, RefreshCw, RotateCcw, Shield, ShieldCheck, UserRound, UserRoundPlus, UserX } from 'lucide-react';
import { ApiError, managementApi } from '../api';
import type { AdminPrincipal, KBMember, KnowledgeBase, Scope } from '../types';
import { hasScope, isAdmin } from '../types';
import { useWorkspace } from '../App';
import { Alert, Button, CopyButton, Dialog, EmptyState, Field, LoadingState, PageHeading, StatusPill } from '../components';

const principalScopeOptions: Array<{ value: Scope; label: string; description: string }> = [
  { value: 'knowledge:read', label: '读取', description: '列出知识库、读取原文、检索与查看任务。' },
  { value: 'knowledge:write', label: '写入', description: '创建知识库与保存、更新文档。' },
  { value: 'knowledge:delete', label: '删除', description: '删除文档。' },
  { value: 'knowledge:admin', label: '管理员', description: '管理当前工作区身份与知识库权限。' },
];

const memberScopeOptions: Array<{ value: string; label: string; description: string }> = [
  { value: 'knowledge:read', label: '读取', description: '查看原文与执行检索。' },
  { value: 'knowledge:write', label: '写入', description: '保存和更新文档。' },
  { value: 'knowledge:delete', label: '删除', description: '删除文档。' },
];

export function AccessPage() {
  const workspace = useWorkspace();
  const { session, knowledgeBases, knowledgeBasesLoading, route, navigate, notify } = workspace;
  const admin = isAdmin(session.principal);
  const [principals, setPrincipals] = useState<AdminPrincipal[]>([]);
  const [principalsLoading, setPrincipalsLoading] = useState(false);
  const [principalsError, setPrincipalsError] = useState<string | null>(null);
  const [selectedKBId, setSelectedKBId] = useState(route.knowledgeBaseId ?? knowledgeBases[0]?.knowledgeBaseId ?? '');
  const selectedKBRef = useRef(selectedKBId);
  selectedKBRef.current = selectedKBId;
  const accessSequence = useRef(0);
  const [members, setMembers] = useState<KBMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState<string | null>(null);
  const [myScopes, setMyScopes] = useState<string[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [tokenDialog, setTokenDialog] = useState<{ title: string; principalId: string; token: string } | null>(null);
  const [rotatePrincipal, setRotatePrincipal] = useState<AdminPrincipal | null>(null);
  const [revokePrincipal, setRevokePrincipal] = useState<AdminPrincipal | null>(null);
  const [memberPrincipalId, setMemberPrincipalId] = useState('');
  const [memberScopes, setMemberScopes] = useState<string[]>(['knowledge:read']);
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberActionError, setMemberActionError] = useState<string | null>(null);
  const [removeMember, setRemoveMember] = useState<KBMember | null>(null);
  const [removeMemberKBId, setRemoveMemberKBId] = useState('');
  const [principalActionBusy, setPrincipalActionBusy] = useState<string | null>(null);
  const [principalActionError, setPrincipalActionError] = useState<string | null>(null);
  const [rotationUnknownId, setRotationUnknownId] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState('');

  useEffect(() => {
    const nextKBId = route.knowledgeBaseId ?? (selectedKBId || knowledgeBases[0]?.knowledgeBaseId);
    if (nextKBId && nextKBId !== selectedKBId) {
      accessSequence.current += 1;
      selectedKBRef.current = nextKBId;
      setMembers([]);
      setMyScopes([]);
      setMembersLoading(Boolean(nextKBId));
      setMembersError(null);
      setMemberPrincipalId('');
      setMemberActionError(null);
      setRemoveMember(null);
      setRemoveMemberKBId('');
      setSelectedKBId(nextKBId);
    }
  }, [route.knowledgeBaseId, knowledgeBases, selectedKBId]);

  async function loadPrincipals() {
    if (!admin) return;
    setPrincipalsLoading(true); setPrincipalsError(null);
    try { setPrincipals((await managementApi.principals()).principals); }
    catch (cause) { setPrincipalsError(cause instanceof Error ? cause.message : '凭据列表读取失败。'); }
    finally { setPrincipalsLoading(false); }
  }

  async function loadKBAccess(knowledgeBaseId = selectedKBId) {
    const sequence = ++accessSequence.current;
    setMembers([]);
    setMyScopes([]);
    setMembersLoading(Boolean(knowledgeBaseId));
    if (!knowledgeBaseId) { setMembersLoading(false); setMembersError(null); return; }
    setMembersLoading(true); setMembersError(null);
    try {
      if (admin) {
        const response = await managementApi.members(knowledgeBaseId);
        if (sequence === accessSequence.current && selectedKBRef.current === knowledgeBaseId) setMembers(response.members);
      } else {
        const response = await managementApi.permissions(knowledgeBaseId);
        if (sequence === accessSequence.current && selectedKBRef.current === knowledgeBaseId) setMyScopes(response.scopes);
      }
    } catch (cause) {
      if (sequence === accessSequence.current && selectedKBRef.current === knowledgeBaseId) {
        setMembers([]);
        setMyScopes([]);
        setMembersError(cause instanceof Error ? cause.message : '知识库权限读取失败。');
      }
    } finally {
      if (sequence === accessSequence.current && selectedKBRef.current === knowledgeBaseId) setMembersLoading(false);
    }
  }

  useEffect(() => { if (admin) void loadPrincipals(); }, [admin]);
  useEffect(() => { if (selectedKBId) void loadKBAccess(selectedKBId); }, [selectedKBId, admin]);

  function chooseKnowledgeBase(value: string) {
    accessSequence.current += 1;
    selectedKBRef.current = value;
    setMembers([]);
    setMyScopes([]);
    setMembersLoading(Boolean(value));
    setMembersError(null);
    setMemberPrincipalId('');
    setMemberActionError(null);
    setRemoveMember(null);
    setRemoveMemberKBId('');
    setSelectedKBId(value);
    navigate({ screen: 'access', ...(value ? { knowledgeBaseId: value } : {}) });
  }

  function editMember(member?: KBMember) {
    const id = member?.principalId ?? principals.find((item) => !item.revoked && !members.some((existing) => existing.principalId === item.id))?.id ?? '';
    setMemberPrincipalId(id);
    setMemberScopes(member?.scopes ?? ['knowledge:read']);
    setMemberActionError(null);
  }

  function toggleMemberScope(scope: string) {
    setMemberScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]);
  }

  async function saveMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedKBId || !memberPrincipalId) return;
    const targetKnowledgeBaseId = selectedKBId;
    const targetPrincipalId = memberPrincipalId;
    setMemberBusy(true); setMemberActionError(null);
    try {
      await managementApi.putMember(targetKnowledgeBaseId, targetPrincipalId, memberScopes);
      if (selectedKBRef.current === targetKnowledgeBaseId) {
        setMemberPrincipalId('');
        await loadKBAccess(targetKnowledgeBaseId);
        notify('知识库权限已保存');
      }
    } catch (cause) {
      if (selectedKBRef.current === targetKnowledgeBaseId) setMemberActionError(cause instanceof Error ? cause.message : '权限保存失败。');
    } finally { if (selectedKBRef.current === targetKnowledgeBaseId) setMemberBusy(false); }
  }

  async function removeMemberNow() {
    if (!removeMember || !removeMemberKBId) return;
    const targetKnowledgeBaseId = removeMemberKBId;
    const targetPrincipalId = removeMember.principalId;
    setMemberBusy(true); setMemberActionError(null);
    try {
      await managementApi.deleteMember(targetKnowledgeBaseId, targetPrincipalId);
      setRemoveMember(null);
      setRemoveMemberKBId('');
      if (selectedKBRef.current === targetKnowledgeBaseId) {
        await loadKBAccess(targetKnowledgeBaseId);
        notify('知识库成员权限已移除', 'info');
      }
    } catch (cause) {
      if (selectedKBRef.current === targetKnowledgeBaseId) setMemberActionError(cause instanceof Error ? cause.message : '成员移除失败。');
    } finally { if (selectedKBRef.current === targetKnowledgeBaseId) setMemberBusy(false); }
  }

  async function rotateNow() {
    if (!rotatePrincipal) return;
    const principal = rotatePrincipal;
    setPrincipalActionBusy(principal.id); setPrincipalActionError(null);
    try {
      const result = await managementApi.rotatePrincipal(principal.id);
      setRotationUnknownId(null);
      setRotatePrincipal(null);
      setTokenDialog({ title: '新访问令牌', principalId: principal.id, token: result.token });
      notify(`已轮换 ${principal.id} 的访问令牌`);
      await loadPrincipals();
    } catch (cause) {
      if (isUnknownManagementWrite(cause)) {
        setRotatePrincipal(null);
        setRotationUnknownId(principal.id);
        setPrincipalActionError('令牌轮换请求状态未知，已刷新身份列表。若新令牌没有显示，请再次轮换并保存新令牌；再次轮换会使之前的令牌失效。');
        await loadPrincipals();
      } else setPrincipalActionError(cause instanceof Error ? cause.message : '令牌轮换失败。');
    }
    finally { setPrincipalActionBusy(null); }
  }

  async function revokeNow() {
    if (!revokePrincipal) return;
    const principal = revokePrincipal;
    setPrincipalActionBusy(principal.id); setPrincipalActionError(null);
    try {
      await managementApi.revokePrincipal(principal.id);
      setRevokePrincipal(null);
      notify(`已撤销 ${principal.id} 的访问令牌`, 'info');
      await loadPrincipals();
    } catch (cause) {
      if (isUnknownManagementWrite(cause)) {
        setRevokePrincipal(null);
        setPrincipalActionError('令牌撤销请求状态未知，已刷新身份列表。请查看该身份的当前状态后再决定是否重试。');
        await loadPrincipals();
      } else setPrincipalActionError(cause instanceof Error ? cause.message : '令牌撤销失败。');
    }
    finally { setPrincipalActionBusy(null); }
  }

  const currentKB = knowledgeBases.find((item) => item.knowledgeBaseId === selectedKBId);
  const eligiblePrincipals = principals.filter((item) => !item.revoked && (!members.some((member) => member.principalId === item.id) || item.id === memberPrincipalId));

  return <div className="page-wrap">
    <PageHeading eyebrow="安全管理" title="访问权限" description="管理服务身份令牌，并按知识库授予最小访问权限。" actions={admin && <Button onClick={() => setCreateOpen(true)} variant="primary"><UserRoundPlus size={16} aria-hidden="true" />创建身份</Button>} />
    {!admin && <Alert tone="info" title="只读权限视图">当前身份不是全局管理员。你可以查看自己在所选知识库中的权限，不能查看或修改其他身份凭据。</Alert>}
    {principalActionError && <Alert tone="error" title="身份凭据操作失败">{principalActionError}<Button size="sm" onClick={() => setPrincipalActionError(null)}>关闭</Button></Alert>}

    {admin && <section className="panel principal-panel">
      <div className="panel__header"><div><h2>服务身份</h2><p>每个身份使用独立令牌访问服务。令牌只在创建或轮换时显示一次。</p></div><Button variant="quiet" size="sm" onClick={() => void loadPrincipals()} disabled={principalsLoading}><RefreshCw size={15} aria-hidden="true" />刷新</Button></div>
      {principalsError && <Alert tone="error" title="身份列表加载失败">{principalsError}<Button size="sm" onClick={() => void loadPrincipals()}>重试读取</Button></Alert>}
      {principalsLoading && principals.length === 0 && <LoadingState label="正在读取身份…" />}
      {!principalsLoading && !principalsError && principals.length === 0 && <EmptyState title="还没有其他身份" description="创建身份后，可以给它签发独立令牌并授权特定知识库。" icon={<UserRound size={24} />} action={<Button variant="primary" onClick={() => setCreateOpen(true)}><Plus size={15} aria-hidden="true" />创建身份</Button>} />}
      {principals.length > 0 && <div className="table-scroll" role="region" aria-label="服务身份列表，可横向滚动" tabIndex={0}><table className="data-table principal-table">
        <thead><tr><th scope="col">身份</th><th scope="col">全局权限</th><th scope="col">状态</th><th scope="col">创建时间</th><th scope="col">操作</th></tr></thead>
        <tbody>{principals.map((principal) => {
          const self = principal.id === session.principal.id;
          return <tr key={principal.id}>
            <td><div className="principal-id-cell"><span className="principal-avatar"><UserRound size={16} aria-hidden="true" /></span><span><strong>{principal.id}</strong>{self && <small>当前登录身份</small>}</span></div></td>
            <td><div className="scope-badges">{principal.scopes.map((scope) => <span className="scope-badge" key={scope}>{scope.replace('knowledge:', '')}</span>)}</div></td>
            <td><StatusPill label={principal.revoked ? '已撤销' : '有效'} tone={principal.revoked ? 'danger' : 'success'} dot /></td>
            <td>{principal.createdAt ? formatDate(principal.createdAt) : '—'}</td>
            <td><div className="row-actions">
              <Button size="sm" onClick={() => setRotatePrincipal(principal)} disabled={principal.revoked || self || Boolean(principalActionBusy)} title={self ? '不能轮换当前正在使用的令牌，请通过管理员 CLI 操作' : undefined}><RotateCcw size={14} aria-hidden="true" />{rotationUnknownId === principal.id ? '重新轮换' : '轮换'}</Button>
              <Button size="sm" variant="quiet" onClick={() => setRevokePrincipal(principal)} disabled={principal.revoked || self || Boolean(principalActionBusy)} title={self ? '不能撤销当前正在使用的令牌，请通过管理员 CLI 操作' : undefined}><UserX size={14} aria-hidden="true" />撤销</Button>
            </div></td>
          </tr>;
        })}</tbody>
      </table></div>}
    </section>}

    <section className="panel kb-access-panel">
      <div className="panel__header"><div><h2>知识库成员</h2><p>按知识库控制读取、写入与删除权限。</p></div>
        <div className="kb-access-panel__selector"><label htmlFor="access-kb">知识库</label><select id="access-kb" value={selectedKBId} onChange={(event) => chooseKnowledgeBase(event.currentTarget.value)} disabled={knowledgeBasesLoading || memberBusy || !knowledgeBases.length}>
          {!knowledgeBases.length && <option value="">没有可访问的知识库</option>}
          {knowledgeBases.map((item) => <option key={item.knowledgeBaseId} value={item.knowledgeBaseId}>{item.name}</option>)}
        </select></div>
      </div>
      {!knowledgeBasesLoading && knowledgeBases.length === 0 && <EmptyState title="没有可管理的知识库" description={admin ? '先创建一个知识库，再为其他身份配置成员权限。' : '请联系管理员授权知识库访问权限。'} icon={<Shield size={24} />} />}
      {knowledgeBasesLoading && !currentKB && <LoadingState label="正在读取知识库列表…" />}
      {currentKB && membersLoading && <LoadingState label="正在读取知识库权限…" />}
      {currentKB && membersError && <Alert tone="error" title="权限读取失败">{membersError}<Button size="sm" onClick={() => void loadKBAccess()}>重试读取</Button></Alert>}
      {currentKB && !membersLoading && !membersError && admin && <>
        <div className="kb-permission-summary"><div><span>知识库</span><strong>{currentKB.name}</strong></div><div><span>知识库 ID</span><code>{currentKB.knowledgeBaseId}</code></div><StatusPill label="管理员视图" tone="info" /></div>
        <div className="member-manager">
          <div className="member-list">
            <div className="member-list__heading"><h3>已授权身份</h3><span>{members.length} 个身份</span></div>
            {members.length === 0 && <p className="muted member-empty">尚未配置成员。</p>}
            {members.map((member) => <div className="member-row" key={member.principalId}>
              <span className="member-row__avatar"><UserRound size={15} aria-hidden="true" /></span><span className="member-row__identity"><strong>{member.principalId}</strong><span className="scope-badges">{member.scopes.map((scope) => <span className="scope-badge" key={scope}>{scope.replace('knowledge:', '')}</span>)}</span></span>
              <Button size="sm" onClick={() => editMember(member)}>编辑</Button><Button size="sm" variant="quiet" onClick={() => { setRemoveMember(member); setRemoveMemberKBId(selectedKBId); }}>移除</Button>
            </div>)}
          </div>
          <form className="member-form" onSubmit={saveMember}>
            <h3>{memberPrincipalId && members.some((item) => item.principalId === memberPrincipalId) ? '编辑成员权限' : '添加身份'}</h3>
            <Field label="身份" htmlFor="member-principal" required>
              <select id="member-principal" value={memberPrincipalId} onChange={(event) => { const value = event.currentTarget.value; const member = members.find((item) => item.principalId === value); setMemberPrincipalId(value); setMemberScopes(member?.scopes ?? ['knowledge:read']); }} required disabled={memberBusy || eligiblePrincipals.length === 0}>
                <option value="">选择一个有效身份</option>
                {eligiblePrincipals.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}
                {memberPrincipalId && members.some((item) => item.principalId === memberPrincipalId) && !eligiblePrincipals.some((item) => item.id === memberPrincipalId) && <option value={memberPrincipalId}>{memberPrincipalId}</option>}
              </select>
            </Field>
            <fieldset className="scope-checkboxes"><legend>授予权限</legend>{memberScopeOptions.map((option) => <label className="scope-option" key={option.value}><input type="checkbox" checked={memberScopes.includes(option.value)} onChange={() => toggleMemberScope(option.value)} disabled={memberBusy} /><span><strong>{option.label}</strong><small>{option.description}</small></span></label>)}</fieldset>
            {memberActionError && <Alert tone="error" title="权限更新失败">{memberActionError}</Alert>}
            <div className="member-form__actions"><Button type="button" variant="quiet" onClick={() => editMember()} disabled={memberBusy}>清空</Button><Button type="submit" variant="primary" disabled={memberBusy || !memberPrincipalId}>{memberBusy ? '保存中…' : '保存权限'}</Button></div>
          </form>
        </div>
      </>}
      {currentKB && !membersLoading && !membersError && !admin && <div className="self-permission-view"><div className="self-permission-view__heading"><ShieldCheck size={19} aria-hidden="true" /><strong>你在此知识库中的权限</strong></div><div className="scope-badges">{myScopes.length ? myScopes.map((scope) => <StatusPill key={scope} label={scopeLabel(scope)} tone="success" />) : <StatusPill label="没有有效权限" tone="warning" />}</div><p>权限由服务端校验；此处仅展示当前身份的有效范围。</p></div>}
    </section>

    <CreatePrincipalDialog open={createOpen} onClose={() => { setCreateOpen(false); void loadPrincipals(); }} onCreated={async (principal, token) => { setCreateOpen(false); setTokenDialog({ title: '新访问令牌', principalId: principal.id, token }); await loadPrincipals(); }} />
    <TokenDialog value={tokenDialog} onClose={() => setTokenDialog(null)} onCopy={setCopyFeedback} feedback={copyFeedback} />
    <Dialog open={Boolean(rotatePrincipal)} title={rotationUnknownId === rotatePrincipal?.id ? '重新轮换访问令牌' : '轮换访问令牌'} description="原令牌会立即失效。请在确认后将新令牌提供给对应身份。" onClose={() => { setRotatePrincipal(null); setPrincipalActionError(null); }} className="confirm-dialog" footer={<><Button onClick={() => setRotatePrincipal(null)} disabled={Boolean(principalActionBusy)}>取消</Button><Button variant="primary" onClick={() => void rotateNow()} disabled={Boolean(principalActionBusy)}><RotateCcw size={15} aria-hidden="true" />{principalActionBusy ? '正在轮换…' : rotationUnknownId === rotatePrincipal?.id ? '确认重新轮换' : '确认轮换'}</Button></>}>
      {rotatePrincipal && <div className="delete-summary"><div className="delete-summary__icon"><KeyRound size={18} aria-hidden="true" /></div><div><strong>{rotatePrincipal.id}</strong><p>旧访问令牌将在轮换完成时失效。</p></div></div>}
      {principalActionError && <Alert tone="error">{principalActionError}</Alert>}
    </Dialog>
    <Dialog open={Boolean(revokePrincipal)} title="撤销访问令牌" description="撤销后该身份将无法使用当前令牌访问服务。此操作无法撤回。" onClose={() => { setRevokePrincipal(null); setPrincipalActionError(null); }} className="confirm-dialog" footer={<><Button onClick={() => setRevokePrincipal(null)} disabled={Boolean(principalActionBusy)}>取消</Button><Button variant="danger" onClick={() => void revokeNow()} disabled={Boolean(principalActionBusy)}><UserX size={15} aria-hidden="true" />{principalActionBusy ? '正在撤销…' : '确认撤销'}</Button></>}>
      {revokePrincipal && <div className="delete-summary"><div className="delete-summary__icon"><UserX size={18} aria-hidden="true" /></div><div><strong>{revokePrincipal.id}</strong><p>此操作会立即使令牌失效。</p></div></div>}
      {principalActionError && <Alert tone="error">{principalActionError}</Alert>}
    </Dialog>
    <Dialog open={Boolean(removeMember)} title="移除知识库成员" description="身份将失去该知识库的成员权限。" onClose={() => { setRemoveMember(null); setRemoveMemberKBId(''); }} className="confirm-dialog" footer={<><Button onClick={() => { setRemoveMember(null); setRemoveMemberKBId(''); }} disabled={memberBusy}>取消</Button><Button variant="danger" onClick={() => void removeMemberNow()} disabled={memberBusy}>{memberBusy ? '正在移除…' : '确认移除'}</Button></>}>
      {removeMember && <div className="delete-summary"><div className="delete-summary__icon"><UserX size={18} aria-hidden="true" /></div><div><strong>{removeMember.principalId}</strong><p>{knowledgeBases.find((item) => item.knowledgeBaseId === removeMemberKBId)?.name}</p></div></div>}
      {memberActionError && <Alert tone="error">{memberActionError}</Alert>}
    </Dialog>
  </div>;
}

function CreatePrincipalDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (principal: AdminPrincipal, token: string) => Promise<void> }) {
  const [id, setId] = useState('');
  const [scopes, setScopes] = useState<Scope[]>(['knowledge:read']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState(false);
  useEffect(() => { if (open) { setId(''); setScopes(['knowledge:read']); setBusy(false); setError(null); setUnknown(false); } }, [open]);
  function toggle(scope: Scope) { setScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope]); }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      const result = await managementApi.createPrincipal(id.trim(), scopes);
      await onCreated(result.principal, result.token);
    } catch (cause) {
      if (isUnknownManagementWrite(cause)) {
        setUnknown(true);
        setError('创建请求状态未知。请关闭窗口并刷新身份列表；如果身份已创建但令牌没有显示，请为该身份轮换令牌。页面不会自动重复创建。');
      } else setError(cause instanceof Error ? cause.message : '身份创建失败。');
    }
    finally { setBusy(false); }
  }
  return <Dialog open={open} title="创建服务身份" description="创建独立身份与令牌。请按最小权限原则选择全局范围。" onClose={onClose} className="editor-dialog" footer={<><Button onClick={onClose} disabled={busy}>{unknown ? '关闭并刷新列表' : '取消'}</Button><Button type="submit" form="create-principal-form" variant="primary" disabled={busy || unknown || !id.trim() || scopes.length === 0}>{busy ? '正在创建…' : unknown ? '状态待确认' : '创建身份并签发令牌'}</Button></>}>
    {error && <Alert tone={unknown ? 'warning' : 'error'} title={unknown ? '创建状态未知' : '创建失败'}>{error}</Alert>}
    <form id="create-principal-form" className="editor-form" onSubmit={submit}>
      <Field label="身份 ID" htmlFor="new-principal-id" required hint="使用稳定且可识别的名称，例如 `search-worker`。"><input id="new-principal-id" value={id} onChange={(event) => setId(event.currentTarget.value)} maxLength={100} autoComplete="off" required disabled={busy} /></Field>
      <fieldset className="scope-checkboxes"><legend>全局权限</legend>{principalScopeOptions.map((option) => <label className="scope-option" key={option.value}><input type="checkbox" checked={scopes.includes(option.value)} onChange={() => toggle(option.value)} disabled={busy} /><span><strong>{option.label} <code>{option.value}</code></strong><small>{option.description}</small></span></label>)}</fieldset>
    </form>
  </Dialog>;
}

function TokenDialog({ value, onClose, onCopy, feedback }: { value: { title: string; principalId: string; token: string } | null; onClose: () => void; onCopy: (message: string) => void; feedback: string }) {
  return <Dialog open={Boolean(value)} title={value?.title ?? '访问令牌'} description="此令牌只显示一次。请复制并安全交付；关闭窗口后无法再次查看完整令牌。" onClose={onClose} className="token-dialog" footer={<Button variant="primary" onClick={onClose}>我已保存令牌</Button>}>
    {value && <div className="token-reveal"><Alert tone="warning" title="请立即复制并保存">关闭后令牌会从页面内存中清除。</Alert><div className="token-reveal__identity"><span>身份</span><strong>{value.principalId}</strong></div><label htmlFor="issued-token">访问令牌</label><textarea id="issued-token" value={value.token} readOnly rows={4} onFocus={(event) => event.currentTarget.select()} /><div className="token-reveal__actions"><CopyButton value={value.token} label="复制令牌" onCopy={onCopy} />{feedback && <span role="status">{feedback}</span>}</div></div>}
  </Dialog>;
}

function scopeLabel(scope: string) { return scope.replace('knowledge:', '') === 'read' ? '读取' : scope.replace('knowledge:', '') === 'write' ? '写入' : scope.replace('knowledge:', '') === 'delete' ? '删除' : scope; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
function isUnknownManagementWrite(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'NETWORK_ERROR' || (error.status ?? 0) >= 500);
}
