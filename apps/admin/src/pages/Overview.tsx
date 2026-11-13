import { useApi } from '../auth';
import type { Overview, ProvidersResponse, QuotaResponse, RequestsResponse } from '../types';
import { formatCny, formatDateTime, formatDuration, formatMoneyList, formatPercent, formatUsd } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Link } from '../router';
import {
  Card,
  DataStateBadge,
  EmptyState,
  ErrorState,
  Icon,
  PageHeader,
  RequestStatusBadge,
  SkeletonRows,
  TableFrame,
  Button,
  Badge,
} from '../ui';

function AmountCard({
  label,
  value,
  unit,
  note,
  accent = false,
  partial = false,
}: {
  label: string;
  value: string;
  unit: string;
  note: string;
  accent?: boolean;
  partial?: boolean;
}) {
  return (
    <article className={`amount-card${accent ? ' amount-card--accent' : ''}`}>
      <div className="amount-card__head">
        <p className="amount-card__label">{label}</p>
        {partial ? <Badge tone="warn">已知部分</Badge> : null}
      </div>
      <p className="amount-card__value">
        <span>{value}</span>
        <small>{unit}</small>
      </p>
      <p className="amount-card__note">{note}</p>
    </article>
  );
}

export function OverviewPage() {
  const api = useApi();
  const overview = useAsync((signal) => api<Overview>('/api/admin/overview', { signal }), []);
  const requests = useAsync((signal) => api<RequestsResponse>('/api/admin/requests?limit=8&offset=0', { signal }), []);
  const providers = useAsync((signal) => api<ProvidersResponse>('/api/admin/providers', { signal }), []);
  const quota = useAsync((signal) => api<QuotaResponse>('/api/admin/quota', { signal }), []);

  const refreshAll = () => {
    overview.reload();
    requests.reload();
    providers.reload();
    quota.reload();
  };

  const data = overview.data;
  const attention = (quota.data?.items ?? []).filter(
    (item) =>
      item.monitor.state !== 'ok' ||
      item.monitor.windows.some((window) => window.usedRatio >= 0.75) ||
      item.estimates.some((estimate) => estimate.state === 'unavailable'),
  );

  return (
    <div className="page">
      <PageHeader
        title="运行概览"
        description="本网关当日请求，以及人民币实付、请求估算、上游已结算与 API 等价四个金额口径。未知金额保留为「未知」，不按 0 处理。"
        actions={
          <Button icon="refresh" onClick={refreshAll} loading={overview.refreshing || requests.refreshing}>
            刷新
          </Button>
        }
      />

      {overview.error ? <ErrorState error={overview.error} onRetry={overview.reload} /> : null}

      {overview.loading && !data ? (
        <SkeletonRows rows={3} />
      ) : data ? (
        <>
          <section className="amount-grid" aria-label="金额口径">
            <AmountCard
              label="人民币实付净额"
              value={formatCny(data.paidCny)}
              unit="CNY"
              note="手动账单全量净额，含负数退款；不与用量费用相加。"
              accent
            />
            <AmountCard
              label="请求估算"
              value={formatUsd(data.estimatedUsd)}
              unit="USD"
              note="USD 口径；其他币种见下方「原币估算与结算」。"
            />
            <AmountCard
              label="上游已结算"
              value={formatUsd(data.settledUsd)}
              unit="USD"
              note="USD 口径；真实扣费不叠加估算，其他币种见下方。"
            />
            <AmountCard
              label="API 等价消费"
              value={formatUsd(data.equivalentUsd)}
              unit="USD"
              partial={data.unknownEquivalentAttempts > 0}
              note={
                data.unknownEquivalentAttempts > 0
                  ? `另有 ${data.unknownEquivalentAttempts} 个尝试的等价金额未知，未计入本数。`
                  : '订阅场景的价值口径，不是新增现金支出。'
              }
            />
          </section>

          <section className="count-strip" aria-label="网关计数">
            <div>
              <span>供应商账户</span>
              <strong>{data.accounts}</strong>
            </div>
            <div>
              <span>目录模型</span>
              <strong>{data.models}</strong>
            </div>
            <div>
              <span>请求</span>
              <strong>{data.requests}</strong>
            </div>
            <div>
              <span>上游尝试</span>
              <strong>{data.attempts}</strong>
            </div>
            <div className={data.unknownAttempts > 0 ? 'is-warn' : ''}>
              <span>估算与结算均未知</span>
              <strong>{data.unknownAttempts}</strong>
            </div>
            <div className={data.unknownEquivalentAttempts > 0 ? 'is-warn' : ''}>
              <span>等价金额未知</span>
              <strong>{data.unknownEquivalentAttempts}</strong>
            </div>
          </section>

          <p className="quiet-note overview-note">
            「估算与结算均未知」只统计两种费用都缺失的尝试；参考价缺失导致 API 等价未知的尝试单独计入「等价金额未知」。订阅模型估算为 0，不代表参考额度已知。
          </p>

          <Card title="原币估算与结算">
            <div className="currency-grid">
              <div className="currency-block">
                <span>请求估算（按币种）</span>
                <strong>{formatMoneyList(data.estimatedCost)}</strong>
                <small>已结算的尝试不再重复计入估算；未知金额不参与汇总。</small>
              </div>
              <div className="currency-block">
                <span>上游已结算（按币种）</span>
                <strong>{formatMoneyList(data.settledCost)}</strong>
                <small>与估算分开保存、分开显示，不相加。</small>
              </div>
            </div>
            <p className="quiet-note currency-note">
              上方两张 USD 卡片只代表 USD 部分；这里保留服务端返回的 USD、CNY 等原币金额。任何未知金额都不会被静默当作 0。
            </p>
          </Card>
        </>
      ) : null}

      <div className="two-col">
        <Card
          title="供应商状态"
          action={
            <Link className="text-link" to={{ name: 'providers' }}>
              管理供应商 <Icon name="chevron-right" size={14} />
            </Link>
          }
          flush
        >
          {providers.error ? (
            <div className="card__pad">
              <ErrorState error={providers.error} onRetry={providers.reload} />
            </div>
          ) : providers.loading && !providers.data ? (
            <div className="card__pad">
              <SkeletonRows rows={3} />
            </div>
          ) : providers.data && providers.data.items.length > 0 ? (
            <ul className="plain-list">
              {providers.data.items.slice(0, 5).map((provider) => (
                <li key={provider.id}>
                  <span className="plain-list__main">
                    <strong>{provider.name}</strong>
                    <small>
                      {provider.namespace} · {provider.plugin}
                    </small>
                  </span>
                  <span className="plain-list__side">
                    {provider.autoCreateTokens ? <Badge tone="accent">自动创建</Badge> : null}
                    <Badge tone={provider.enabled ? 'ok' : 'neutral'}>{provider.enabled ? '已启用' : '已停用'}</Badge>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="card__pad">
              <EmptyState
                title="还没有供应商"
                description="接入第一个供应商后，目录、额度和请求才会出现在这里。"
                action={
                  <Link className="btn btn--primary btn--md" to={{ name: 'provider-new' }}>
                    <Icon name="plus" size={16} /> 新增供应商
                  </Link>
                }
              />
            </div>
          )}
        </Card>

        <Card
          title="需要核对"
          action={
            <Link className="text-link" to={{ name: 'quota' }}>
              余额与额度 <Icon name="chevron-right" size={14} />
            </Link>
          }
          flush
        >
          {quota.error ? (
            <div className="card__pad">
              <ErrorState error={quota.error} onRetry={quota.reload} />
            </div>
          ) : quota.loading && !quota.data ? (
            <div className="card__pad">
              <SkeletonRows rows={3} />
            </div>
          ) : attention.length > 0 ? (
            <ul className="plain-list">
              {attention.slice(0, 5).map((item) => {
                const highest = Math.max(0, ...item.monitor.windows.map((window) => window.usedRatio));
                return (
                  <li key={item.accountId}>
                    <span className="plain-list__main">
                      <strong>{item.name}</strong>
                      <small>{item.namespace}</small>
                    </span>
                    <span className="plain-list__side">
                      <DataStateBadge state={item.monitor.state} />
                      {item.monitor.windows.length > 0 ? <Badge tone={highest >= 0.9 ? 'bad' : 'warn'}>{formatPercent(highest)}</Badge> : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : quota.data ? (
            <div className="card__pad">
              <p className="quiet-note">当前没有超过 75% 的窗口，也没有读不到的余额或估算。</p>
            </div>
          ) : null}
        </Card>
      </div>

      <Card
        title="最近请求"
        action={
          <Link className="text-link" to={{ name: 'requests' }}>
            全部记录 <Icon name="chevron-right" size={14} />
          </Link>
        }
        flush
      >
        {requests.error ? (
          <div className="card__pad">
            <ErrorState error={requests.error} onRetry={requests.reload} />
          </div>
        ) : requests.loading && !requests.data ? (
          <div className="card__pad">
            <SkeletonRows rows={4} />
          </div>
        ) : requests.data && requests.data.items.length > 0 ? (
          <TableFrame label="最近请求">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">请求</th>
                  <th scope="col">模型</th>
                  <th scope="col">开始时间</th>
                  <th scope="col">耗时</th>
                  <th scope="col">尝试</th>
                  <th scope="col">状态</th>
                  <th scope="col">等价费用</th>
                </tr>
              </thead>
              <tbody>
                {requests.data.items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <Link className="mono-link" to={{ name: 'request-detail', id: item.id }}>
                        {item.id}
                      </Link>
                    </td>
                    <td className="mono">{item.modelId}</td>
                    <td className="nowrap">{formatDateTime(item.startedAt)}</td>
                    <td className="nowrap">{formatDuration(item.startedAt, item.finishedAt)}</td>
                    <td className="num">{item.attempts}</td>
                    <td>
                      <RequestStatusBadge status={item.status} />
                    </td>
                    <td className="num">
                      {item.equivalentUsd === null ? '未知' : formatUsd(item.equivalentUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableFrame>
        ) : (
          <div className="card__pad">
            <EmptyState
              title="还没有经过网关的请求"
              description="设备使用网关密钥发起请求后，生成级与 attempt 级记录会出现在这里。"
            />
          </div>
        )}
      </Card>
    </div>
  );
}
