import { useState } from 'react';
import { useApi } from '../auth';
import type { RequestsResponse } from '../types';
import { formatDateTime, formatDuration, formatMoneyList, formatUsd } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Link } from '../router';
import {
  Button,
  EmptyState,
  ErrorState,
  Icon,
  InlineNote,
  PageHeader,
  RequestStatusBadge,
  Select,
  SkeletonRows,
  TableFrame,
} from '../ui';

export function RequestsPage() {
  const api = useApi();
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(50);
  const requests = useAsync(
    (signal) => api<RequestsResponse>(`/api/admin/requests?limit=${limit}&offset=${offset}`, { signal }),
    [offset, limit],
  );

  const total = requests.data?.total ?? 0;
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const items = requests.data?.items ?? [];

  return (
    <div className="page">
      <PageHeader
        title="请求记录"
        description="生成级记录与上游 attempt 分开追溯。费用保留原币，未知金额不显示为 0。"
        actions={
          <Button icon="refresh" onClick={requests.reload} loading={requests.refreshing}>
            刷新
          </Button>
        }
      />

      <InlineNote>
        列表只包含经过本网关的请求。估算、真实结算与 API 等价费用是不同口径，不在这里相加；进入详情查看每次 attempt 的用量与对账状态。
      </InlineNote>

      <section className="card">
        <div className="list-toolbar">
          <p className="small muted">
            {total > 0 ? `显示第 ${from}–${to} 条，共 ${total} 条` : '暂无请求'}
          </p>
          <div className="toolbar-inline">
            <label htmlFor="request-limit" className="small muted">
              每页
            </label>
            <Select
              id="request-limit"
              value={limit}
              onChange={(event) => {
                setLimit(Number(event.target.value));
                setOffset(0);
              }}
              className="select--compact"
            >
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={200}>200</option>
            </Select>
          </div>
        </div>

        <div className="card__body card__body--flush-top">
          {requests.error ? <ErrorState error={requests.error} onRetry={requests.reload} /> : null}
          {requests.loading && !requests.data ? <SkeletonRows rows={8} /> : null}
          {!requests.loading && requests.data && items.length === 0 && !requests.error ? (
            <EmptyState
              title="还没有请求"
              description="设备使用网关密钥调用 /v1 接口后，生成与 attempt 元数据会出现在这里。"
            />
          ) : null}
          {items.length > 0 ? (
            <TableFrame label="请求记录">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">请求</th>
                    <th scope="col">模型</th>
                    <th scope="col">设备</th>
                    <th scope="col">开始</th>
                    <th scope="col">耗时</th>
                    <th scope="col">尝试</th>
                    <th scope="col">状态</th>
                    <th scope="col">估算费用</th>
                    <th scope="col">已结算</th>
                    <th scope="col">API 等价</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>
                        <Link className="mono-link" to={{ name: 'request-detail', id: item.id }}>
                          {item.id}
                        </Link>
                      </td>
                      <td className="mono">{item.modelId}</td>
                      <td className="mono small">{item.deviceId}</td>
                      <td className="nowrap">{formatDateTime(item.startedAt)}</td>
                      <td className="nowrap">{formatDuration(item.startedAt, item.finishedAt)}</td>
                      <td className="num">{item.attempts}</td>
                      <td>
                        <RequestStatusBadge status={item.status} />
                      </td>
                      <td>{formatMoneyList(item.estimatedCost)}</td>
                      <td>{formatMoneyList(item.settledCost)}</td>
                      <td>{item.equivalentUsd === null ? '未知' : formatUsd(item.equivalentUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableFrame>
          ) : null}
        </div>

        <footer className="pagination">
          <span className="small muted">
            第 {page} / {pages} 页
          </span>
          <div className="pagination__actions">
            <Button
              size="sm"
              icon="arrow-left"
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              上一页
            </Button>
            <Button
              size="sm"
              disabled={offset + limit >= total}
              onClick={() => setOffset(offset + limit)}
            >
              下一页 <Icon name="chevron-right" size={14} />
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}
