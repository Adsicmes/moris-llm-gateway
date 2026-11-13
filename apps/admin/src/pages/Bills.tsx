import { useMemo, useState, type FormEvent } from 'react';
import { useApi } from '../auth';
import type { Bill, BillInput, BillsResponse, ProvidersResponse } from '../types';
import { describeError } from '../lib/api';
import { dateInputToIso, formatCny, formatDate, formatDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import {
  Badge,
  Button,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Field,
  focusFirstInvalid,
  InlineNote,
  Input,
  Modal,
  PageHeader,
  Select,
  SkeletonRows,
  TableFrame,
  Textarea,
  useToast,
} from '../ui';

function BillForm({
  bill,
  accounts,
  onSave,
  onClose,
}: {
  bill: Bill | null;
  accounts: Array<{ id: string; name: string }>;
  onSave: (input: BillInput, id?: string) => Promise<void>;
  onClose: () => void;
}) {
  const [accountId, setAccountId] = useState(bill?.accountId ?? '');
  const [paidAt, setPaidAt] = useState(bill ? formatDate(bill.paidAt) : '');
  const [amount, setAmount] = useState(bill ? String(bill.amountCny) : '');
  const [period, setPeriod] = useState(bill?.period ?? '');
  const [method, setMethod] = useState(bill?.method ?? '');
  const [note, setNote] = useState(bill?.note ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!accountId) next.accountId = '选择这次付款对应的供应商。';
    if (!paidAt) next.paidAt = '选择付款日期。';
    const amountNumber = Number(amount);
    if (!amount.trim() || !Number.isFinite(amountNumber)) {
      next.amount = '填写金额；退款请使用负数。';
    } else if (Math.abs(amountNumber) > 1e10) {
      next.amount = '金额绝对值不能超过 100 亿。';
    } else if (Math.abs(amountNumber * 100 - Math.round(amountNumber * 100)) > 0.00001) {
      next.amount = '人民币金额最多保留两位小数。';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      focusFirstInvalid();
      return;
    }

    const paidAtIso =
      bill && formatDate(bill.paidAt) === paidAt ? bill.paidAt : dateInputToIso(paidAt);

    const input: BillInput = {
      accountId,
      paidAt: paidAtIso,
      amountCny: amountNumber,
    };
    if (period.trim()) input.period = period.trim();
    if (method.trim()) input.method = method.trim();
    if (note.trim()) input.note = note.trim();

    setBusy(true);
    setFormError(null);
    try {
      await onSave(input, bill?.id);
      onClose();
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={bill ? '编辑人民币账单' : '记录一笔人民币付款'}
      description="实付统一以 CNY 记录。退款用负数金额，并在备注中说明。"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" type="submit" form="bill-form" loading={busy}>
            {bill ? '保存修改' : '保存账单'}
          </Button>
        </>
      }
    >
      <form id="bill-form" className="moris-modal-form" onSubmit={submit} noValidate>
        {accounts.length === 0 ? (
          <InlineNote tone="warn">
            还没有供应商账户。账单需要关联供应商；请先在供应商页接入账号。
          </InlineNote>
        ) : null}
        <Field label="供应商" id="bill-account" error={errors.accountId}>
          <Select
            id="bill-account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            data-autofocus
            aria-invalid={Boolean(errors.accountId)}
          >
            <option value="">选择供应商</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name} · {account.id}
              </option>
            ))}
            {accountId && !accounts.some((account) => account.id === accountId) ? (
              <option value={accountId}>{accountId}（当前账户不在列表）</option>
            ) : null}
          </Select>
        </Field>

        <div className="form-grid form-grid--two">
          <Field label="付款日期" id="bill-date" error={errors.paidAt} hint="按北京时间日期保存。">
            <Input
              id="bill-date"
              type="date"
              value={paidAt}
              onChange={(event) => setPaidAt(event.target.value)}
              aria-invalid={Boolean(errors.paidAt)}
            />
          </Field>
          <Field label="金额（CNY）" id="bill-amount" error={errors.amount} hint="可填负数；负数计入净实付，作为退款。">
            <Input
              id="bill-amount"
              type="number"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="-12.34"
              className="mono"
              aria-invalid={Boolean(errors.amount)}
            />
          </Field>
        </div>

        <div className="form-grid form-grid--two">
          <Field label="账期" id="bill-period" hint="可选。例如 2026-11 或 2026-11-01～2026-11-30。">
            <Input
              id="bill-period"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
              placeholder="2026-11"
              maxLength={100}
            />
          </Field>
          <Field label="付款方式" id="bill-method" hint="可选。例如 支付宝、微信、银行转账。">
            <Input
              id="bill-method"
              value={method}
              onChange={(event) => setMethod(event.target.value)}
              placeholder="支付宝"
              maxLength={100}
            />
          </Field>
        </div>

        <Field label="备注" id="bill-note" hint="退款、优惠或充值说明写在这里，计入净实付时仍以金额符号为准。">
          <Textarea
            id="bill-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="例如 11 月充值；退款 20 元。"
          />
        </Field>

        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}
      </form>
    </Modal>
  );
}

export function BillsPage() {
  const api = useApi();
  const toast = useToast();
  const bills = useAsync((signal) => api<BillsResponse>('/api/admin/bills', { signal }), []);
  const providers = useAsync((signal) => api<ProvidersResponse>('/api/admin/providers', { signal }), []);
  const [editing, setEditing] = useState<Bill | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Bill | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [periodFilter, setPeriodFilter] = useState('all');

  const accounts = providers.data?.items ?? [];
  const accountName = (id: string) => accounts.find((account) => account.id === id)?.name ?? id;

  const periods = useMemo(
    () => Array.from(new Set((bills.data?.items ?? []).map((bill) => bill.period).filter((value): value is string => Boolean(value)))).sort(),
    [bills.data],
  );

  const sorted = useMemo(() => {
    const items = [...(bills.data?.items ?? [])];
    items.sort((a, b) => new Date(b.paidAt).getTime() - new Date(a.paidAt).getTime());
    return items;
  }, [bills.data]);

  const filtered = useMemo(
    () => (periodFilter === 'all' ? sorted : sorted.filter((bill) => bill.period === periodFilter)),
    [sorted, periodFilter],
  );

  const filteredTotal = useMemo(() => filtered.reduce((sum, bill) => sum + bill.amountCny, 0), [filtered]);

  const save = async (input: BillInput, id?: string) => {
    if (id) {
      await api<{ item: Bill }>(`/api/admin/bills/${encodeURIComponent(id)}`, { method: 'PATCH', body: input });
      toast.push('账单已更新。');
    } else {
      await api<{ item: Bill }>('/api/admin/bills', { method: 'POST', body: input });
      toast.push('账单已记录。');
    }
    bills.reload();
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api(`/api/admin/bills/${encodeURIComponent(deleteTarget.id)}`, { method: 'DELETE' });
      toast.push('账单已删除。');
      setDeleteTarget(null);
      bills.reload();
    } catch (error) {
      toast.push(`删除失败：${describeError(error)}`, 'bad');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="人民币账单"
        description="手动记录充值、续费与退款。实付与请求费用、API 等价消费分开统计，不做成本分摊。"
        actions={
          <>
            <Button icon="refresh" onClick={bills.reload} loading={bills.refreshing}>
              刷新
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
              记录付款
            </Button>
          </>
        }
      />

      <section className="bill-summary">
        <div className="bill-summary__main">
          <p>全量净实付</p>
          <strong>{bills.data ? formatCny(bills.data.totalCny) : '读取中'}</strong>
          <small>CNY · 由服务端汇总，包含所有负数退款</small>
        </div>
        <div className="bill-summary__side">
          {periodFilter !== 'all' ? (
            <>
              <p>所选账期净额</p>
              <strong>{formatCny(filteredTotal)}</strong>
              <small>仅按当前返回的 {filtered.length} 条记录计算，仅供参考</small>
            </>
          ) : (
            <>
              <p>账单条数</p>
              <strong>{bills.data?.items.length ?? '—'}</strong>
              <small>不自动清理，保留创建与修改时间</small>
            </>
          )}
        </div>
      </section>

      <div className="card">
        <div className="list-toolbar">
          <div className="toolbar-inline">
            <label htmlFor="bill-period-filter" className="small muted">
              筛选账期
            </label>
            <Select
              id="bill-period-filter"
              value={periodFilter}
              onChange={(event) => setPeriodFilter(event.target.value)}
              className="select--compact"
            >
              <option value="all">全部账期</option>
              {periods.map((period) => (
                <option key={period} value={period}>
                  {period}
                </option>
              ))}
            </Select>
          </div>
          <p className="small muted">负数金额标记为退款；新增与修改都会由服务端记录时间。</p>
        </div>
        <div className="card__body card__body--flush-top">
          {bills.error ? <ErrorState error={bills.error} onRetry={bills.reload} /> : null}
          {bills.loading && !bills.data ? <SkeletonRows rows={6} /> : null}
          {bills.data && bills.data.items.length === 0 && !bills.error ? (
            <EmptyState
              title="还没有人民币账单"
              description="记录第一笔充值或续费后，这里会显示净实付。退款用负数金额记录。"
              action={
                <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                  记录第一笔付款
                </Button>
              }
            />
          ) : null}
          {filtered.length > 0 ? (
            <TableFrame label="人民币账单">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">付款日期</th>
                    <th scope="col">供应商</th>
                    <th scope="col">金额</th>
                    <th scope="col">账期</th>
                    <th scope="col">方式</th>
                    <th scope="col">备注</th>
                    <th scope="col">更新时间</th>
                    <th scope="col" className="col-actions">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((bill) => {
                    const refund = bill.amountCny < 0;
                    return (
                      <tr key={bill.id}>
                        <td className="nowrap">{formatDate(bill.paidAt)}</td>
                        <td>
                          <div className="cell-stack">
                            <span>{accountName(bill.accountId)}</span>
                            <span className="mono small muted">{bill.accountId}</span>
                          </div>
                        </td>
                        <td className={refund ? 'num amount-negative' : 'num'}>
                          <span>{formatCny(bill.amountCny)}</span>
                          {refund ? <Badge tone="warn">退款</Badge> : null}
                        </td>
                        <td>{bill.period ?? '—'}</td>
                        <td>{bill.method ?? '—'}</td>
                        <td className="cell-note" title={bill.note ?? ''}>
                          {bill.note ? bill.note : '—'}
                        </td>
                        <td className="nowrap small">
                          <span title={`创建 ${formatDateTime(bill.createdAt)}`}>{formatDateTime(bill.updatedAt)}</span>
                        </td>
                        <td>
                          <div className="row-actions">
                            <Button size="sm" icon="edit" onClick={() => setEditing(bill)}>
                              编辑
                            </Button>
                            <Button size="sm" variant="danger" icon="trash" onClick={() => setDeleteTarget(bill)}>
                              删除
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableFrame>
          ) : null}
          {bills.data && bills.data.items.length > 0 && filtered.length === 0 && !bills.error ? (
            <EmptyState title="这个账期没有账单" description="切换账期或新增一笔付款。" />
          ) : null}
          {periodFilter !== 'all' && filtered.length > 0 ? (
            <p className="small muted card-note">账期筛选只影响当前表格；上方「全量净实付」始终是服务端返回的全部账单净额。</p>
          ) : null}
        </div>
      </div>

      {creating ? (
        <BillForm
          key="new"
          bill={null}
          accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
          onSave={save}
          onClose={() => setCreating(false)}
        />
      ) : null}

      {editing ? (
        <BillForm
          key={editing.id}
          bill={editing}
          accounts={accounts.map((account) => ({ id: account.id, name: account.name }))}
          onSave={save}
          onClose={() => setEditing(null)}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除这笔账单？"
        description={
          deleteTarget ? (
            <>
              <p>
                将删除 <strong>{accountName(deleteTarget.accountId)}</strong> 在{' '}
                <strong>{formatDate(deleteTarget.paidAt)}</strong> 的{' '}
                <strong>{formatCny(deleteTarget.amountCny)}</strong> 记录。
              </p>
              <p className="muted">删除前请确认它不影响当前账期的净实付核对。</p>
            </>
          ) : null
        }
        confirmLabel="删除账单"
        busy={deleting}
        onConfirm={() => void remove()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}
