import { useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '../auth';
import type {
  PluginsResponse,
  ProviderAccount,
  ProviderDeletion,
  ProviderDeletionsResponse,
  ProvidersResponse,
  SyncResult,
} from '../types';
import { describeError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Link } from '../router';
import type { ProxyView } from '../lib/contracts';
import { DeletionStatusBadge, ProviderDeletionDialog, ProviderDeletionsPanel } from './ProviderDeletion';
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
  const proxies = useAsync(signal => api<{ items: ProxyView[] }>('/api/admin/proxies', { signal }), []);
  const deletions = useAsync((signal) => api<ProviderDeletionsResponse>('/api/admin/provider-deletions', { signal }), []);
  const [syncState, setSyncState] = useState<Record<string, SyncFeedback>>({});
  const [disableTarget, setDisableTarget] = useState<{ id: string; name: string } | null>(null);
  const [deletionTarget, setDeletionTarget] = useState<ProviderAccount | null>(null);
  const [disabling, setDisabling] = useState(false);
  const lastStaleCompletion = useRef('');

  const taskItems = deletions.data?.items ?? [];
  const hasActiveDeletion = taskItems.some((task) => task.status === 'draining' || task.status === 'cleaning');

  // 只有存在排空/清理中的任务时才定期读取；读取失败或任务停止后立即清理计时器。
  useEffect(() => {
    if (!hasActiveDeletion || deletions.error) return;
    const timer = window.setInterval(() => deletions.reload(), 3000);
    return () => window.clearInterval(timer);
  }, [hasActiveDeletion, deletions.error, deletions.reload]);

  // 任务完成后刷新供应商列表，确保已删除账号从活动列表消失；初次读取恰好遇到完成也在此兜底。
  useEffect(() => {
    if (!deletions.data || !providers.data) return;
    const stale = deletions.data.items
      .filter(
        (task) =>
          providers.data!.items.some((provider) => provider.id === task.accountId &&
            (task.status === 'completed' || (task.status === 'cancelled' && provider.deletionTaskId === task.id))),
      )
      .map((task) => task.id)
      .sort()
      .join(',');
    if (stale && stale !== lastStaleCompletion.current) {
      lastStaleCompletion.current = stale;
      providers.reload();
    } else if (!stale) {
      lastStaleCompletion.current = '';
    }
  }, [deletions.data, providers.data, providers.reload]);

  const pluginName = (id: string) => plugins.data?.items.find((plugin) => plugin.id === id)?.name ?? id;
  const needsAuthorization = (id: string) =>
    plugins.data?.items.find((plugin) => plugin.id === id)?.setup?.authorization?.supported === true;

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

  const openDeletionProgress = (taskId: string) => {
    const element = document.getElementById(`deletion-task-${taskId}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
      element.focus({ preventScroll: true });
    } else toast.push('删除任务列表还没有读取到，请稍后刷新后重试。', 'bad');
  };

  const startDeletion = (task: ProviderDeletion) => {
    setDeletionTarget(null);
    toast.push(`已开始彻底删除 ${task.name}；进度会持久保存在服务端。`);
    providers.reload();
    deletions.reload();
    window.setTimeout(() => {
      const element = document.getElementById(`deletion-task-${task.id}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      element?.focus({ preventScroll: true });
    }, 600);
  };

  const items = providers.data?.items ?? [];
  const deletionById = useMemo(
    () => new Map(taskItems.map((task) => [task.id, task])),
    [deletions.data],
  );
  const activeAccountIds = useMemo(() => new Set(items.map((provider) => provider.id)), [providers.data]);

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
        停用是软停用：保留历史请求与账目，不删除上游配置。彻底删除是独立流程：先预览可清理的上游资源，输入命名空间确认后才开始，且不可撤销。历史请求、费用与账单保留，旧备份可能仍含加密凭据。
        目录与额度的完整刷新由每条供应商的「同步」触发，失败时保留上一次成功快照。
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
                    const deletionTask = provider.deletionTaskId
                      ? deletionById.get(provider.deletionTaskId)
                      : undefined;
                    const deletionLocked = Boolean(provider.deletionTaskId);
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
                              {provider.proxyId ? `代理：${proxies.data?.items.find(item => item.id === provider.proxyId)?.name ?? '档案待读取或缺失'}` : provider.proxyId === null ? '直连' : provider.proxyUrl ? `旧代理 ${provider.proxyUrl}` : '直连'}
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
                            {deletionLocked ? (
                              <span className="inline-feedback">
                                <DeletionStatusBadge status={deletionTask?.status} />
                                <span className="small muted">彻底删除流程</span>
                              </span>
                            ) : null}
                            {feedback?.result ? (
                              <span className="inline-feedback">
                                <DataStateBadge state={feedback.result.state} />
                              </span>
                            ) : null}
                            {feedback?.error ? <span className="small danger-text">{feedback.error}</span> : null}
                            {feedback?.result?.error ? <span className="small danger-text">{feedback.result.error}</span> : null}
                            {needsAuthorization(provider.plugin) && !deletionLocked ? (
                              <Link className="small text-link" to={{ name: 'provider-edit', id: provider.id }}>
                                授权 / 检查接入步骤
                              </Link>
                            ) : null}
                          </div>
                        </td>
                        <td className="nowrap small">{formatDateTime(provider.updatedAt)}</td>
                        <td>
                          <div className="row-actions">
                            <Link
                              className="btn btn--secondary btn--sm"
                              to={{ name: 'provider-edit', id: provider.id }}
                              aria-label={`${deletionLocked ? '查看 / 修复' : '编辑'} ${provider.name}`}
                            >
                              <Icon name="edit" size={15} /> {deletionLocked ? '查看 / 修复' : '编辑'}
                            </Link>
                            <Button
                              size="sm"
                              variant="secondary"
                              icon="sync"
                              aria-label={`同步 ${provider.name}`}
                              loading={feedback?.busy}
                              disabled={!provider.enabled || deletionLocked || feedback?.busy}
                              onClick={() => void syncProvider(provider.id)}
                            >
                              同步
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              aria-label={`停用 ${provider.name}`}
                              disabled={!provider.enabled || deletionLocked}
                              onClick={() => setDisableTarget({ id: provider.id, name: provider.name })}
                            >
                              停用
                            </Button>
                            {provider.deletionTaskId ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                icon="activity"
                                aria-label={`删除进度 ${provider.name}`}
                                onClick={() => openDeletionProgress(provider.deletionTaskId!)}
                              >
                                删除进度
                              </Button>
                            ) : (
                              <Button
                                size="sm"
                                variant="danger"
                                icon="trash"
                                aria-label={`彻底删除 ${provider.name}`}
                                onClick={() => setDeletionTarget(provider)}
                              >
                                彻底删除
                              </Button>
                            )}
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

      <ProviderDeletionsPanel
        items={taskItems}
        loading={deletions.loading}
        refreshing={deletions.refreshing}
        error={deletions.error}
        onReload={deletions.reload}
        onChanged={providers.reload}
        activeAccountIds={activeAccountIds}
      />

      <ConfirmDialog
        open={disableTarget !== null}
        title="停用这个供应商？"
        description={
          <>
            <p>
              将停用 <strong>{disableTarget?.name}</strong> 及其目录条目。在途请求不会被主动打断，历史请求、费用与账单全部保留。
            </p>
            <p className="muted">
              之后可以编辑该供应商并重新启用；不会删除服务端的上游凭据。要删除配置与清理上游资源，请使用独立的「彻底删除」流程。
            </p>
          </>
        }
        confirmLabel="停用供应商"
        busy={disabling}
        onConfirm={() => void disableProvider()}
        onClose={() => setDisableTarget(null)}
      />

      {deletionTarget ? (
        <ProviderDeletionDialog
          provider={deletionTarget}
          onClose={() => setDeletionTarget(null)}
          onStarted={startDeletion}
        />
      ) : null}
    </div>
  );
}
