import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type AttemptRecord, type Bill, type StoredDeletion } from '../apps/gateway/src/store.js';
import type { DeletionAction, ProviderAccount, ProviderDeletion, ProviderModel } from '../packages/contracts/src/index.js';

const AT = '2026-01-01T00:00:00.000Z';
const key = () => randomBytes(32).toString('base64');

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'moris-deletion-store-'));
}

function accountOf(id: string, namespace: string, overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id, namespace, name: `供应商-${namespace}`, plugin: 'moris', baseUrl: 'https://api.example.test/base',
    billingType: 'metered', enabled: true, proxyId: 'proxy-1', autoCreateTokens: false,
    options: { secretOption: 'option-secret-value' }, createdAt: AT, updatedAt: AT,
    ...overrides,
  };
}

function modelOf(namespace: string, path: string): ProviderModel {
  return {
    path, upstreamModel: `upstream-${path}`, name: `模型-${path}`, family: 'test',
    protocol: 'chat-completions', capabilities: { tools: true, input: ['text'], output: ['text'] },
    limit: { context: 128000, output: 8192 }, variants: {},
    price: { kind: 'token', currency: 'USD', input: 1, output: 2 },
  };
}

function actionOf(id: string, state: DeletionAction['state']): DeletionAction {
  return { id, name: `动作-${id}`, externalId: `external-${id}`, disposition: 'ready', defaultSelected: true, references: [], state };
}

function taskOf(id: string, account: ProviderAccount, status: ProviderDeletion['status'], actions: DeletionAction[]): StoredDeletion {
  return {
    id, accountId: account.id, name: account.name, namespace: account.namespace, status, actions,
    createdAt: AT, updatedAt: AT, resources: {},
  };
}

function rawTable(store: Store, table: 'bills' | 'requests' | 'attempts'): Array<[string, string]> {
  return store.db.prepare(`SELECT id, value FROM ${table} ORDER BY id`).all()
    .map(row => [String(row.id), String(row.value)]);
}

const resourceInput = {
  kind: 'token' as const, scope: 'realseek', externalId: 'token-42', name: 'moris-deletion', group: 'svip',
  fingerprint: 'fingerprint-1', provenance: 'created' as const, credentialKey: 'token:svip',
};

const monitor = {
  state: 'ok' as const,
  balances: [{ currency: 'USD', amount: 12.5 }],
  windows: [],
  sampledAt: AT,
};

test('completeDeletion只清理目标账号配置并保留账本原始JSON与最小历史身份', () => {
  const dir = workspace();
  const path = join(dir, 'test.sqlite');
  const store = new Store(path, key());
  try {
    const a = accountOf('account-a', 'alpha');
    const b = accountOf('account-b', 'beta');
    store.saveProxy({ id: 'proxy-1', name: '共享代理', protocol: 'http', host: '127.0.0.1', port: 8080, username: 'user', hasPassword: true, createdAt: AT, updatedAt: AT }, 'proxy-password');
    store.saveAccount(a, { apiKey: 'sensitive-upstream-key' });
    store.saveAccount(b, { apiKey: 'other-upstream-key' });
    store.replaceCatalog(a, [modelOf('alpha', 'one'), modelOf('alpha', 'two')], AT);
    store.replaceCatalog(b, [modelOf('beta', 'one')], AT);
    store.saveModelParameters('alpha/one', { name: '手工名称', context: 7 });
    store.saveModelParameters('alpha/two', { output: 9 });
    store.saveModelParameters('beta/one', { context: 5 });
    store.saveMonitor(a.id, monitor);
    store.saveMonitor(b.id, { ...monitor, message: 'beta' });
    store.saveSettings({
      ...store.settings(),
      fallback: {
        'alpha/one': ['alpha/two', 'beta/one'],
        'alpha/two': ['alpha/one'],
        'beta/one': ['alpha/one'],
        'other/source': ['beta/one'],
      },
    });
    store.setMeta('unrelated-meta', { keep: true });
    const resource = store.recordResource('moris', a.id, resourceInput);
    const shared = store.recordResource('moris', b.id, resourceInput);
    assert.equal(shared.id, resource.id);

    const request = { id: 'request-1', modelId: 'alpha/one', deviceId: 'device-1', startedAt: AT, finishedAt: AT, status: 'succeeded' as const };
    const attempt: AttemptRecord = {
      id: 'attempt-1', requestId: request.id, accountId: a.id, modelId: 'alpha/one', number: 1,
      startedAt: AT, finishedAt: AT, status: 'failed', usage: null,
      price: { kind: 'unknown', currency: 'USD' },
      estimatedCost: null, settledCost: null, equivalentUsd: null, usdCny: null,
      estimatedCny: null, settledCny: null, billingType: 'metered',
    };
    const bill: Bill = { id: 'bill-1', accountId: a.id, paidAt: AT, amountCny: 50, note: '预付款', createdAt: AT, updatedAt: AT };
    store.saveRequest(request);
    store.saveAttempt(attempt);
    store.saveBill(bill);
    const rawBefore = { bills: rawTable(store, 'bills'), requests: rawTable(store, 'requests'), attempts: rawTable(store, 'attempts') };

    store.saveAccount({ ...a, deletionTaskId: 'task-a' });
    store.saveDeletion(taskOf('task-a', a, 'cleaning', [actionOf('deleted', 'deleted'), actionOf('absent', 'absent'), actionOf('skipped', 'skipped')]));
    store.completeDeletion('task-a');

    const history = store.historicalAccount(a.id)!;
    assert.ok(history);
    assert.deepEqual(Object.keys(history).sort(), ['billingType', 'createdAt', 'deletedAt', 'id', 'name', 'namespace', 'plugin']);
    assert.equal(history.id, a.id);
    assert.equal(history.name, a.name);
    assert.equal(history.namespace, a.namespace);
    assert.equal(history.plugin, a.plugin);
    assert.equal(history.billingType, a.billingType);
    assert.equal(history.createdAt, a.createdAt);
    assert.match(history.deletedAt, /^\d{4}-\d{2}-\d{2}T/);
    const historyJson = JSON.stringify(history);
    for (const leaked of ['baseUrl', 'api.example.test', 'options', 'option-secret-value', 'proxy-1', 'apiKey', 'sensitive-upstream-key']) {
      assert.ok(!historyJson.includes(leaked), `历史身份不得包含 ${leaked}`);
    }

    assert.equal(store.account(a.id), undefined);
    assert.throws(() => store.secrets(a.id), /供应商不存在/);
    assert.deepEqual(store.accounts().map(item => item.id), [b.id]);
    assert.deepEqual(store.models().map(item => item.id), ['beta/one']);
    assert.equal(store.model('alpha/one'), undefined);
    assert.equal(store.modelParameters('alpha/two'), undefined);
    assert.equal(store.model('beta/one')!.limit.context, 5);
    assert.equal(store.monitor(a.id), undefined);
    assert.equal(store.monitor(b.id)!.message, 'beta');

    assert.equal(store.getMeta('model-parameters:alpha/one'), undefined);
    assert.equal(store.getMeta('model-parameters:alpha/two'), undefined);
    assert.ok(store.getMeta('model-parameters:beta/one'));
    assert.equal(store.getMeta('recordingSince:account-a'), undefined);
    assert.ok(store.getMeta('recordingSince:account-b'));
    assert.deepEqual(store.getMeta('unrelated-meta'), { keep: true });

    // 只清理被删模型的来源与目标，其他回退配置原样保留。
    assert.deepEqual(store.settings().fallback, { 'other/source': ['beta/one'] });
    // 共享代理档案本身保留，仅移除被删账号的引用。
    assert.ok(store.proxy('proxy-1'));
    assert.equal(store.proxyPassword('proxy-1'), 'proxy-password');
    assert.deepEqual(store.proxyReferences('proxy-1'), [{ id: b.id, name: b.name }]);

    // 账本、请求、attempt 的原始 JSON（含未知金额的 null）逐字节不变。
    assert.deepEqual(rawTable(store, 'bills'), rawBefore.bills);
    assert.deepEqual(rawTable(store, 'requests'), rawBefore.requests);
    assert.deepEqual(rawTable(store, 'attempts'), rawBefore.attempts);
    assert.deepEqual(store.bills(), [bill]);
    const storedAttempt = store.attempts()[0]!;
    assert.deepEqual(storedAttempt, attempt);
    assert.equal(storedAttempt.estimatedCost, null);
    assert.equal(storedAttempt.settledCost, null);
    assert.equal(storedAttempt.estimatedCny, null);
    assert.equal(storedAttempt.settledCny, null);
    assert.deepEqual(store.requests(), [request]);

    // 共享资源归属只移除引用，记录、来源与创建时间不降级。
    const resourceAfter = store.resources()[0]!;
    assert.deepEqual(resourceAfter.accountIds, [b.id]);
    assert.equal(resourceAfter.provenance, shared.provenance);
    assert.equal(resourceAfter.fingerprint, shared.fingerprint);
    assert.equal(resourceAfter.createdAt, shared.createdAt);
    const task = store.deletion('task-a')!;
    assert.equal(task.status, 'completed');
    assert.match(task.message!, /历史账本保留/);
    assert.equal(store.deleting(a.id), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('未完成动作、非cleaning状态或账号删除锁不符时拒绝completeDeletion', () => {
  const store = new Store(':memory:', key());
  try {
    const a = accountOf('account-a', 'alpha');
    store.saveAccount(a);
    store.replaceCatalog(a, [modelOf('alpha', 'one')], AT);
    store.saveModelParameters('alpha/one', { context: 3 });
    store.saveAccount({ ...a, deletionTaskId: 'task-running' });
    store.saveDeletion(taskOf('task-running', a, 'cleaning', [actionOf('done', 'deleted'), actionOf('busy', 'running')]));
    assert.throws(() => store.completeDeletion('task-running'), /删除任务尚未完成/);
    store.saveDeletion(taskOf('task-draining', a, 'draining', [actionOf('done', 'deleted')]));
    assert.throws(() => store.completeDeletion('task-draining'), /删除任务尚未完成/);
    store.saveDeletion(taskOf('task-mismatch', a, 'cleaning', [actionOf('done', 'deleted')]));
    assert.throws(() => store.completeDeletion('task-mismatch'), /供应商删除状态已改变/);
    assert.throws(() => store.completeDeletion('missing-task'), /删除任务尚未完成/);

    assert.ok(store.account(a.id));
    assert.ok(store.model('alpha/one'));
    assert.equal(store.model('alpha/one')!.limit.context, 3);
    assert.deepEqual(store.history(), []);
    for (const id of ['task-running', 'task-draining', 'task-mismatch']) assert.notEqual(store.deletion(id)!.status, 'completed');
    assert.equal(store.deleting(a.id), true);
  } finally {
    store.close();
  }
});

test('completeDeletion中途出错时整体回滚，不留下半删状态', () => {
  const store = new Store(':memory:', key());
  try {
    const a = accountOf('account-a', 'alpha');
    const b = accountOf('account-b', 'beta');
    store.saveAccount(a, { apiKey: 'sensitive-upstream-key' });
    store.saveAccount(b);
    store.replaceCatalog(a, [modelOf('alpha', 'one')], AT);
    store.saveModelParameters('alpha/one', { name: '保留到提交' });
    const parametersBefore = store.getMeta('model-parameters:alpha/one');
    store.setMeta('recordingSince:account-a', AT);
    store.saveSettings(store.settings());
    store.saveAccount({ ...a, deletionTaskId: 'task-a' });
    store.saveDeletion(taskOf('task-a', a, 'cleaning', [actionOf('done', 'deleted')]));
    // 用损坏的 settings 让事务在写入历史身份和删除模型 meta 之后失败。
    store.db.prepare("UPDATE meta SET value='{broken' WHERE key='settings'").run();

    assert.throws(() => store.completeDeletion('task-a'));

    assert.ok(store.account(a.id), '账号行必须回滚');
    assert.equal(store.secrets(a.id).apiKey, 'sensitive-upstream-key');
    assert.ok(store.model('alpha/one'), '模型必须回滚');
    assert.deepEqual(store.getMeta('model-parameters:alpha/one'), parametersBefore);
    assert.equal(store.getMeta('recordingSince:account-a'), AT);
    assert.deepEqual(store.history(), []);
    assert.equal(store.deletion('task-a')!.status, 'cleaning');
    assert.deepEqual(store.accounts().map(item => item.id).sort(), [a.id, b.id]);
    // 事务已结束，后续写入仍可用。
    store.setMeta('after-rollback', 'ok');
    assert.equal(store.getMeta('after-rollback'), 'ok');
  } finally {
    store.close();
  }
});

test('删除后旧accountId不能saveAccount复活，但同命名空间可用新ID重建', () => {
  const dir = workspace();
  const path = join(dir, 'test.sqlite');
  const store = new Store(path, key());
  try {
    const a = accountOf('account-a', 'alpha');
    store.saveAccount(a, { apiKey: 'old-key' });
    store.replaceCatalog(a, [modelOf('alpha', 'one')], AT);
    store.saveAccount({ ...a, deletionTaskId: 'task-a' });
    store.saveDeletion(taskOf('task-a', a, 'cleaning', [actionOf('done', 'deleted')]));
    store.completeDeletion('task-a');

    assert.throws(() => store.saveAccount(a), /已删除的供应商不能重新写入/);
    assert.equal(store.account(a.id), undefined);
    assert.equal(store.historicalAccount(a.id)!.name, a.name);

    const rebuilt = accountOf('account-a-new', 'alpha', { name: '新供应商' });
    store.saveAccount(rebuilt);
    assert.equal(store.account(rebuilt.id)!.namespace, 'alpha');
    assert.deepEqual(store.secrets(rebuilt.id), {});
    assert.equal(store.historicalAccount(rebuilt.id), undefined);
    assert.deepEqual(store.history().map(item => item.id), [a.id]);
    assert.equal(store.historicalAccount(a.id)!.name, a.name);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('共享资源归属不降级，删除owner后仍可保存最后引用并拒绝指纹变化', () => {
  const store = new Store(':memory:', key());
  try {
    const a = accountOf('account-a', 'alpha');
    const b = accountOf('account-b', 'beta');
    const c = accountOf('account-c', 'gamma');
    for (const item of [a, b, c]) store.saveAccount(item);

    const created = store.recordResource('moris', a.id, resourceInput);
    const shared = store.recordResource('moris', b.id, resourceInput);
    assert.equal(shared.id, created.id);
    assert.deepEqual(shared.accountIds, [a.id, b.id]);
    assert.equal(shared.provenance, 'created');
    assert.equal(shared.fingerprint, 'fingerprint-1');
    assert.equal(shared.createdAt, created.createdAt);
    assert.throws(() => store.recordResource('moris', b.id, { ...resourceInput, fingerprint: 'fingerprint-2' }), /资源凭据已变更/);

    store.saveAccount({ ...a, deletionTaskId: 'task-a' });
    store.saveDeletion(taskOf('task-a', a, 'cleaning', [actionOf('done', 'deleted')]));
    store.completeDeletion('task-a');
    let resource = store.resources()[0]!;
    assert.deepEqual(resource.accountIds, [b.id]);
    assert.equal(resource.provenance, 'created');
    assert.equal(resource.fingerprint, 'fingerprint-1');
    assert.equal(resource.createdAt, created.createdAt);
    assert.throws(() => store.recordResource('moris', a.id, resourceInput), /供应商不存在/);
    assert.deepEqual(store.recordResource('moris', b.id, resourceInput).accountIds, [b.id]);

    store.saveAccount({ ...b, deletionTaskId: 'task-b' });
    store.saveDeletion(taskOf('task-b', b, 'cleaning', [actionOf('done', 'deleted')]));
    store.completeDeletion('task-b');
    resource = store.resources()[0]!;
    assert.deepEqual(resource.accountIds, []);
    assert.equal(resource.provenance, 'created');
    assert.equal(resource.createdAt, created.createdAt);

    // 最后一个引用删除后记录仍保留，可由其他账号以相同指纹继续引用。
    const readopted = store.recordResource('moris', c.id, resourceInput);
    assert.deepEqual(readopted.accountIds, [c.id]);
    assert.equal(readopted.provenance, 'created');
    assert.equal(readopted.createdAt, created.createdAt);
    assert.throws(() => store.recordResource('moris', c.id, { ...resourceInput, fingerprint: 'fingerprint-3' }), /资源凭据已变更/);
    assert.equal(store.resources().length, 1);
  } finally {
    store.close();
  }
});

test('文件数据库重启把draining/cleaning变paused、running动作变unknown且不自动清理', () => {
  const dir = workspace();
  const path = join(dir, 'test.sqlite');
  const k = key();
  let store = new Store(path, k);
  try {
    const a = accountOf('account-a', 'alpha');
    const b = accountOf('account-b', 'beta');
    store.saveAccount(a);
    store.saveAccount(b);
    store.replaceCatalog(a, [modelOf('alpha', 'one')], AT);
    store.replaceCatalog(b, [modelOf('beta', 'one')], AT);
    store.recordResource('moris', a.id, resourceInput);
    store.saveDeletion(taskOf('task-drain', a, 'draining', [actionOf('running', 'running')]));
    store.saveDeletion(taskOf('task-clean', b, 'cleaning', [actionOf('unknown-less', 'running'), actionOf('pending', 'pending')]));
    store.saveDeletion(taskOf('task-done', a, 'completed', [actionOf('done', 'deleted')]));
    store.saveAccount({ ...a, deletionTaskId: 'task-drain' });
    store.saveAccount({ ...b, deletionTaskId: 'task-clean' });
    store.close();

    store = new Store(path, k);
    for (const id of ['task-drain', 'task-clean']) {
      const task = store.deletion(id)!;
      assert.equal(task.status, 'paused');
      assert.match(task.message!, /手动继续/);
      assert.match(task.message!, /不会自动重发上游删除/);
    }
    assert.equal(store.deletion('task-drain')!.actions[0]!.state, 'unknown');
    assert.deepEqual(store.deletion('task-clean')!.actions.map(item => item.state), ['unknown', 'pending']);
    assert.equal(store.deletion('task-done')!.status, 'completed');
    assert.equal(store.deletion('task-done')!.actions[0]!.state, 'deleted');

    // 重启不清理账号、模型与资源归属，也不把任务标记完成。
    assert.deepEqual(store.accounts().map(item => item.id).sort(), [a.id, b.id]);
    assert.deepEqual(store.models().map(item => item.id).sort(), ['alpha/one', 'beta/one']);
    assert.deepEqual(store.resources()[0]!.accountIds, [a.id]);
    assert.equal(store.deleting(a.id), true);
    assert.equal(store.deleting(b.id), true);
    store.close();

    // 再次重启保持 paused，不重复改写。
    store = new Store(path, k);
    assert.equal(store.deletion('task-drain')!.status, 'paused');
    assert.equal(store.deletion('task-drain')!.actions[0]!.state, 'unknown');
    assert.equal(store.deletion('task-clean')!.actions[1]!.state, 'pending');
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('旧库可原样重开并增量创建新表，不自动删除或改写既有数据', () => {
  const dir = workspace();
  const path = join(dir, 'legacy.sqlite');
  const k = key();
  const legacyAccount = accountOf('legacy-a', 'legacy');
  const legacyBill: Bill = { id: 'legacy-bill', accountId: legacyAccount.id, paidAt: AT, amountCny: 88, note: '旧账单', createdAt: AT, updatedAt: AT };
  const legacyRequest = { id: 'legacy-request', modelId: 'legacy/one', deviceId: 'legacy-device', startedAt: AT, finishedAt: AT, status: 'succeeded' };
  const legacyAttempt: AttemptRecord = {
    id: 'legacy-attempt', requestId: legacyRequest.id, accountId: legacyAccount.id, modelId: 'legacy/one', number: 1,
    startedAt: AT, finishedAt: AT, status: 'failed', usage: null, price: { kind: 'unknown', currency: 'USD' },
    estimatedCost: null, settledCost: null, equivalentUsd: null, usdCny: null, estimatedCny: null, settledCny: null, billingType: 'metered',
  };

  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, namespace TEXT UNIQUE NOT NULL, value TEXT NOT NULL, secrets TEXT NOT NULL, sync TEXT NOT NULL);
    CREATE TABLE proxies (id TEXT PRIMARY KEY, value TEXT NOT NULL, secrets TEXT NOT NULL);
    CREATE TABLE models (id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), value TEXT NOT NULL);
    CREATE TABLE monitors (account_id TEXT PRIMARY KEY REFERENCES accounts(id), value TEXT NOT NULL);
    CREATE TABLE requests (id TEXT PRIMARY KEY, started_at TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE attempts (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), account_id TEXT NOT NULL, started_at TEXT NOT NULL, value TEXT NOT NULL);
    CREATE TABLE bills (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE devices (id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
    CREATE TABLE sessions (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, value TEXT NOT NULL);
  `);
  db.prepare('INSERT INTO accounts VALUES (?,?,?,?,?)').run(legacyAccount.id, legacyAccount.namespace, JSON.stringify(legacyAccount),
    '{}', JSON.stringify({ lastSyncedAt: AT, lastAttemptAt: AT, error: null }));
  db.prepare('INSERT INTO models VALUES (?,?,?)').run('legacy/one', legacyAccount.id, JSON.stringify({ ...modelOf('legacy', 'one'), id: 'legacy/one', accountId: legacyAccount.id, namespace: 'legacy', billingType: 'metered', enabled: true, syncedAt: AT }));
  db.prepare('INSERT INTO requests VALUES (?,?,?)').run(legacyRequest.id, legacyRequest.startedAt, JSON.stringify(legacyRequest));
  db.prepare('INSERT INTO attempts VALUES (?,?,?,?,?)').run(legacyAttempt.id, legacyAttempt.requestId, legacyAttempt.accountId, legacyAttempt.startedAt, JSON.stringify(legacyAttempt));
  db.prepare('INSERT INTO bills VALUES (?,?)').run(legacyBill.id, JSON.stringify(legacyBill));
  db.prepare('INSERT INTO meta VALUES (?,?)').run('admin', JSON.stringify({ username: 'legacy', passwordHash: 'x' }));
  db.close();

  const tables = (store: Store) => store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name));
  const rawBefore = { bills: rawTableStore(path, 'bills'), requests: rawTableStore(path, 'requests'), attempts: rawTableStore(path, 'attempts') };

  let store = new Store(path, k);
  try {
    assert.ok(tables(store).includes('provider_history'));
    assert.ok(tables(store).includes('managed_resources'));
    assert.ok(tables(store).includes('provider_deletions'));
    assert.deepEqual(store.history(), []);
    assert.deepEqual(store.resources(), []);
    assert.deepEqual(store.deletions(), []);
    assert.deepEqual(store.accounts().map(item => item.id), [legacyAccount.id]);
    assert.deepEqual(store.bills(), [legacyBill]);
    assert.deepEqual(store.attempts(), [legacyAttempt]);
    assert.deepEqual(store.requests(), [legacyRequest]);
    assert.ok(store.getMeta('recordingSince'));
    assert.deepEqual(store.getMeta('admin'), { username: 'legacy', passwordHash: 'x' });

    // 增量表在新库上可正常写入，且不需要删除旧行。
    store.recordResource('moris', legacyAccount.id, resourceInput);
    store.saveDeletion(taskOf('legacy-task', legacyAccount, 'failed', [actionOf('item', 'failed')]));
    assert.equal(store.deletions().length, 1);
    store.close();

    store = new Store(path, k);
    assert.equal(store.resources().length, 1);
    assert.equal(store.deletions()[0]!.status, 'failed');
    assert.deepEqual(store.bills(), [legacyBill]);
    assert.deepEqual(store.accounts().map(item => item.id), [legacyAccount.id]);
    assert.deepEqual({ bills: rawTable(store, 'bills'), requests: rawTable(store, 'requests'), attempts: rawTable(store, 'attempts') }, rawBefore);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function rawTableStore(path: string, table: 'bills' | 'requests' | 'attempts'): Array<[string, string]> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(`SELECT id, value FROM ${table} ORDER BY id`).all().map(row => [String(row.id), String(row.value)]);
  } finally {
    db.close();
  }
}
