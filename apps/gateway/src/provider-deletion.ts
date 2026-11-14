import { createHash, randomUUID } from 'node:crypto';
import type { DeletionAction, DeletionPreview, ManagedResourceInput, ProviderAccount, ProviderDeletion } from '../../../packages/contracts/src/index.js';
import { credentialFingerprint, type ProviderContext } from '../../../packages/provider-sdk/src/index.js';
import { Store, type StoredDeletion } from './store.js';
import { Providers } from './providers.js';
import { GatewayError } from './routing.js';
import { accountProxy } from './proxy.js';

export interface DeletionSelection {
  revision: string; selectedActionIds: string[]; adoptActionIds: string[]; confirmNamespace: string;
  acknowledgeUnsettled: boolean; acknowledgeUncleaned: boolean;
}
interface CachedPreview { view: DeletionPreview; resources: Record<string, ManagedResourceInput>; snapshot: string }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminal = (task: StoredDeletion) => ['completed', 'cancelled'].includes(task.status);
const actionDone = (action: DeletionAction) => ['deleted', 'absent', 'skipped'].includes(action.state);

/** 仅协调已安装的可信插件，不接受客户端传来的 URL、资源对象或可执行代码。 */
export class ProviderDeletions {
  private previews = new Map<string, CachedPreview>();
  private running = new Map<string, Promise<void>>();
  private shutdown = new AbortController();
  constructor(readonly store: Store, readonly providers: Providers, private invalidateAuthorization: (id: string) => void) {}
  view(task: StoredDeletion): ProviderDeletion {
    const { resources: _resources, ...view } = task;
    return view;
  }
  busy(accountId: string): boolean { return [...this.running.keys()].some(id => this.store.deletion(id)?.accountId === accountId); }
  private snapshot(): string {
    // 密文只参与摘要，绝不进入浏览器或任务结果。引用变化也使预览失效。
    return digest([this.store.db.prepare('SELECT id,value,secrets FROM accounts ORDER BY id').all(), this.store.resources(),
      this.store.db.prepare('SELECT id,value,secrets FROM proxies ORDER BY id').all()]);
  }
  private context(account: ProviderAccount): ProviderContext {
    const base = this.providers.context(account, AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(30_000)]));
    return { ...base, recordResource: undefined, updateSecrets: async () => { throw new Error('清理接口不能更改账号凭据'); } };
  }
  private references(accountId: string, resource: ManagedResourceInput): Array<{ id: string; name: string }> {
    const recorded = this.store.resources().find(item => item.scope === resource.scope && item.externalId === resource.externalId);
    return this.store.accounts().filter(account => account.id !== accountId && (
      recorded?.accountIds.includes(account.id) || (resource.fingerprint && Object.values(this.store.secrets(account.id))
        .some(value => value && credentialFingerprint(value) === resource.fingerprint))
    )).map(({ id, name }) => ({ id, name }));
  }
  async preview(accountId: string): Promise<DeletionPreview> {
    const hadActivity = this.providers.isBusy(accountId);
    const release = this.providers.acquire(accountId);
    try { return await this.providers.resourceLock(async () => {
      const account = this.store.account(accountId)!;
      const before = this.snapshot();
      const plugin = this.providers.registry.get(account.plugin);
      const resources: Record<string, ManagedResourceInput> = {};
      const actions: DeletionAction[] = [];
      const warnings = ['删除本地配置与凭据，不删除历史账本；备份仍可能保留历史加密凭据。',
        '上游令牌撤销不可由恢复数据库撤销；无法自动检测外部客户端是否共用。'];
      if (plugin.cleanup) {
        try {
          const candidates = await plugin.cleanup.preview(this.context(account));
          for (const candidate of candidates) {
            const resource = candidate.resource;
            const id = digest([resource.kind, resource.scope, resource.externalId]);
            if (resources[id]) throw new Error('清理候选重复');
            resources[id] = resource;
            const trusted = this.store.resources().find(item => item.plugin === account.plugin && item.scope === resource.scope && item.externalId === resource.externalId &&
              ['created', 'adopted'].includes(item.provenance) && item.fingerprint === resource.fingerprint && Boolean(item.fingerprint));
            const references = this.references(accountId, resource);
            const verified = candidate.verified || (candidate.absent === true && Boolean(trusted));
            const disposition = references.length ? 'shared' : !verified ? 'blocked' : trusted ? 'ready' : 'adopt';
            actions.push({ id, name: resource.name, externalId: resource.externalId, group: resource.group, disposition,
              reason: references.length ? '其他本地供应商仍引用，保留共享令牌。' : candidate.reason,
              defaultSelected: disposition === 'ready', references, state: 'pending' });
          }
        } catch {
          // 本地删除仍可由管理员明确选择，但不能伪称上游资源已清理。
          warnings.push('无法核验上游清理能力或完整资源清单；继续仅删除本地时，需到上游人工处理。');
          actions.length = 0; for (const key of Object.keys(resources)) delete resources[key];
        }
      } else warnings.push('此插件尚不支持可验证的上游清理；只会删除本地配置，不会注销账号或取消订阅。');
      if (before !== this.snapshot() || this.store.deleting(accountId)) throw new GatewayError('deletion_conflict', '配置或引用已经变化，请重新预览', 409);
      const now = Date.now();
      for (const [key, value] of this.previews) if (Date.parse(value.view.expiresAt) <= now) this.previews.delete(key);
      const view: DeletionPreview = { revision: randomUUID(), expiresAt: new Date(now + 5 * 60_000).toISOString(),
        account: { id: account.id, name: account.name, namespace: account.namespace }, cleanupSupported: Boolean(plugin.cleanup), actions,
        unsettledAttempts: Math.max(hadActivity ? 1 : 0, this.store.attempts().filter(item => item.accountId === accountId && item.settledCost === null).length), warnings };
      this.previews.set(view.revision, { view, resources, snapshot: before });
      return view;
    }); } finally { release(); }
  }
  async start(accountId: string, selection: DeletionSelection): Promise<ProviderDeletion> {
    return this.providers.resourceLock(async () => {
      const cached = this.previews.get(selection.revision);
      const account = this.store.account(accountId);
      if (!account) throw new GatewayError('not_found', '供应商不存在', 404);
      if (account.deletionTaskId) throw new GatewayError('deletion_busy', '供应商已有删除任务，请查看进度', 409);
      if (!cached || cached.view.account.id !== accountId || Date.parse(cached.view.expiresAt) <= Date.now() || cached.snapshot !== this.snapshot()) throw new GatewayError('deletion_conflict', '预览已过期或配置、引用已变化，请重新预览', 409);
      if (selection.confirmNamespace !== account.namespace) throw new GatewayError('deletion_confirmation', '请输入供应商命名空间确认删除');
      if ((cached.view.unsettledAttempts || this.providers.isBusy(accountId) || this.store.attempts().some(item => item.accountId === accountId && item.settledCost === null)) && !selection.acknowledgeUnsettled) throw new GatewayError('deletion_confirmation', '请确认删除凭据后无法继续自动对账；如有新请求，请重新预览');
      const selected = new Set(selection.selectedActionIds); const adopted = new Set(selection.adoptActionIds);
      for (const id of [...selected, ...adopted]) {
        const action = cached.view.actions.find(item => item.id === id);
        if (!action || ['blocked', 'shared'].includes(action.disposition) || (adopted.has(id) && (!selected.has(id) || action.disposition !== 'adopt')) ||
          (selected.has(id) && action.disposition === 'adopt' && !adopted.has(id))) throw new GatewayError('deletion_selection', '清理项不可执行或旧令牌尚未明确认领');
      }
      const uncleaned = !cached.view.cleanupSupported || cached.view.actions.some(item => !selected.has(item.id) && item.disposition !== 'shared') || cached.view.warnings.some(item => item.startsWith('无法核验'));
      if (uncleaned && !selection.acknowledgeUncleaned) throw new GatewayError('deletion_confirmation', '请确认未清理的上游资源需要人工处理');
      const now = new Date().toISOString();
      const task: StoredDeletion = { id: randomUUID(), accountId, name: account.name, namespace: account.namespace,
        status: 'draining', resources: cached.resources, createdAt: now, updatedAt: now,
        actions: cached.view.actions.map(action => ({ ...action, state: selected.has(action.id) ? 'pending' : 'skipped',
          reason: !selected.has(action.id) && action.disposition !== 'shared' ? '管理员未选择此项，上游资源未撤销。' : action.reason })) };
      this.store.transaction(() => {
        for (const id of selected) this.store.recordResource(account.plugin, accountId, { ...cached.resources[id]!, provenance: adopted.has(id) ? 'adopted' : 'reused' });
        this.store.saveAccount({ ...account, enabled: false, deletionTaskId: task.id, updatedAt: now });
        this.store.saveDeletion(task);
      });
      this.invalidateAuthorization(accountId);
      this.previews.delete(selection.revision);
      this.launch(task.id);
      return this.view(task);
    });
  }
  async retry(id: string): Promise<ProviderDeletion> {
    const task = this.requireTask(id);
    if (!['failed', 'paused'].includes(task.status) || this.running.has(id)) throw new GatewayError('deletion_busy', '当前状态不能重试，请刷新删除进度', 409);
    const next: StoredDeletion = { ...task, status: 'draining', cancelRequested: false, message: undefined, updatedAt: new Date().toISOString() };
    this.store.saveDeletion(next); this.launch(id); return this.view(next);
  }
  cancel(id: string): ProviderDeletion {
    const task = this.requireTask(id);
    if (terminal(task)) return this.view(task);
    this.store.saveDeletion({ ...task, cancelRequested: true, updatedAt: new Date().toISOString() });
    if (!this.running.has(id)) this.finishCancel(id);
    return this.view(this.requireTask(id));
  }
  requireTask(id: string): StoredDeletion {
    const task = this.store.deletion(id);
    if (!task) throw new GatewayError('not_found', '删除任务不存在', 404);
    return task;
  }
  private update(id: string, patch: Partial<StoredDeletion>): void {
    this.store.saveDeletion({ ...this.requireTask(id), ...patch, updatedAt: new Date().toISOString() });
  }
  private updateAction(id: string, actionId: string, patch: Partial<DeletionAction>): void {
    this.update(id, { actions: this.requireTask(id).actions.map(action => action.id === actionId ? { ...action, ...patch } : action) });
  }
  private finishCancel(id: string): void {
    const task = this.requireTask(id); const account = this.store.account(task.accountId);
    this.store.transaction(() => {
      if (account?.deletionTaskId === task.id) { const { deletionTaskId: _, ...fields } = account; this.store.saveAccount({ ...fields, enabled: false }); }
      this.update(id, { status: 'cancelled', message: '删除流程已取消，供应商仍停用；已撤销的上游令牌不会恢复。' });
    });
  }
  private launch(id: string): void {
    const work = this.run(id).catch(() => {
      if (!terminal(this.requireTask(id))) {
        if (this.requireTask(id).cancelRequested) this.finishCancel(id);
        else this.update(id, { status: this.shutdown.signal.aborted ? 'paused' : 'failed', message: '删除未完成，请检查凭据、代理及资源归属后手动重试；配置仍保留。' });
      }
    }).finally(() => this.running.delete(id));
    this.running.set(id, work);
  }
  private async run(id: string): Promise<void> {
    const first = this.requireTask(id);
    await this.providers.waitForIdle(first.accountId, this.shutdown.signal);
    if (this.shutdown.signal.aborted) { this.update(id, { status: 'paused', message: '服务停止，等待手动继续。' }); return; }
    if (this.requireTask(id).cancelRequested) { this.finishCancel(id); return; }
    this.update(id, { status: 'cleaning' });
    for (const action of this.requireTask(id).actions) {
      if (this.requireTask(id).cancelRequested) { this.finishCancel(id); return; }
      if (actionDone(action)) continue;
      await this.providers.resourceLock(async () => {
        if (this.shutdown.signal.aborted || this.requireTask(id).cancelRequested) return;
        const account = this.store.account(first.accountId);
        if (!account || account.deletionTaskId !== id) throw new Error('删除状态失效');
        const resource = this.requireTask(id).resources[action.id]!;
        const references = this.references(account.id, resource);
        if (references.length) { this.updateAction(id, action.id, { state: 'skipped', disposition: 'shared', references, reason: '其他供应商仍引用，保留共享令牌。' }); return; }
        const trusted = this.store.resources().find(item => item.plugin === account.plugin && item.scope === resource.scope && item.externalId === resource.externalId && item.fingerprint === resource.fingerprint && ['created', 'adopted'].includes(item.provenance));
        if (!trusted || !resource.fingerprint) throw new Error('资源归属不可确认');
        const cleanup = this.providers.registry.get(account.plugin).cleanup;
        if (!cleanup) throw new Error('清理插件不可用');
        const context = this.context(account);
        const candidates = await cleanup.preview(context);
        const candidate = candidates.find(item => digest([item.resource.kind, item.resource.scope, item.resource.externalId]) === action.id &&
          item.resource.fingerprint === resource.fingerprint && item.resource.name === resource.name && item.resource.group === resource.group);
        if (!candidate || (!candidate.verified && !candidate.absent)) {
          this.updateAction(id, action.id, { state: 'failed', reason: '资源身份已变化或无法核验，请检查凭据及归属。' });
          return;
        }
        if (this.shutdown.signal.aborted || this.requireTask(id).cancelRequested) return;
        this.updateAction(id, action.id, { state: 'running', reason: undefined });
        try {
          const result = await cleanup.execute(context, { ...resource, provenance: trusted.provenance });
          this.updateAction(id, action.id, { state: result.state, reason: result.state === 'failed' || result.state === 'unknown' ? '上游清理未确认成功，请检查权限、代理及资源状态后重试。' : undefined });
        } catch { this.updateAction(id, action.id, { state: 'unknown', reason: '上游删除结果未知，重试前将重新核验，不盲目重发。' }); }
      });
      if (this.shutdown.signal.aborted) { this.update(id, { status: 'paused', message: '服务停止，请手动核验并继续。' }); return; }
      if (!actionDone(this.requireTask(id).actions.find(item => item.id === action.id)!)) {
        if (this.requireTask(id).cancelRequested) this.finishCancel(id);
        else this.update(id, { status: 'failed', message: '部分清理未完成，本地配置和必要凭据仍保留。' });
        return;
      }
    }
    if (this.requireTask(id).cancelRequested) { this.finishCancel(id); return; }
    const account = this.store.account(first.accountId)!;
    let oldProxy: string | undefined;
    try { oldProxy = accountProxy(this.store, account); } catch { /* 失效代理不妨碍已经确认的本地删除。 */ }
    this.store.completeDeletion(id);
    if (oldProxy && !this.store.accounts().some(item => { try { return accountProxy(this.store, item) === oldProxy; } catch { return false; } })) await this.providers.transport.retire(oldProxy).catch(() => undefined);
  }
  async close(): Promise<void> { this.shutdown.abort(); await Promise.allSettled([...this.running.values()]); }
}
