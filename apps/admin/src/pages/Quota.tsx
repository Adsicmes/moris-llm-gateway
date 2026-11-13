import { useState } from 'react';
import { useApi } from '../auth';
import type { QuotaResponse, SyncResult } from '../types';
import { describeError } from '../lib/api';
import { formatAmount, formatDateTime, formatPercent, formatUsd } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Link } from '../router';
import {
  Badge,
  Button,
  DataStateBadge,
  EmptyState,
  ErrorState,
  Icon,
  InlineNote,
  PageHeader,
  ProgressBar,
  SkeletonRows,
  useToast,
} from '../ui';

export function QuotaPage() {
  const api = useApi();
  const toast = useToast();
  const quota = useAsync((signal) => api<QuotaResponse>('/api/admin/quota', { signal }), []);
  const [syncing, setSyncing] = useState<Record<string, boolean>>({});

  const sync = async (accountId: string, name: string) => {
    setSyncing((current) => ({ ...current, [accountId]: true }));
    try {
      const result = await api<SyncResult>(`/api/admin/providers/${encodeURIComponent(accountId)}/sync`, { method: 'POST' });
      toast.push(
        result.ok ? `${name} 的目录与额度已刷新。` : `${name} 同步失败：${result.error ?? '已保留上一次快照。'}`,
        result.ok ? 'ok' : 'bad',
      );
      quota.reload();
    } catch (error) {
      toast.push(`同步失败：${describeError(error)}`, 'bad');
    } finally {
      setSyncing((current) => ({ ...current, [accountId]: false }));
    }
  };

  const items = quota.data?.items ?? [];

  return (
    <div className="page">
      <PageHeader
        title="余额与额度"
        description="供应商原始余额、真实用量窗口与基于本网关记录的美元额度估算。三类数值分开显示。"
        actions={
          <>
            <Button icon="refresh" onClick={quota.reload} loading={quota.refreshing}>
              重新读取
            </Button>
            <Link className="btn btn--secondary btn--md" to={{ name: 'providers' }}>
              管理供应商
            </Link>
          </>
        }
      />

      <InlineNote tone="warn">
        余额与窗口可能包含网关外使用，不能把账户余额差额直接归因于本网关请求。未知、获取失败、过期与真实零余额分别标注；未知金额不会显示为 0。
      </InlineNote>

      {quota.error ? <ErrorState error={quota.error} onRetry={quota.reload} /> : null}
      {quota.loading && !quota.data ? <SkeletonRows rows={5} /> : null}

      {quota.data && items.length === 0 && !quota.error ? (
        <div className="card">
          <div className="card__body">
            <EmptyState
              title="还没有可读取的额度"
              description="接入供应商并完成一次成功同步后，余额和上游窗口才会出现。"
              action={
                <Link className="btn btn--primary btn--md" to={{ name: 'providers' }}>
                  去接入供应商
                </Link>
              }
            />
          </div>
        </div>
      ) : null}

      <div className="quota-list">
        {items.map((item) => {
          const { monitor } = item;
          const stateWarning = monitor.state !== 'ok';
          return (
            <article className="quota-card" key={item.accountId}>
              <header className="quota-card__head">
                <div>
                  <div className="quota-card__title">
                    <h2>{item.name}</h2>
                    <DataStateBadge state={monitor.state} />
                  </div>
                  <p className="mono small muted">
                    {item.namespace} · {item.accountId}
                  </p>
                </div>
                <div className="quota-card__head-actions">
                  <span className="small muted">采样 {formatDateTime(monitor.sampledAt)}</span>
                  <Button
                    size="sm"
                    icon="sync"
                    loading={syncing[item.accountId]}
                    onClick={() => void sync(item.accountId, item.name)}
                  >
                    同步
                  </Button>
                </div>
              </header>

              {stateWarning ? (
                <div className="inline-alert" role="status">
                  <Icon name="alert" size={16} />
                  <span>
                    数据状态为「{monitor.state === 'error' ? '获取失败' : monitor.state === 'stale' ? '已过期' : monitor.state === 'unsupported' ? '不支持' : '未知'}」，
                    以下不是实时值。{monitor.message ?? ''}
                  </span>
                </div>
              ) : monitor.message ? (
                <p className="quiet-note">{monitor.message}</p>
              ) : null}

              <div className="quota-card__grid">
                <section className="quota-section" aria-label={`${item.name} 余额`}>
                  <h3>供应商余额</h3>
                  {monitor.balances.length > 0 ? (
                    <ul className="balance-list">
                      {monitor.balances.map((balance, index) => (
                        <li key={`${balance.currency}-${balance.unit ?? ''}-${index}`}>
                          <span className="balance-list__amount">{formatAmount(balance.amount, balance.currency)}</span>
                          <span className="small muted">
                            {balance.currency}
                            {balance.unit ? ` · ${balance.unit}` : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{monitor.state === 'ok' ? '上游没有返回余额条目。' : '余额未知。'}</p>
                  )}
                  {monitor.planPrice ? (
                    <p className="small muted plan-price">
                      套餐标价：{formatAmount(monitor.planPrice.amount, monitor.planPrice.currency)}
                      <span> · {monitor.planPrice.source}</span>
                    </p>
                  ) : null}
                </section>

                <section className="quota-section" aria-label={`${item.name} 用量窗口`}>
                  <h3>上游用量窗口</h3>
                  {monitor.windows.length > 0 ? (
                    <ul className="window-list">
                      {monitor.windows.map((window) => (
                        <li key={window.id}>
                          <div className="window-list__head">
                            <div>
                              <strong>{window.name}</strong>
                              <span className="small muted">
                                {window.pool} · {formatDateTime(window.startsAt)} → {formatDateTime(window.resetsAt)}
                              </span>
                            </div>
                            <strong className="window-list__ratio">{formatPercent(window.usedRatio)}</strong>
                          </div>
                          <ProgressBar ratio={window.usedRatio} label={`${window.name} 已用比例`} />
                          <p className="small muted">窗口采样 {formatDateTime(window.sampledAt)}</p>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">上游没有返回可用的用量窗口。</p>
                  )}
                </section>
              </div>

              <section className="quota-estimate" aria-label={`${item.name} 额度估算`}>
                <div className="quota-estimate__head">
                  <h3>美元额度估算</h3>
                  <Badge tone="warn">估算，不是官方额度</Badge>
                </div>
                {item.estimates.length > 0 ? (
                  <div className="estimate-grid">
                    {item.estimates.map((estimate) => (
                      <div className={`estimate-card${estimate.state === 'unavailable' ? ' is-unavailable' : ''}`} key={estimate.windowId}>
                        <div className="estimate-card__head">
                          <strong>{estimate.label || estimate.windowId}</strong>
                          <Badge tone={estimate.state === 'ok' ? 'info' : 'neutral'}>{estimate.state === 'ok' ? '可估算' : '不可估算'}</Badge>
                        </div>
                        {estimate.state === 'ok' ? (
                          <>
                            <dl className="estimate-values">
                              <div>
                                <dt>估计总额</dt>
                                <dd>{formatUsd(estimate.totalUsd)}</dd>
                              </div>
                              <div>
                                <dt>估计剩余</dt>
                                <dd>{formatUsd(estimate.remainingUsd)}</dd>
                              </div>
                              <div>
                                <dt>窗口内已用</dt>
                                <dd>{formatUsd(estimate.spentUsd)}</dd>
                              </div>
                            </dl>
                            <p className="small muted">采样 {formatDateTime(estimate.sampledAt)}</p>
                          </>
                        ) : (
                          <p className="small muted">{estimate.reason ?? '不满足估算条件，未给出总额与剩余额度。'}</p>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="muted">没有可用的窗口估算条目。</p>
                )}
                <p className="quiet-note">
                  估算仅使用本网关在同一窗口与同一采样时刻的等价消费；不叠加窗口、不预测整月，也不能排除网关外使用。缺失值显示为「未知」。
                </p>
              </section>
            </article>
          );
        })}
      </div>
    </div>
  );
}
