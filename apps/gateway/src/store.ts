import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SETTINGS, type CatalogModel, type Money, type Price, type ProviderAccount, type ProviderModel, type ProviderMonitor, type Settings, type Usage } from '../../../packages/contracts/src/index.js';
import { hashSecret, newSecret, passwordHash, Vault } from './security.js';

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
  account(id: string): ProviderAccount | undefined { return decode<ProviderAccount>(this.db.prepare('SELECT value FROM accounts WHERE id=?').get(id)); }
  saveAccount(account: ProviderAccount, secrets?: Record<string, string>): void {
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
    const paths = new Set<string>();
    for (const model of models) {
      if (!model.path || model.path.startsWith('/') || paths.has(model.path)) throw new Error('模型目录存在空路径或重复路径');
      paths.add(model.path);
    }
    this.transaction(() => {
      for (const old of this.models().filter(m => m.accountId === account.id)) {
        this.saveModel({ ...old, enabled: false, disabledReason: '上游完整目录已移除该模型，请重新选择' });
      }
      for (const model of models) {
        const complete = Number.isFinite(model.limit.context) && Number.isFinite(model.limit.output) && (model.limit.context ?? 0) > 0 && (model.limit.output ?? 0) > 0 && !!model.family;
        this.saveModel({ ...model, id: `${account.namespace}/${model.path}`, accountId: account.id,
          namespace: account.namespace, billingType: account.billingType, enabled: complete && model.enabled !== false,
          disabledReason: !complete ? '缺少可信模型参数' : model.disabledReason, syncedAt: at });
      }
      this.db.prepare('UPDATE accounts SET sync=? WHERE id=?').run(JSON.stringify({ lastSyncedAt: at, lastAttemptAt: at, error: null }), account.id);
    });
  }
  private saveModel(model: CatalogModel): void { this.db.prepare('INSERT INTO models VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(model.id, model.accountId, JSON.stringify(model)); }
  models(): CatalogModel[] { return this.db.prepare('SELECT value FROM models ORDER BY id').all().map(row => decode<CatalogModel>(row)!); }
  model(id: string): CatalogModel | undefined { return decode<CatalogModel>(this.db.prepare('SELECT value FROM models WHERE id=?').get(id)); }
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
  bills(): Bill[] { return this.db.prepare('SELECT value FROM bills ORDER BY json_extract(value,\'paidAt\') DESC').all().map(row => decode<Bill>(row)!); }
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
