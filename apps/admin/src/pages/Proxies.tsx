import { useState, type FormEvent } from 'react';
import { useApi } from '../auth';
import type { ProxyDiagnostic, ProxyInput, ProxyView } from '../lib/contracts';
import { describeError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useUnsavedChanges } from '../lib/unsaved';
import { Link } from '../router';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, Field, FormGrid, InlineNote, Input, Modal, PageHeader, Select, SkeletonRows, TableFrame, useToast } from '../ui';

function ProxyForm({ profile, onSave, onClose }: { profile: ProxyView | null; onSave: (input: ProxyInput) => Promise<void>; onClose: () => void }) {
  const initial: ProxyInput = { name: profile?.name ?? '', protocol: profile?.protocol ?? 'http', host: profile?.host ?? '', port: profile?.port ?? 7890, username: profile?.username ?? '', passwordAction: 'keep' };
  const [draft, setDraft] = useState(initial);
  const [port, setPort] = useState(String(initial.port));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || port !== String(initial.port);
  useUnsavedChanges(dirty);
  const close = () => { if (!busy && (!dirty || window.confirm('代理修改尚未保存，确定放弃吗？'))) onClose(); };
  const update = <K extends keyof ProxyInput>(key: K, value: ProxyInput[K]) => setDraft(current => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave({ ...draft, port: Number(port) }); onClose(); }
    catch (reason) { setError(describeError(reason)); }
    finally { setBusy(false); }
  };
  return <Modal open title={profile ? '编辑代理档案' : '新增代理档案'} onClose={close} dismissible={!busy} size="lg" footer={<>
    <Button type="button" onClick={close} disabled={busy}>取消</Button><Button type="submit" form="proxy-form" variant="primary" loading={busy}>保存代理</Button>
  </>}>
    <form id="proxy-form" className="moris-modal-form" onSubmit={submit}>
      {profile?.references.length ? <InlineNote tone="warn">保存后会影响 {profile.references.map(item => item.name).join('、')} 的后续授权、同步与推理；未完成的设备授权需重新开始，进行中的请求不会重放。</InlineNote> : null}
      <FormGrid>
        <Field id="proxy-name" label="代理名称"><Input id="proxy-name" value={draft.name} onChange={e => update('name', e.target.value)} required maxLength={100} data-autofocus /></Field>
        <Field id="proxy-protocol" label="协议"><Select id="proxy-protocol" value={draft.protocol} onChange={e => update('protocol', e.target.value as ProxyInput['protocol'])}>{['http', 'https', 'socks5', 'socks5h'].map(value => <option key={value} value={value}>{value.toUpperCase()}</option>)}</Select></Field>
        <Field id="proxy-host" label="主机" hint="只填主机名或 IP；IPv6 使用方括号，不包含协议和端口。"><Input id="proxy-host" value={draft.host} onChange={e => update('host', e.target.value)} placeholder="host.docker.internal" required maxLength={253} /></Field>
        <Field id="proxy-port" label="端口"><Input id="proxy-port" type="number" value={port} onChange={e => setPort(e.target.value)} required min={1} max={65535} step={1} /></Field>
        <Field id="proxy-user" label="用户名" hint="无需手工 URL 编码；无认证代理留空。"><Input id="proxy-user" value={draft.username} onChange={e => update('username', e.target.value)} autoComplete="off" maxLength={255} /></Field>
        <Field id="proxy-password-action" label="密码操作" hint={profile?.hasPassword ? '已保存密码，不会回显。修改主机或端口不会清除密码。' : '尚未保存密码。'}><Select id="proxy-password-action" value={draft.passwordAction} onChange={e => setDraft(current => ({ ...current, passwordAction: e.target.value as ProxyInput['passwordAction'], password: undefined }))}>
          <option value="keep">{profile ? '保留已保存密码' : '不设置密码'}</option><option value="replace">设置／替换密码</option><option value="clear">清除密码</option>
        </Select></Field>
        {draft.passwordAction === 'replace' ? <Field id="proxy-password" label="新密码"><Input id="proxy-password" type="password" value={draft.password ?? ''} onChange={e => update('password', e.target.value)} autoComplete="new-password" maxLength={255} required /></Field> : null}
      </FormGrid>
      <InlineNote>容器里的 127.0.0.1 指向网关自身；宿主机代理可用 host.docker.internal，但必须监听容器可达的地址。公网优先使用 HTTPS 代理或可信加密网络。SOCKS5 认证需同时填写或清除用户名和密码。</InlineNote>
      {error ? <div role="alert"><InlineNote tone="bad">{error}</InlineNote></div> : null}
    </form>
  </Modal>;
}

export function ProxiesPage() {
  const api = useApi(); const toast = useToast();
  const profiles = useAsync(signal => api<{ items: ProxyView[] }>('/api/admin/proxies', { signal }), []);
  const [editing, setEditing] = useState<ProxyView | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<ProxyView | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [target, setTarget] = useState('cloudflare');
  const [diagnostics, setDiagnostics] = useState<Record<string, { target: string; busy?: boolean; result?: ProxyDiagnostic; error?: string }>>({});
  const diagnose = async (id: string) => {
    setDiagnostics(current => ({ ...current, [id]: { target, busy: true } }));
    try {
      const result = await api<ProxyDiagnostic>(`/api/admin/proxies/${encodeURIComponent(id)}/diagnose`, { method: 'POST', body: { target } });
      setDiagnostics(current => ({ ...current, [id]: { target, result } }));
    } catch (reason) { setDiagnostics(current => ({ ...current, [id]: { target, error: describeError(reason) } })); }
  };
  return <div className="page">
    <PageHeader title="代理配置" description="集中保存代理档案，供多个供应商复用。密码加密保存且不回显；不自动切换出口。" actions={<Button variant="primary" onClick={() => setEditing(null)}>新增代理</Button>} />
    <InlineNote>先保存档案，再到供应商编辑页选择它。旧内联代理不会自动迁移或改变；停用的供应商仍计入引用，解绑后才能删除档案。</InlineNote>
    <Field id="proxy-target" label="连接诊断目标" hint="从运行网关的进程／容器发送无令牌 HEAD 请求，最长 10 秒；不发推理、不验证账号授权，目标可能拒绝未认证探测。">
      <Select id="proxy-target" value={target} onChange={e => setTarget(e.target.value)}><option value="cloudflare">Cloudflare 公共站点</option><option value="openai">OpenAI API（预期可能返回 401）</option></Select>
    </Field>
    {profiles.loading ? <SkeletonRows /> : profiles.error ? <ErrorState error={profiles.error} onRetry={profiles.reload} /> : !profiles.data?.items.length ? <EmptyState title="还没有代理档案" description="新增一个档案后，即可在供应商中复用；不需要代理时继续使用直连。" /> :
      <TableFrame label="代理档案列表（窄屏可横向滚动）"><table className="table"><thead><tr><th>代理</th><th>认证</th><th>引用供应商</th><th>操作与诊断</th></tr></thead><tbody>{profiles.data.items.map(profile => {
        const diagnostic = diagnostics[profile.id];
        return <tr key={profile.id}><td><div className="cell-stack"><strong>{profile.name}</strong><span className="mono">{profile.protocol}://{profile.host}:{profile.port}</span></div></td>
          <td><Badge>{profile.username || profile.hasPassword ? '已配置认证' : '无认证'}</Badge></td>
          <td>{profile.references.length ? profile.references.map(item => <div key={item.id}><Link to={{ name: 'provider-edit', id: item.id }}>{item.name}</Link></div>) : '未引用'}</td>
          <td><div className="row-actions"><Button disabled={diagnostic?.busy} onClick={() => setEditing(profile)}>编辑</Button><Button loading={diagnostic?.busy} onClick={() => void diagnose(profile.id)}>诊断连接</Button><Button variant="danger" disabled={profile.references.length > 0} onClick={() => setDeleting(profile)}>删除</Button></div>
            {profile.references.length ? <p className="small muted">先解绑引用的供应商才能删除。</p> : null}
            <div role="status">{diagnostic ? `${diagnostic.target === 'openai' ? 'OpenAI API' : 'Cloudflare'}：${diagnostic.busy ? '正在探测，完成后可编辑代理。' : diagnostic.result ? `${diagnostic.result.message}${diagnostic.result.status ? `（HTTP ${diagnostic.result.status}）` : ''}` : diagnostic.error}` : null}</div>
          </td></tr>;
      })}</tbody></table></TableFrame>}
    {profiles.data?.items.length ? <p className="small muted">窄屏可横向滚动表格，查看引用和操作。</p> : null}
    {editing !== undefined ? <ProxyForm profile={editing} onClose={() => setEditing(undefined)} onSave={async input => {
      await api(`/api/admin/proxies${editing ? `/${encodeURIComponent(editing.id)}` : ''}`, { method: editing ? 'PATCH' : 'POST', body: input });
      setDiagnostics({}); profiles.reload(); toast.push('代理档案已保存。');
    }} /> : null}
    <ConfirmDialog open={Boolean(deleting)} title="删除代理档案？" description={`删除「${deleting?.name ?? ''}」后不能恢复。`} confirmLabel="删除代理" busy={deletingBusy} onClose={() => { if (!deletingBusy) setDeleting(null); }} onConfirm={async () => {
      if (!deleting) return; setDeletingBusy(true);
      try { await api(`/api/admin/proxies/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' }); setDeleting(null); profiles.reload(); toast.push('代理档案已删除。'); }
      catch (reason) { toast.push(describeError(reason), 'bad'); }
      finally { setDeletingBusy(false); }
    }} />
  </div>;
}
