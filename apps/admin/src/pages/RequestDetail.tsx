import { useApi } from '../auth';
import type { Attempt, RequestDetailResponse } from '../types';
import type { Money } from '../lib/contracts';
import { formatDateTime, formatDuration, formatMoney, formatUsd, prettyJson } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Link } from '../router';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Icon,
  InlineNote,
  PageHeader,
  RequestStatusBadge,
  SkeletonRows,
} from '../ui';

function CostCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="cost-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}

function aggregateMoney(attempts: Attempt[], kind: 'estimatedCost' | 'settledCost'): Money[] {
  const sums = new Map<Money['currency'], number>();
  for (const attempt of attempts) {
    const money = kind === 'estimatedCost' && attempt.settledCost ? null : attempt[kind];
    if (money) sums.set(money.currency, (sums.get(money.currency) ?? 0) + money.amount);
  }
  return [...sums].map(([currency, amount]) => ({ currency, amount }));
}

function aggregateEquivalent(attempts: Attempt[]): number | null {
  if (attempts.length === 0) return null;
  if (attempts.some((attempt) => typeof attempt.equivalentUsd !== 'number')) return null;
  return attempts.reduce((sum, attempt) => sum + (attempt.equivalentUsd ?? 0), 0);
}

function moneyListText(list: Money[]): string {
  if (list.length === 0) return '无费用记录';
  return list.map((money) => formatMoney(money)).join(' + ');
}

function PriceBasis({ attempt }: { attempt: Attempt }) {
  const price = attempt.price;
  if (!price) return <p className="muted">未返回价格依据。</p>;
  const rows: Array<[string, string]> = [
    ['计价类型', price.kind],
    ['币种', price.currency],
  ];
  if (price.expression) rows.push(['表达式', price.expression]);
  if (price.source) rows.push(['来源', price.source]);
  if (price.version) rows.push(['版本', price.version]);
  return (
    <dl className="meta-list">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd className={label === '表达式' ? 'mono break' : undefined}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function AttemptCard({ attempt, index }: { attempt: Attempt; index: number }) {
  const usage = attempt.usage;
  const attemptNumber = attempt.number ?? index + 1;
  return (
    <article className="attempt-card">
      <header className="attempt-card__head">
        <div>
          <p className="eyebrow">Attempt {attemptNumber}</p>
          <h3>{attempt.modelId ?? '未命名尝试'}</h3>
          <p className="small muted">
            {attempt.accountId ?? '账户未提供'}
            {attempt.pool ? ` · ${attempt.pool}` : ''}
            {attempt.billingType ? ` · ${attempt.billingType === 'subscription' ? '订阅' : '按量'}` : ''}
          </p>
        </div>
        <div className="attempt-card__status">
          <RequestStatusBadge status={attempt.status} />
          {attempt.httpStatus !== undefined ? <Badge tone={attempt.httpStatus >= 400 ? 'bad' : 'neutral'}>HTTP {attempt.httpStatus}</Badge> : null}
        </div>
      </header>

      <dl className="meta-list meta-list--cols">
        <div>
          <dt>开始</dt>
          <dd>{formatDateTime(attempt.startedAt)}</dd>
        </div>
        <div>
          <dt>结束</dt>
          <dd>{formatDateTime(attempt.finishedAt)}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{formatDuration(attempt.startedAt, attempt.finishedAt)}</dd>
        </div>
        <div>
          <dt>结算来源</dt>
          <dd>{attempt.settlementSource ?? '—'}</dd>
        </div>
        <div>
          <dt>上游请求 ID</dt>
          <dd className="mono break">{attempt.upstreamRequestId ?? '—'}</dd>
        </div>
        <div>
          <dt>汇率快照</dt>
          <dd>{attempt.usdCny === null || attempt.usdCny === undefined ? '未配置' : `1 USD = ${attempt.usdCny} CNY`}</dd>
        </div>
      </dl>

      <div className="attempt-card__body">
        <section>
          <h4>用量</h4>
          {usage ? (
            <dl className="meta-list">
              <div>
                <dt>输入</dt>
                <dd className="num">{usage.input}</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd className="num">{usage.output}</dd>
              </div>
              <div>
                <dt>缓存读取</dt>
                <dd className="num">{usage.cacheRead}</dd>
              </div>
              <div>
                <dt>缓存写入</dt>
                <dd className="num">{usage.cacheWrite}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">未返回用量；不要按 0 tokens 理解。</p>
          )}
        </section>
        <section>
          <h4>费用</h4>
          <dl className="meta-list">
            <div>
              <dt>估算</dt>
              <dd>{formatMoney(attempt.estimatedCost)}</dd>
            </div>
            <div>
              <dt>估算（CNY）</dt>
              <dd>{attempt.estimatedCny === null || attempt.estimatedCny === undefined ? '未知' : formatMoney({ amount: attempt.estimatedCny, currency: 'CNY' })}</dd>
            </div>
            <div>
              <dt>已结算</dt>
              <dd>{formatMoney(attempt.settledCost)}</dd>
            </div>
            <div>
              <dt>已结算（CNY）</dt>
              <dd>{attempt.settledCny === null || attempt.settledCny === undefined ? '未知' : formatMoney({ amount: attempt.settledCny, currency: 'CNY' })}</dd>
            </div>
            <div>
              <dt>API 等价</dt>
              <dd>{typeof attempt.equivalentUsd === 'number' ? formatUsd(attempt.equivalentUsd) : '未知'}</dd>
            </div>
          </dl>
        </section>
      </div>

      <div className="attempt-card__price">
        <h4>价格依据</h4>
        <PriceBasis attempt={attempt} />
      </div>

      <details className="raw-details">
        <summary>查看 attempt 原始元数据</summary>
        <pre className="code-block">{prettyJson(attempt)}</pre>
      </details>
    </article>
  );
}

export function RequestDetailPage({ id }: { id: string }) {
  const api = useApi();
  const detail = useAsync(
    (signal) => api<RequestDetailResponse>(`/api/admin/requests/${encodeURIComponent(id)}`, { signal }),
    [id],
  );

  const attempts = detail.data?.attempts ?? [];
  const estimated = aggregateMoney(attempts, 'estimatedCost');
  const settled = aggregateMoney(attempts, 'settledCost');
  const equivalent = aggregateEquivalent(attempts);

  return (
    <div className="page">
      <PageHeader
        title="请求详情"
        description={id}
        actions={
          <>
            <Link className="btn btn--secondary btn--md" to={{ name: 'requests' }}>
              <Icon name="arrow-left" size={16} /> 返回请求列表
            </Link>
            <Button icon="refresh" onClick={detail.reload} loading={detail.refreshing}>
              刷新
            </Button>
          </>
        }
      />

      {detail.error ? <ErrorState error={detail.error} onRetry={detail.reload} /> : null}
      {detail.loading && !detail.data ? <SkeletonRows rows={6} /> : null}

      {detail.data ? (
        <>
          <Card>
            <div className="request-head">
              <div>
                <div className="tag-row">
                  <RequestStatusBadge status={detail.data.request.status} />
                  <Badge tone="info">{detail.data.request.modelId}</Badge>
                </div>
                <h2 className="mono request-head__id">{detail.data.request.id}</h2>
              </div>
              <dl className="meta-list meta-list--cols request-head__meta">
                <div>
                  <dt>设备</dt>
                  <dd className="mono">{detail.data.request.deviceId}</dd>
                </div>
                <div>
                  <dt>开始</dt>
                  <dd>{formatDateTime(detail.data.request.startedAt)}</dd>
                </div>
                <div>
                  <dt>结束</dt>
                  <dd>{formatDateTime(detail.data.request.finishedAt)}</dd>
                </div>
                <div>
                  <dt>耗时</dt>
                  <dd>{formatDuration(detail.data.request.startedAt, detail.data.request.finishedAt)}</dd>
                </div>
                <div>
                  <dt>上游尝试</dt>
                  <dd className="num">{attempts.length}</dd>
                </div>
                <div>
                  <dt>请求 ID</dt>
                  <dd className="mono break">{detail.data.request.id}</dd>
                </div>
              </dl>
            </div>
          </Card>

          <section className="cost-grid" aria-label="费用口径">
            <CostCard
              label="估算（由 attempt 汇总）"
              value={moneyListText(estimated)}
              note="只汇总未结算尝试；已结算尝试不重复估算"
            />
            <CostCard
              label="上游已结算"
              value={moneyListText(settled)}
              note="真实扣费替换估算，两种口径不相加"
            />
            <CostCard
              label="API 等价价值"
              value={equivalent === null ? '未知' : formatUsd(equivalent)}
              note="订阅场景的价值口径，不是现金支出"
            />
          </section>

          <InlineNote>
            失败、取消、中断与超时的 attempt 也可能产生费用。未知金额与未返回用量都保持未知，不记作 0；完整请求元数据不包含正文或秘密。
          </InlineNote>

          <div className="attempt-list">
            {attempts.length > 0 ? (
              attempts.map((attempt, index) => <AttemptCard attempt={attempt} index={index} key={attempt.id ?? index} />)
            ) : (
              <Card>
                <EmptyState title="没有 attempt 记录" description="这条请求在返回前没有留下任何上游尝试元数据。" />
              </Card>
            )}
          </div>

          <Card title="请求原始元数据" flush>
            <details className="raw-details raw-details--plain">
              <summary>展开请求对象的全部字段</summary>
              <pre className="code-block">{prettyJson(detail.data.request)}</pre>
            </details>
          </Card>
        </>
      ) : null}
    </div>
  );
}
