import { useState } from 'react';
import { useApi } from '../auth';
import type { PluginsResponse, ProvidersResponse, SyncResult } from '../types';
import { describeError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Link } from '../router';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataStateBadge,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  SkeletonRows,
  TableFrame,
  useToast,
  IconButton,
  InlineNote,
} from '../ui';

const BILLING_LABEL: Record<string, string> = {
  subscription: '订阅',
  metered: '按量',
};

interface SyncFeedback {
  busy: boolean;
  result?: SyncResult;
  error?: string;
}

export function ProvidersPage() {
  const api = useApi();
  const toast = useToast();
  const providers = useAsync((signal) => api<ProvidersResponse>('/api/admin/providers', { signal }), []);
  const plugins = useAsync((signal) => api<PluginsResponse>('/api/admin/plugins', { signal }), []);
  const [syncState, setSyncState] = useState<Record<string, SyncFeedback>>({});
  const [disableTarget, setDisableTarget] = useState<{ id: string; name: string } | null>(null);
  const [disabling, setDisabling] = useState(false);

  const pluginName = (id: string) => plugins.data?.items.find((plugin) => plugin.id === id)?.name ?? id;

  const syncProvider = async (id: string) => {
    setSyncState((current) => ({ ...current, [id]: { busy: true } }));
    try {
      const result = await api<SyncResult>(`/api/admin/providers/${encodeURIComponent(id)}/sync`, { method: 'POST' });
      setSyncState((current) => ({ ...current, [id]: { busy: false, result } }));
      if (result.ok) {
        toast.push('目录与额度同步完成。');
      } else {
        toast.push(result.error ? `同步失败：${result.error}` : '同步失败，已保留上一次快照。', 'bad');
      }
      providers.reload();
    } catch (error) {
      const message = describeError(error);
      setSyncState((current) => ({ ...current, [id]: { busy: false, error: message } }));
      toast.push(`同步失败：${message}`, 'bad');
    }
  };

  const disableProvider = async () => {
    if (!disableTarget) return;
    setDisabling(true);
    try {
      await api(`/api/admin/providers/${encodeURIComponent(disableTarget.id)}`, { method: 'DELETE' });
      toast.push(`已停用 ${disableTarget.name}，历史记录保留。`);
      setDisableTarget(null);
      providers.reload();
    } catch (error) {
      toast.push(`停用失败：${describeError(error)}`, 'bad');
    } finally {
      setDisabling(false);
    }
  };

  const items = providers.data?.items ?? [];

  return (
    <div className="page">
      <PageHeader
        title="供应商"
        description="账号、上游凭据、代理与自动令牌模板。凭据只提交到服务端，列表不会回传。"
        actions={
          <>
            <Button icon="refresh" onClick={providers.reload} loading={providers.refreshing}>
              刷新
            </Button>
            <Link className="btn btn--primary btn--md" to={{ name: 'provider-new' }}>
              <Icon name="plus" size={16} /> 新增供应商
            </Link>
          </>
        }
      />

      <InlineNote>
        停用是软停用：保留历史请求与账目，不删除上游账号。目录与额度的完整刷新由每条供应商的「同步」触发，失败时保留上一次成功快照。
      </InlineNote>

      <div className="card">
        <div className="card__body">
          {providers.error ? <ErrorState error={providers.error} onRetry={providers.reload} /> : null}
          {providers.loading && !providers.data ? <SkeletonRows rows={5} /> : null}
          {!providers.loading && providers.data && items.length === 0 && !providers.error ? (
            <EmptyState
              title="还没有接入供应商"
              description="填写命名空间、插件与 base URL 后，才能同步模型目录与余额。自动创建上游令牌默认关闭。"
              action={
                <Link className="btn btn--primary btn--md" to={{ name: 'provider-new' }}>
                  <Icon name="plus" size={16} /> 接入第一个供应商
                </Link>
              }
            />
          ) : null}
          {items.length > 0 ? (
            <TableFrame label="供应商列表">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">供应商</th>
                    <th scope="col">插件 / 计费</th>
                    <th scope="col">上游地址</th>
                    <th scope="col">令牌策略</th>
                    <th scope="col">状态</th>
                    <th scope="col">更新时间</th>
                    <th scope="col" className="col-actions">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((provider) => {
                    const feedback = syncState[provider.id];
                    return (
                      <tr key={provider.id} className={provider.enabled ? undefined : 'row--muted'}>
                        <td>
                          <div className="cell-stack">
                            <strong>{provider.name}</strong>
                            <span className="mono small">{provider.namespace}</span>
                          </div>
                        </td>
                        <td>
                          <div className="cell-stack">
                            <span>{pluginName(provider.plugin)}</span>
                            <span className="small muted">
                              {BILLING_LABEL[provider.billingType] ?? provider.billingType} · {provider.plugin}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="cell-stack">
                            <span className="mono small break">{provider.baseUrl}</span>
                            <span className="small muted break">
                              {provider.proxyUrl ? `代理 ${provider.proxyUrl}` : '直连'}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="cell-stack">
                            <Badge tone={provider.autoCreateTokens ? 'accent' : 'neutral'}>
                              {provider.autoCreateTokens ? '自动创建开启' : '自动创建关闭'}
                            </Badge>
                            <span className="small muted">
                              {provider.tokenTemplate
                                ? `${provider.tokenTemplate.namePrefix || '未命名'} · 额度 ${provider.tokenTemplate.unlimited ? '不限' : provider.tokenTemplate.quota}`
                                : '未配置模板'}
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="cell-stack">
                            <Badge tone={provider.enabled ? 'ok' : 'neutral'}>{provider.enabled ? '已启用' : '已停用'}</Badge>
                            {feedback?.result ? (
                              <span className="inline-feedback">
                                <DataStateBadge state={feedback.result.state} />
                              </span>
                            ) : null}
                            {feedback?.error ? <span className="small danger-text">{feedback.error}</span> : null}
                            {feedback?.result?.error ? <span className="small danger-text">{feedback.result.error}</span> : null}
                          </div>
                        </td>
                        <td className="nowrap small">{formatDateTime(provider.updatedAt)}</td>
                        <td>
                          <div className="row-actions">
                            <Link
                              className="btn btn--secondary btn--sm"
                              to={{ name: 'provider-edit', id: provider.id }}
                            >
                              <Icon name="edit" size={15} /> 编辑
                            </Link>
                            <IconButton
                              label={`同步 ${provider.name}`}
                              icon="sync"
                              disabled={!provider.enabled || feedback?.busy}
                              onClick={() => void syncProvider(provider.id)}
                            />
                            <IconButton
                              label={`停用 ${provider.name}`}
                              icon="trash"
                              disabled={!provider.enabled}
                              onClick={() => setDisableTarget({ id: provider.id, name: provider.name })}
                            />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableFrame>
          ) : null}
          {plugins.error ? (
            <p className="small muted card-note">插件名称读取失败，当前显示插件 ID。{describeError(plugins.error)}</p>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={disableTarget !== null}
        title="停用这个供应商？"
        description={
          <>
            <p>
              将停用 <strong>{disableTarget?.name}</strong> 及其目录条目。在途请求不会被主动打断，历史请求、费用与账单全部保留。
            </p>
            <p className="muted">之后可以编辑该供应商并重新启用；不会删除服务端的上游凭据。</p>
          </>
        }
        confirmLabel="停用供应商"
        busy={disabling}
        onConfirm={() => void disableProvider()}
        onClose={() => setDisableTarget(null)}
      />
    </div>
  );
}
