import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type CatalogModel, type ModelParameterOverrides, type ModelParameterState, type Money, type Price, type ProviderAccount, type ProviderModel, type ProviderMonitor, type Settings, type Usage } from '../../../packages/contracts/src/index.js';
import { resolveModelParameters } from './model-parameters.js';
import { hashSecret, newSecret, passwordHash, Vault } from './security.js';
import type { ProxyProfile } from '../../../packages/contracts/src/index.js';
import type { ManagedResource, ManagedResourceInput, ProviderDeletion, ProviderHistory } from '../../../packages/contracts/src/index.js';

export interface StoredDeletion extends ProviderDeletion {
  resources: Record<string, ManagedResourceInput>;
}

export interface RequestRecord {
  id: string; modelId: string; deviceId: string; startedAt: string; finishedAt: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
}
export interface AttemptRecord {
  id: string; requestId: string; accountId: string; modelId: string; number: number;
  startedAt: string; finishedAt: string | null; status: string; httpStatus?: number;
  upstreamRequestId?: string; usage: Usage | null; price: Price;
  estimatedCost: Money | null; settledCost: Money | null; equivalentUsd: number | null;
  usdCny: number | null; estimatedCny: number | null; settledCny: number | null;
  billingType: 'subscription' | 'metered'; settlementSource?: string;
  pool?: string;
}
export interface Bill {
  id: string; accountId: string; paidAt: string; amountCny: number;
  period?: string; method?: string; note?: string; createdAt: string; updatedAt: string;
}
export interface Device { id: string; name: string; createdAt: string; revokedAt: string | null; lastUsedAt: string | null }
export interface SyncState { lastSyncedAt: string | null; lastAttemptAt: string | null; error: string | null }
type Row = Record<string, unknown>;
const decode = <T>(row: Row | undefined): T | undefined => row ? JSON.parse(String(row.value)) as T : undefined;

export class Store {
  readonly db: DatabaseSync;
  readonly vault: Vault;
  constructor(path: string, masterKey: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.vault = new Vault(masterKey);
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, namespace TEXT UNIQUE NOT NULL, value TEXT NOT NULL, secrets TEXT NOT NULL, sync TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proxies (id TEXT PRIMARY KEY, value TEXT NOT NULL, secrets TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_history (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_resources (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_deletions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS models_account ON models(account_id);
      CREATE TABLE IF NOT EXISTS monitors (account_id TEXT PRIMARY KEY REFERENCES accounts(id), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS requests_time ON requests(started_at);
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), account_id TEXT NOT NULL, started_at TEXT NOT NULL, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_request ON attempts(request_id);
      CREATE INDEX IF NOT EXISTS attempts_account_time ON attempts(account_id, started_at);
      CREATE TABLE IF NOT EXISTS bills (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, value TEXT NOT NULL);
    `);
    const marker = this.getMeta<string>('vault-check');
    if (marker) this.vault.open(marker);
    else this.setMeta('vault-check', this.vault.seal('moris'));
    if (!this.getMeta('recordingSince')) this.setMeta('recordingSince', new Date().toISOString());
    // 崩溃后不自动重放未知状态的请求，保留费用未知。
    for (const request of this.requests().filter(x => x.status === 'running')) {
      this.saveRequest({ ...request, status: 'interrupted', finishedAt: new Date().toISOString() });
    }
    for (const attempt of this.attempts().filter(x => x.status === 'running')) {
      this.saveAttempt({ ...attempt, status: 'interrupted', finishedAt: new Date().toISOString() });
    }
    for (const task of this.deletions().filter(item => ['draining', 'cleaning'].includes(item.status))) {
      this.saveDeletion({ ...task, status: 'paused', message: '网关已重启，请核验并手动继续；不会自动重发上游删除。',
        actions: task.actions.map(action => action.state === 'running' ? { ...action, state: 'unknown' } : action), updatedAt: new Date().toISOString() });
    }
  }
  getMeta<T>(key: string): T | undefined { return decode<T>(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)); }
  setMeta(key: string, value: unknown): void { this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings(): Settings { return { ...DEFAULT_SETTINGS, ...this.getMeta<Partial<Settings>>('settings') }; }
  saveSettings(settings: Settings): void { this.setMeta('settings', settings); }
  initializeAdmin(username: string, password: string): void {
    if (this.getMeta('admin')) return;
    if (password.length < 12) throw new Error('首次启动MORIS_ADMIN_PASSWORD至少12个字符');
    this.setMeta('admin', { username, passwordHash: passwordHash(password) });
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  accounts(): ProviderAccount[] { return this.db.prepare('SELECT value FROM accounts ORDER BY namespace').all().map(row => decode<ProviderAccount>(row)!); }
  history(): ProviderHistory[] { return this.db.prepare('SELECT value FROM provider_history ORDER BY id').all().map(row => decode<ProviderHistory>(row)!); }
  historicalAccount(id: string): ProviderHistory | undefined { return decode<ProviderHistory>(this.db.prepare('SELECT value FROM provider_history WHERE id=?').get(id)); }
  resources(): ManagedResource[] { return this.db.prepare('SELECT value FROM managed_resources ORDER BY id').all().map(row => decode<ManagedResource>(row)!); }
  recordResource(plugin: string, accountId: string, input: ManagedResourceInput): ManagedResource {
    if (!this.account(accountId)) throw new Error('供应商不存在，不能重新写入资源记录');
    const id = createHash('sha256').update(JSON.stringify([plugin, input.kind, input.scope, input.externalId])).digest('hex');
    const old = decode<ManagedResource>(this.db.prepare('SELECT value FROM managed_resources WHERE id=?').get(id));
    const trusted = old && ['created', 'adopted'].includes(old.provenance);
    if (trusted && input.fingerprint && old.fingerprint && input.fingerprint !== old.fingerprint) throw new Error('资源凭据已变更，需重新核验');
    const now = new Date().toISOString();
    const value: ManagedResource = { ...input, fingerprint: input.fingerprint ?? old?.fingerprint, id, plugin, provenance: trusted ? old.provenance : input.provenance,
      accountIds: [...new Set([...(old?.accountIds ?? []), accountId])], createdAt: old?.createdAt ?? now, updatedAt: now };
    this.db.prepare('INSERT INTO managed_resources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value));
    return value;
  }
  deletions(): StoredDeletion[] { return this.db.prepare('SELECT value FROM provider_deletions ORDER BY id').all().map(row => decode<StoredDeletion>(row)!); }
  deletion(id: string): StoredDeletion | undefined { return decode<StoredDeletion>(this.db.prepare('SELECT value FROM provider_deletions WHERE id=?').get(id)); }
  saveDeletion(task: StoredDeletion): void { this.db.prepare('INSERT INTO provider_deletions VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(task.id, JSON.stringify(task)); }
  deleting(id: string): boolean { return Boolean(this.account(id)?.deletionTaskId); }
  /** 只有协调器排空并完成上游动作后调用；账本及历史金额一字不改。 */
  completeDeletion(taskId: string): void {
    this.transaction(() => {
      const task = this.deletion(taskId);
      if (!task || task.status !== 'cleaning' || task.actions.some(action => !['deleted', 'absent', 'skipped'].includes(action.state))) throw new Error('删除任务尚未完成');
      const account = this.account(task.accountId);
      if (!account || account.deletionTaskId !== task.id) throw new Error('供应商删除状态已改变');
      const modelIds = this.db.prepare('SELECT id FROM models WHERE account_id=?').all(account.id).map(row => String(row.id));
      const history: ProviderHistory = { id: account.id, name: account.name, namespace: account.namespace, plugin: account.plugin,
        billingType: account.billingType, createdAt: account.createdAt, deletedAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO provider_history VALUES (?,?)').run(account.id, JSON.stringify(history));
      for (const id of modelIds) this.db.prepare('DELETE FROM meta WHERE key=?').run(`model-parameters:${id}`);
      const settings = this.settings();
      settings.fallback = Object.fromEntries(Object.entries(settings.fallback).filter(([source]) => !modelIds.includes(source))
        .map(([source, targets]) => [source, targets.filter(id => !modelIds.includes(id))]).filter(([, targets]) => (targets as string[]).length));
      this.saveSettings(settings);
      this.db.prepare('DELETE FROM models WHERE account_id=?').run(account.id);
      this.db.prepare('DELETE FROM monitors WHERE account_id=?').run(account.id);
      this.db.prepare('DELETE FROM meta WHERE key=?').run(`recordingSince:${account.id}`);
      for (const resource of this.resources().filter(item => item.accountIds.includes(account.id))) {
        this.db.prepare('UPDATE managed_resources SET value=? WHERE id=?').run(JSON.stringify({ ...resource, accountIds: resource.accountIds.filter(id => id !== account.id) }), resource.id);
      }
      this.db.prepare('DELETE FROM accounts WHERE id=?').run(account.id);
      this.saveDeletion({ ...task, status: 'completed', updatedAt: new Date().toISOString(), message: '本地配置与凭据已删除；历史账本保留。' });
    });
  }
  proxies(): ProxyProfile[] { return this.db.prepare('SELECT value FROM proxies ORDER BY id').all().map(row => decode<ProxyProfile>(row)!); }
  proxy(id: string): ProxyProfile | undefined { return decode<ProxyProfile>(this.db.prepare('SELECT value FROM proxies WHERE id=?').get(id)); }
  proxyPassword(id: string): string {
    const row = this.db.prepare('SELECT secrets FROM proxies WHERE id=?').get(id);
    if (!row) throw new Error('代理档案不存在');
    return this.vault.open<{ password: string }>(String(row.secrets)).password;
  }
  saveProxy(profile: ProxyProfile, password: string): void {
    this.db.prepare('INSERT INTO proxies VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value, secrets=excluded.secrets')
      .run(profile.id, JSON.stringify(profile), this.vault.seal({ password }));
  }
  proxyReferences(id: string): Array<{ id: string; name: string }> {
    return this.accounts().filter(account => account.proxyId === id).map(({ id, name }) => ({ id, name }));
  }
  deleteProxy(id: string): void {
    if (this.proxyReferences(id).length) throw new Error('代理档案仍被供应商引用');
    this.db.prepare('DELETE FROM proxies WHERE id=?').run(id);
  }
  account(id: string): ProviderAccount | undefined { return decode<ProviderAccount>(this.db.prepare('SELECT value FROM accounts WHERE id=?').get(id)); }
  saveAccount(account: ProviderAccount, secrets?: Record<string, string>): void {
    if (this.historicalAccount(account.id)) throw new Error('已删除的供应商不能重新写入');
    const existing = this.account(account.id);
    if (existing) {
      this.db.prepare('UPDATE accounts SET value=? WHERE id=?').run(JSON.stringify(account), account.id);
      if (secrets) this.patchSecrets(account.id, secrets);
    } else {
      this.db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run(account.id, account.namespace, JSON.stringify(account), this.vault.seal(secrets ?? {}), JSON.stringify({ lastSyncedAt: null, lastAttemptAt: null, error: null }));
      this.setMeta(`recordingSince:${account.id}`, new Date().toISOString());
    }
  }
  secrets(id: string): Record<string, string> {
    const row = this.db.prepare('SELECT secrets FROM accounts WHERE id=?').get(id);
    if (!row) throw new Error('供应商不存在');
    return this.vault.open<Record<string, string>>(String(row.secrets));
  }
  patchSecrets(id: string, patch: Record<string, string>): void {
    const value = { ...this.secrets(id), ...patch };
    for (const [key, v] of Object.entries(value)) if (v === '') delete value[key];
    this.db.prepare('UPDATE accounts SET secrets=? WHERE id=?').run(this.vault.seal(value), id);
  }
  syncState(id: string): SyncState {
    const row = this.db.prepare('SELECT sync FROM accounts WHERE id=?').get(id);
    return row ? JSON.parse(String(row.sync)) as SyncState : { lastSyncedAt: null, lastAttemptAt: null, error: null };
  }
  syncError(id: string, error: string, at: string): void {
    this.db.prepare('UPDATE accounts SET sync=? WHERE id=?').run(JSON.stringify({ ...this.syncState(id), error, lastAttemptAt: at }), id);
  }
  replaceCatalog(account: ProviderAccount, models: ProviderModel[], at: string): void {
    if (!this.account(account.id)) throw new Error('供应商不存在，拒绝迟到的目录写回');
    const paths = new Set<string>();
    for (const model of models) {
      if (!model.path || model.path.startsWith('/') || paths.has(model.path)) throw new Error('模型目录存在空路径或重复路径');
      paths.add(model.path);
    }
    this.transaction(() => {
      for (const old of this.automaticModels().filter(m => m.accountId === account.id)) {
        this.saveModel({ ...old, available: false, enabled: false, disabledReason: '上游完整目录已移除该模型，请重新选择' });
      }
      for (const model of models) {
        this.saveModel({ ...model, id: `${account.namespace}/${model.path}`, accountId: account.id,
          namespace: account.namespace, billingType: account.billingType, enabled: model.enabled !== false, syncedAt: at });
      }
      this.db.prepare('UPDATE accounts SET sync=? WHERE id=?').run(JSON.stringify({ lastSyncedAt: at, lastAttemptAt: at, error: null }), account.id);
    });
  }
  private saveModel(model: CatalogModel): void { this.db.prepare('INSERT INTO models VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(model.id, model.accountId, JSON.stringify(model)); }
  private automaticModels(): CatalogModel[] { return this.db.prepare('SELECT value FROM models ORDER BY id').all().map(row => decode<CatalogModel>(row)!); }
  modelParameters(id: string): ModelParameterState | undefined {
    const automatic = decode<CatalogModel>(this.db.prepare('SELECT value FROM models WHERE id=?').get(id));
    if (!automatic) return undefined;
    const saved = this.getMeta<{ overrides: ModelParameterOverrides; revision: string }>(`model-parameters:${id}`);
    const overrides = saved?.overrides ?? {};
    return { automatic, overrides, revision: saved?.revision ?? null, effective: resolveModelParameters(automatic, overrides) };
  }
  saveModelParameters(id: string, overrides: ModelParameterOverrides): void {
    this.setMeta(`model-parameters:${id}`, { overrides, revision: randomUUID() });
  }
  models(): CatalogModel[] { return this.automaticModels().map(model => resolveModelParameters(model, this.getMeta<{ overrides: ModelParameterOverrides }>(`model-parameters:${model.id}`)?.overrides ?? {})); }
  model(id: string): CatalogModel | undefined { return this.modelParameters(id)?.effective; }
  monitor(id: string): ProviderMonitor | undefined { return decode<ProviderMonitor>(this.db.prepare('SELECT value FROM monitors WHERE account_id=?').get(id)); }
  saveMonitor(id: string, monitor: ProviderMonitor): void { this.db.prepare('INSERT INTO monitors VALUES (?,?) ON CONFLICT(account_id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(monitor)); }
  saveRequest(value: RequestRecord): void { this.db.prepare('INSERT INTO requests VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, value.startedAt, JSON.stringify(value)); }
  requests(since?: string): RequestRecord[] {
    const rows = since ? this.db.prepare('SELECT value FROM requests WHERE started_at>=? ORDER BY started_at DESC').all(since) : this.db.prepare('SELECT value FROM requests ORDER BY started_at DESC').all();
    return rows.map(row => decode<RequestRecord>(row)!);
  }
  request(id: string): RequestRecord | undefined { return decode<RequestRecord>(this.db.prepare('SELECT value FROM requests WHERE id=?').get(id)); }
  saveAttempt(value: AttemptRecord): void { this.db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, value.requestId, value.accountId, value.startedAt, JSON.stringify(value)); }
  attempts(requestId?: string): AttemptRecord[] {
    const rows = requestId ? this.db.prepare('SELECT value FROM attempts WHERE request_id=? ORDER BY started_at').all(requestId) : this.db.prepare('SELECT value FROM attempts ORDER BY started_at').all();
    return rows.map(row => decode<AttemptRecord>(row)!);
  }
  accountAttempts(accountId: string, from: string, until: string): AttemptRecord[] {
    return this.db.prepare('SELECT value FROM attempts WHERE account_id=? AND started_at>=? AND started_at<=? ORDER BY started_at').all(accountId, from, until).map(row => decode<AttemptRecord>(row)!);
  }
  bills(): Bill[] { return this.db.prepare("SELECT value FROM bills ORDER BY json_extract(value,'$.paidAt') DESC").all().map(row => decode<Bill>(row)!); }
  saveBill(value: Bill): void { this.db.prepare('INSERT INTO bills VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(value.id, JSON.stringify(value)); }
  deleteBill(id: string): boolean { return this.db.prepare('DELETE FROM bills WHERE id=?').run(id).changes > 0; }
  devices(): Device[] { return this.db.prepare('SELECT value FROM devices').all().map(row => decode<Device>(row)!); }
  createDevice(name: string): { item: Device; key: string } {
    const key = `moris_${newSecret()}`;
    const item: Device = { id: randomUUID(), name, createdAt: new Date().toISOString(), revokedAt: null, lastUsedAt: null };
    this.db.prepare('INSERT INTO devices VALUES (?,?,?)').run(item.id, hashSecret(key), JSON.stringify(item));
    return { item, key };
  }
  deviceForKey(key: string): Device | undefined {
    const item = decode<Device>(this.db.prepare('SELECT value FROM devices WHERE hash=?').get(hashSecret(key)));
    if (!item || item.revokedAt) return undefined;
    item.lastUsedAt = new Date().toISOString();
    this.db.prepare('UPDATE devices SET value=? WHERE id=?').run(JSON.stringify(item), item.id);
    return item;
  }
  revokeDevice(id: string): boolean {
    const item = this.devices().find(x => x.id === id);
    if (!item) return false;
    this.db.prepare('UPDATE devices SET value=? WHERE id=?').run(JSON.stringify({ ...item, revokedAt: new Date().toISOString() }), id);
    return true;
  }
  createSession(username: string): { token: string; csrfToken: string } {
    const token = newSecret(); const csrfToken = newSecret();
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hashSecret(token), Date.now() + 12 * 3_600_000, JSON.stringify({ username, csrfToken }));
    return { token, csrfToken };
  }
  session(token: string): { username: string; csrfToken: string } | undefined {
    return decode(this.db.prepare('SELECT value FROM sessions WHERE hash=? AND expires_at>?').get(hashSecret(token), Date.now()));
  }
  deleteSession(token: string): void { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hashSecret(token)); }
  async backup(path: string): Promise<void> { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); await backup(this.db, path); }
  close(): void { this.db.close(); }
}
