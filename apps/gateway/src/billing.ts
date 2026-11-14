import type { Money, Price, QuotaWindow, Usage, WindowEstimate } from '../../../packages/contracts/src/index.js';
import type { AttemptRecord, Store } from './store.js';

export function estimateCost(price: Price, usage: Usage | null): Money | null {
  if (price.kind === 'request' && valid(price.perRequest)) return { amount: price.perRequest!, currency: price.currency };
  if (price.kind !== 'token' || !usage || !valid(price.input) || !valid(price.output)) return null;
  if (![usage.input, usage.output, usage.cacheRead, usage.cacheWrite].every(x => Number.isFinite(x) && x >= 0)) return null;
  if (usage.cacheRead + usage.cacheWrite > usage.input) return null;
  if ((usage.cacheRead > 0 && !valid(price.cacheRead)) || (usage.cacheWrite > 0 && !valid(price.cacheWrite))) return null;
  const amount = ((usage.input - usage.cacheRead - usage.cacheWrite) * price.input! + usage.output * price.output! + usage.cacheRead * (price.cacheRead ?? 0) + usage.cacheWrite * (price.cacheWrite ?? 0)) / 1_000_000;
  return { amount, currency: price.currency };
}
function valid(value: number | undefined): boolean { return value !== undefined && Number.isFinite(value) && value >= 0; }
export function asCny(money: Money | null, rate: number | null): number | null {
  return !money ? null : money.currency === 'CNY' ? money.amount : rate === null ? null : money.amount * rate;
}
export function asUsd(money: Money | null, rate: number | null): number | null {
  return !money ? null : money.currency === 'USD' ? money.amount : rate === null ? null : money.amount / rate;
}
export function settle(store: Store, accountId: string, upstreamRequestId: string, money: Money, source: string): boolean {
  if (!upstreamRequestId || !Number.isFinite(money.amount) || money.amount < 0) return false;
  const matches = store.attempts().filter(a => a.accountId === accountId && a.upstreamRequestId === upstreamRequestId);
  if (matches.length !== 1) return false;
  const attempt = matches[0]!;
  store.saveAttempt({ ...attempt, settledCost: money, settledCny: asCny(money, attempt.usdCny), settlementSource: source });
  return true;
}
export function estimateWindow(store: Store, accountId: string, window: QuotaWindow, now = new Date()): WindowEstimate {
  const result: WindowEstimate = { windowId: window.id, state: 'unavailable', sampledAt: window.sampledAt, label: '基于本网关记录的估算，可能偏低' };
  const fail = (reason: string): WindowEstimate => ({ ...result, reason });
  const start = Date.parse(window.startsAt); const end = Date.parse(window.resetsAt); const sample = Date.parse(window.sampledAt);
  const coverage = Date.parse(store.getMeta<string>(`recordingSince:${accountId}`) ?? '');
  if (![start, end, sample, coverage].every(Number.isFinite) || sample < start || sample >= end || sample > now.getTime() || end <= now.getTime()) return fail('窗口时间无效或已重置');
  if (now.getTime() - sample > store.settings().balanceStaleMs) return fail('额度样本已过期');
  if (coverage > start) return fail('本网关记录未覆盖窗口起点');
  if (!Number.isFinite(window.usedRatio) || window.usedRatio < store.settings().minEstimateRatio || window.usedRatio > 1) return fail('窗口已用比例不足或无效');
  // 起点之前尚未结束的attempt可能在本窗口计费，不能悄悄漏掉。
  const attempts = store.accountAttempts(accountId, window.startsAt, window.sampledAt);
  const crossing = store.accountAttempts(accountId, '1970-01-01', window.startsAt).filter(a => a.startedAt < window.startsAt && (!a.finishedAt || a.finishedAt > window.startsAt));
  if (crossing.length) return fail('存在跨窗口调用，费用归属无法确认');
  if (window.pool !== 'default' && attempts.some(a => !a.pool || a.pool === 'default')) return fail('调用与该独立额度池的归属尚不明确');
  const relevant = attempts.filter(a => window.pool === 'default' || a.pool === window.pool);
  if (relevant.some(a => !a.usage || a.equivalentUsd === null || !a.finishedAt || a.finishedAt > window.sampledAt)) return fail('窗口存在未定价、未知用量或未完成调用');
  const spentUsd = relevant.reduce((sum, a) => sum + a.equivalentUsd!, 0);
  if (spentUsd <= 0) return fail('窗口尚无可用的API等价消费');
  const totalUsd = spentUsd / window.usedRatio;
  return { ...result, state: 'ok', spentUsd, totalUsd, remainingUsd: Math.max(0, totalUsd - spentUsd) };
}
/**
 * 按币种汇总费用。估算口径下，只要有参与汇总的 attempt 费用未知就返回 null
 * （未知不能变成“无费用记录”）；已结算口径的 null 表示尚未结算，仍返回空数组。
 */
export function sumMoney(attempts: AttemptRecord[], kind: 'estimatedCost' | 'settledCost'): Money[] | null {
  const sums = new Map<Money['currency'], number>();
  let unknown = false;
  for (const attempt of attempts) {
    // 估算只汇总未结算部分，已结算请求不会被再次计入待对账估算。
    if (kind === 'estimatedCost' && attempt.settledCost) continue;
    const money = attempt[kind];
    if (!money) {
      if (kind === 'estimatedCost') unknown = true;
      continue;
    }
    sums.set(money.currency, (sums.get(money.currency) ?? 0) + money.amount);
  }
  return unknown ? null : [...sums].map(([currency, amount]) => ({ currency, amount }));
}
