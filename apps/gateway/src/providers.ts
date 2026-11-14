import type { ProviderPlugin, ProviderContext } from '../../../packages/provider-sdk/src/index.js';
import type { CatalogModel, CatalogResponse, ProviderAccount, ProviderMonitor, QuotaSummary } from '../../../packages/contracts/src/index.js';
import { Store } from './store.js';
import { Transport } from './network.js';
import { estimateWindow, settle } from './billing.js';
import { accountProxy } from './proxy.js';

export class ProviderRegistry {
  private plugins = new Map<string, ProviderPlugin>();
  register(plugin: ProviderPlugin): void {
    if (!plugin.id || typeof plugin.discover !== 'function' || typeof plugin.prepare !== 'function' || this.plugins.has(plugin.id)) throw new Error('供应商插件契约无效或ID重复');
    this.plugins.set(plugin.id, plugin);
  }
  get(id: string): ProviderPlugin {
    const plugin = this.plugins.get(id); if (!plugin) throw new Error(`供应商插件未安装: ${id}`); return plugin;
  }
  list(): Array<{ id: string; name: string; setup?: ProviderPlugin['setup'] }> {
    return [...this.plugins.values()].map(({ id, name, setup }) => ({ id, name, ...(setup ? { setup } : {}) }));
  }
}
export class Providers {
  private activity = new Map<string, number>();
  private idleWaiters = new Map<string, Array<() => void>>();
  private resourceQueue: Promise<void> = Promise.resolve();
  private pending = new Map<string, Promise<{ ok: boolean; state: string; error?: string }>>();
  private schedule = new Map<string, { catalog: number; monitor: number; failures: number }>();
  private manualRefreshAt = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private stop = new AbortController();
  constructor(readonly store: Store, readonly registry: ProviderRegistry, readonly transport: Transport, private fetchOverride?: typeof fetch) {}
  /** 同步入场计数，涵盖还没持久化 attempt 的 prepare 和授权刷新。 */
  acquire(id: string): () => void {
    if (!this.store.account(id) || this.store.deleting(id)) throw new Error('供应商正在删除或已不存在');
    this.activity.set(id, (this.activity.get(id) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return; released = true;
      const remaining = (this.activity.get(id) ?? 1) - 1;
      if (remaining) this.activity.set(id, remaining);
      else { this.activity.delete(id); for (const resolve of this.idleWaiters.get(id) ?? []) resolve(); this.idleWaiters.delete(id); }
    };
  }
  isBusy(id: string): boolean { return (this.activity.get(id) ?? 0) > 0; }
  waitForIdle(id: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!this.isBusy(id)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const remove = () => {
        signal?.removeEventListener('abort', abort);
        const waiters = (this.idleWaiters.get(id) ?? []).filter(item => item !== done);
        if (waiters.length) this.idleWaiters.set(id, waiters); else this.idleWaiters.delete(id);
      };
      const done = () => { remove(); resolve(); };
      const abort = () => { remove(); reject(signal?.reason); };
      this.idleWaiters.set(id, [...(this.idleWaiters.get(id) ?? []), done]);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  /** 资源管理低频路径串行；不包围推理请求，避免阻塞其他账号的流。 */
  async resourceLock<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.resourceQueue;
    let release!: () => void;
    this.resourceQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
  context(account: ProviderAccount, signal: AbortSignal): ProviderContext {
    const secrets = this.store.secrets(account.id);
    const actualProxy = accountProxy(this.store, account);
    const managedResources = this.store.resources().filter(item => item.plugin === account.plugin);
    return {
      account, secrets, signal, now: () => new Date(),
      managedResources,
      recordResource: async input => {
        const saved = this.store.recordResource(account.plugin, account.id, input);
        const index = managedResources.findIndex(item => item.id === saved.id);
        if (index < 0) managedResources.push(saved); else managedResources[index] = saved;
      },
      fetch: (async (input, init) => (this.fetchOverride ?? this.transport.fetch(actualProxy, this.store.settings().connectTimeoutMs))(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal })) as typeof fetch,
      updateSecrets: async patch => { this.store.patchSecrets(account.id, patch); Object.assign(secrets, patch); },
    };
  }
  async sync(id: string, catalog = true): Promise<{ ok: boolean; state: string; error?: string }> {
    if (this.store.deleting(id)) return { ok: false, state: 'disabled', error: '供应商正在删除，不能同步' };
    const ongoing = this.pending.get(id); if (ongoing) return ongoing;
    const release = this.acquire(id);
    const work = this.resourceLock(() => this.performSync(id, catalog)).finally(() => { this.pending.delete(id); release(); });
    this.pending.set(id, work); return work;
  }
  async manualSync(id: string): Promise<{ ok: boolean; state: string; error?: string }> {
    const ongoing = this.pending.get(id); if (ongoing) return ongoing;
    const wait = Math.min(10_000 * 2 ** (this.schedule.get(id)?.failures ?? 0), 120_000);
    if (Date.now() - (this.manualRefreshAt.get(id) ?? 0) < wait) return { ok: false, state: 'rate_limited', error: '刷新过于频繁或上游处于退避期，请稍后重试' };
    this.manualRefreshAt.set(id, Date.now());
    return this.sync(id);
  }
  private async performSync(id: string, catalog: boolean): Promise<{ ok: boolean; state: string; error?: string }> {
    const account = this.store.account(id);
    if (!account || !account.enabled || account.deletionTaskId) return { ok: false, state: 'disabled', error: '供应商已停用或正在删除' };
    const at = new Date().toISOString();
    const context = this.context(account, AbortSignal.any([this.stop.signal, AbortSignal.timeout(120_000)]));
    const plugin = this.registry.get(account.plugin);
    let failed = false;
    let message: string | undefined;
    if (catalog) {
      try {
        const discovery = await plugin.discover(context);
        if (!discovery.complete) throw new Error('目录不完整');
        // 校验所有条目后原子替换；账号配置中途停用不清除历史。
        for (const model of discovery.models) {
          if (!['chat-completions', 'responses', 'messages'].includes(model.protocol) || !model.capabilities || !model.limit || !model.price) throw new Error('模型目录结构无效');
        }
        this.store.replaceCatalog(account, discovery.models, new Date().toISOString());
      } catch {
        failed = true; message = '模型目录同步失败，请检查凭据、权限及插件配置；保留最后成功目录';
        this.store.syncError(id, message, at);
      }
    }
    try {
      const monitor: ProviderMonitor = plugin.monitor ? await plugin.monitor(context) : { state: 'unsupported', balances: [], windows: [], sampledAt: at, message: '该插件尚无余额或窗口查询接口' };
      if (monitor.state === 'error') throw new Error('供应商监控失败');
      if (monitor.balances.some(b => !Number.isFinite(b.amount)) || monitor.windows.some(w => !Number.isFinite(w.usedRatio) || w.usedRatio < 0 || w.usedRatio > 1)) throw new Error('额度数据无效');
      this.store.saveMonitor(id, monitor);
    } catch {
      const old = this.store.monitor(id);
      this.store.saveMonitor(id, { state: 'error', balances: old?.balances ?? [], windows: old?.windows ?? [], sampledAt: old?.sampledAt ?? at, message: '余额或额度获取失败，保留数据及其原始采样时间' });
      failed = true; message ??= '余额或额度获取失败';
    }
    if (plugin.reconcile) {
      try {
        const pending = this.store.attempts().filter(a => a.accountId === id && !a.settledCost);
        if (pending.length) for (const record of await plugin.reconcile(context, pending[0]!.startedAt)) settle(this.store, id, record.upstreamRequestId, record.money, record.source);
      } catch { /* 对账失败保持未对账，不用余额差额补账。 */ }
    }
    const previous = this.schedule.get(id);
    const failures = failed ? Math.min((previous?.failures ?? 0) + 1, 5) : 0;
    const settings = this.store.settings(); const factor = Math.pow(2, failures);
    this.schedule.set(id, { failures, catalog: catalog ? Date.now() + Math.min(settings.catalogRefreshMs * factor, 3_600_000) : previous?.catalog ?? 0, monitor: Date.now() + Math.min(settings.monitorRefreshMs * factor, 3_600_000) });
    return { ok: !failed, state: failed ? 'error' : 'ok', error: message };
  }
  callable(model: CatalogModel, now = Date.now()): boolean {
    const account = this.store.account(model.accountId); const synced = Date.parse(model.syncedAt);
    return !!account?.enabled && !account.deletionTaskId && model.enabled && Number.isFinite(synced) && synced <= now && now - synced < this.store.settings().catalogTtlMs;
  }
  catalog(): CatalogResponse {
    return {
      providerID: 'moris', fetchedAt: new Date().toISOString(), models: this.store.models().filter(model => this.callable(model)).map(model => ({ ...model, billingType: this.store.account(model.accountId)!.billingType })),
      accounts: this.store.accounts().filter(a => a.enabled).map(account => {
        const state = this.store.syncState(account.id);
        return { id: account.id, lastSyncedAt: state.lastSyncedAt, state: !state.lastSyncedAt ? 'unknown' : Date.now() - Date.parse(state.lastSyncedAt) >= this.store.settings().catalogTtlMs ? 'stale' : state.error ? 'error' : 'ok', error: state.error ?? undefined };
      }),
    };
  }
  quotas(): QuotaSummary[] {
    return this.store.accounts().filter(a => a.enabled).map(account => {
      const monitor = this.store.monitor(account.id) ?? { state: 'unknown' as const, balances: [], windows: [], sampledAt: '', message: '尚未取得供应商数据' };
      const stale = !Number.isFinite(Date.parse(monitor.sampledAt)) || Date.now() - Date.parse(monitor.sampledAt) > this.store.settings().balanceStaleMs;
      return { accountId: account.id, name: account.name, namespace: account.namespace, monitor: { ...monitor, state: stale && monitor.state === 'ok' ? 'stale' : monitor.state },
        estimates: monitor.windows.map(window => monitor.state === 'ok' && !stale ? estimateWindow(this.store, account.id, window) : { windowId: window.id, state: 'unavailable', reason: '当前额度状态不可用于估算', sampledAt: window.sampledAt, label: '基于本网关记录的估算，可能偏低' }),
      };
    });
  }
  start(): void {
    const tick = () => {
      for (const account of this.store.accounts().filter(a => a.enabled)) {
        if (this.pending.has(account.id)) continue;
        const schedule = this.schedule.get(account.id);
        if (!schedule || Date.now() >= schedule.catalog) void this.sync(account.id).catch(() => undefined);
        else if (Date.now() >= schedule.monitor) void this.sync(account.id, false).catch(() => undefined);
      }
    };
    tick(); this.timer = setInterval(tick, 5_000); this.timer.unref();
  }
  async close(): Promise<void> { if (this.timer) clearInterval(this.timer); this.stop.abort(); await Promise.allSettled([...this.pending.values()]); }
}
