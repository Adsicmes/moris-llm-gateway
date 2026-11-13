import type { Money } from './contracts';

const SHANGHAI = 'Asia/Shanghai';

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

export function dateInputToIso(value: string): string {
  return new Date(`${value}T00:00:00+08:00`).toISOString();
}

export function formatAmount(amount: number, currency?: string, precise = true): string {
  const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : '';
  const digits = precise
    ? Math.abs(amount) > 0 && Math.abs(amount) < 0.01
      ? 6
      : Math.abs(amount) < 1
        ? 4
        : 2
    : 2;
  const formatted = new Intl.NumberFormat('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
  return `${symbol}${formatted}${currency && !symbol ? ` ${currency}` : ''}`;
}

export function formatMoneyList(list: Money[] | null | undefined): string {
  if (list === null || list === undefined) return '未知';
  if (list.length === 0) return '无费用记录';
  return list.map((money) => formatAmount(money.amount, money.currency)).join(' + ');
}

export function formatMoney(money: Money | null | undefined): string {
  if (money === null || money === undefined) return '未知';
  return formatAmount(money.amount, money.currency);
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未知';
  return formatAmount(value, 'USD');
}

export function formatCny(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未知';
  return formatAmount(value, 'CNY', false);
}

export function formatPercent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatDuration(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return '—';
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '—';
  return formatMs(to - from);
}

export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} 秒`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(ms % 60_000 === 0 ? 0 : 1)} 分钟`;
  return `${(ms / 3_600_000).toFixed(ms % 3_600_000 === 0 ? 0 : 1)} 小时`;
}

export function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

export function textOrDash(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
