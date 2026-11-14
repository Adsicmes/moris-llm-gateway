import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, type AttemptRecord, type Bill } from '../apps/gateway/src/store.js';
import { ProviderRegistry, Providers } from '../apps/gateway/src/providers.js';
import { Transport } from '../apps/gateway/src/network.js';
import { ProviderDeletions, type DeletionSelection } from '../apps/gateway/src/provider-deletion.js';
import type { ProviderPlugin } from '../packages/provider-sdk/src/index.js';
import type { ManagedResourceInput, ProviderAccount, ProviderModel } from '../packages/contracts/src/index.js';

const NOW = '2026-01-01T00:00:00.000Z';
const key = () => randomBytes(32).toString('base64');

type Outcome = 'deleted' | 'absent' | 'failed' | 'unknown';
type PreviewMode = 'normal' | 'throw' | 'absent';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

async function waitFor(predicate: () => boolean, message: string, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${message}`);
    await sleep(5);
  }
}

function accountOf(id: string, namespace: string, plugin = 'fake'): ProviderAccount {
  return {
    id, namespace, name: `供应商-${namespace}`, plugin, baseUrl: 'https://upstream.test', billingType: 'metered',
    enabled: true, proxyId: null, autoCreateTokens: false, options: {}, createdAt: NOW, updatedAt: NOW,
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

function resourceOf(externalId: string, overrides: Partial<ManagedResourceInput> = {}): ManagedResourceInput {
  return {
    kind: 'token', scope: 'realservice:/api', externalId, name: `moris-token-${externalId}`, group: 'default',
    fingerprint: 'fingerprint-1', provenance: 'created', credentialKey: 'token:default', ...overrides,
  };
}

interface FakeState {
  resources: ManagedResourceInput[];
  previewMode: PreviewMode;
  executeResults: Outcome[];
  previewCalls: number;
  executeCalls: string[];
  deleteAttempts: string[];
  gates: Map<string, ReturnType<typeof deferred<Outcome>>>;
}

function fakeCleanup(id: string, resources: ManagedResourceInput[]) {
  const state: FakeState = {
    resources, previewMode: 'normal', executeResults: [], previewCalls: 0,
    executeCalls: [], deleteAttempts: [], gates: new Map(),
  };
  const plugin: ProviderPlugin = {
    id, name: id,
    discover: async () => ({ complete: true, models: [] }),
    prepare: async () => { throw new Error('测试不应准备推理请求'); },
    cleanup: {
      preview: async () => {
        state.previewCalls += 1;
        if (state.previewMode === 'throw') throw new Error('模拟上游清单读取失败');
        if (state.previewMode === 'absent') return state.resources.map(resource => ({ resource, verified: false, absent: true }));
        return state.resources.map(resource => ({ resource, verified: true }));
      },
      execute: async (_context, resource) => {
        state.executeCalls.push(resource.externalId);
        const gate = state.gates.get(resource.externalId);
        const outcome: Outcome = gate ? await gate.promise : (state.executeResults.shift() ?? 'deleted');
        if (outcome !== 'absent') state.deleteAttempts.push(resource.externalId);
        return { state: outcome, message: outcome === 'failed' ? '模拟清理失败' : undefined };
      },
    },
  };
  return { plugin, state };
}

function barePlugin(id: string): ProviderPlugin {
  return {
    id, name: id,
    discover: async () => ({ complete: true, models: [] }),
    prepare: async () => { throw new Error('测试不应准备推理请求'); },
  };
}

function selectionOf(revision: string, namespace: string, overrides: Partial<DeletionSelection> = {}): DeletionSelection {
  return {
    revision, selectedActionIds: [], adoptActionIds: [], confirmNamespace: namespace,
    acknowledgeUnsettled: false, acknowledgeUncleaned: false, ...overrides,
  };
}

function attemptOf(accountId: string): { request: { id: string; modelId: string; deviceId: string; startedAt: string; finishedAt: string; status: 'succeeded' }; attempt: AttemptRecord } {
  const request = { id: `request-${accountId}`, modelId: 'alpha/one', deviceId: 'device', startedAt: NOW, finishedAt: NOW, status: 'succeeded' as const };
  const attempt: AttemptRecord = {
    id: `attempt-${accountId}`, requestId: request.id, accountId, modelId: 'alpha/one', number: 1,
    startedAt: NOW, finishedAt: NOW, status: 'succeeded', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    price: { kind: 'token', currency: 'USD', input: 1, output: 2 }, estimatedCost: null, settledCost: null,
    equivalentUsd: null, usdCny: null, estimatedCny: null, settledCny: null, billingType: 'metered',
  };
  return { request, attempt };
}

function rawTable(store: Store, table: 'bills' | 'requests' | 'attempts'): Array<[string, string]> {
  return store.db.prepare(`SELECT id, value FROM ${table} ORDER BY id`).all().map(row => [String(row.id), String(row.value)]);
}

test('默认ready清理只删本地配置与凭据，保留账本并确认未结算', async () => {
  const store = new Store(':memory:', key());
  const registry = new ProviderRegistry();
  const transport = new Transport();
  const providers = new Providers(store, registry, transport);
  const invalidated: string[] = [];
  const deletions = new ProviderDeletions(store, providers, id => invalidated.push(id));
  const account = accountOf('account-a', 'alpha');
  const resource = resourceOf('tok-1');
  const { plugin, state } = fakeCleanup('fake', [resource]);
  registry.register(plugin);
  try {
    store.saveAccount(account, { apiKey: 'sensitive-upstream-key' });
    store.replaceCatalog(account, [modelOf('alpha', 'one')], NOW);
    store.saveMonitor(account.id, { state: 'ok', balances: [{ currency: 'USD', amount: 1 }], windows: [], sampledAt: NOW });
    store.recordResource('fake', account.id, resource);
    const { request, attempt } = attemptOf(account.id);
    const bill: Bill = { id: 'bill-1', accountId: account.id, paidAt: NOW, amountCny: 50, createdAt: NOW, updatedAt: NOW };
    store.saveRequest(request);
    store.saveAttempt(attempt);
    store.saveBill(bill);
    const rawBefore = { bills: rawTable(store, 'bills'), requests: rawTable(store, 'requests'), attempts: rawTable(store, 'attempts') };

    const preview = await deletions.preview(account.id);
    assert.equal(preview.cleanupSupported, true);
    assert.equal(preview.actions.length, 1);
    assert.equal(preview.actions[0]!.disposition, 'ready');
    assert.equal(preview.actions[0]!.defaultSelected, true);
    assert.deepEqual(preview.actions[0]!.references, []);
    assert.equal(preview.actions[0]!.state, 'pending');
    assert.equal(preview.unsettledAttempts, 1);
    assert.ok(preview.warnings.length >= 2);

    const selection = selectionOf(preview.revision, 'alpha', { selectedActionIds: [preview.actions[0]!.id] });
    await assert.rejects(deletions.start(account.id, selection), code('deletion_confirmation'));

    const task = await deletions.start(account.id, { ...selection, acknowledgeUnsettled: true });
    await waitFor(() => store.deletion(task.id)?.status === 'completed', '任务完成');
    assert.deepEqual(state.executeCalls, ['tok-1']);
    assert.deepEqual(state.deleteAttempts, ['tok-1']);
    assert.deepEqual(invalidated, [account.id]);

    assert.equal(store.account(account.id), undefined);
    assert.equal(store.historicalAccount(account.id)!.namespace, 'alpha');
    assert.deepEqual(store.models(), []);
    assert.throws(() => store.secrets(account.id), /供应商不存在/);
    assert.deepEqual(rawTable(store, 'bills'), rawBefore.bills);
    assert.deepEqual(rawTable(store, 'requests'), rawBefore.requests);
    assert.deepEqual(rawTable(store, 'attempts'), rawBefore.attempts);
    assert.deepEqual(store.bills(), [bill]);
    assert.equal(store.deletion(task.id)!.actions[0]!.state, 'deleted');
    assert.equal(store.deleting(account.id), false);
  } finally {
    await deletions.close();
    await transport.close();
    store.close();
  }
});

test('旧资源必须显式adopt确认，仅选择或仅adopt都拒绝', async () => {
  const store = new Store(':memory:', key());
  const registry = new ProviderRegistry();
  const transport = new Transport();
  const providers = new Providers(store, registry, transport);
  const deletions = new ProviderDeletions(store, providers, () => undefined);
  const account = accountOf('account-a', 'alpha');
  const resource = resourceOf('tok-legacy');
  const { plugin, state } = fakeCleanup('fake', [resource]);
  registry.register(plugin);
  try {
    store.saveAccount(account);
    const preview = await deletions.preview(account.id);
    const action = preview.actions[0]!;
    assert.equal(action.disposition, 'adopt');
    assert.equal(action.defaultSelected, false);

    await assert.rejects(deletions.start(account.id, selectionOf(preview.revision, 'alpha', { selectedActionIds: [action.id], acknowledgeUncleaned: true })), code('deletion_selection'));
    await assert.rejects(deletions.start(account.id, selectionOf(preview.revision, 'alpha', { adoptActionIds: [action.id] })), code('deletion_selection'));

    const task = await deletions.start(account.id, selectionOf(preview.revision, 'alpha', {
      selectedActionIds: [action.id], adoptActionIds: [action.id],
    }));
    await waitFor(() => store.deletion(task.id)?.status === 'completed', '认领后完成');
    assert.deepEqual(state.executeCalls, ['tok-legacy']);
    assert.equal(store.historicalAccount(account.id)!.id, account.id);
    const managed = store.resources()[0]!;
    assert.equal(managed.provenance, 'adopted');
    assert.deepEqual(managed.accountIds, []);
  } finally {
    await deletions.close();
    await transport.close();
    store.close();
  }
});

test('共享资源跳过清理，最后一个引用删除后才可清理', async () => {
  const store = new Store(':memory:', key());
  const registry = new ProviderRegistry();
  const transport = new Transport();
  const providers = new Providers(store, registry, transport);
  const deletions = new ProviderDeletions(store, providers, () => undefined);
  const a = accountOf('account-a', 'alpha');
  const b = accountOf('account-b', 'beta');
  const resource = resourceOf('tok-shared');
  const { plugin, state } = fakeCleanup('fake', [resource]);
  registry.register(plugin);
  try {
    store.saveAccount(a);
    store.saveAccount(b);
    store.recordResource('fake', a.id, resource);
    store.recordResource('fake', b.id, resource);

    const previewA = await deletions.preview(a.id);
    const sharedAction = previewA.actions[0]!;
    assert.equal(sharedAction.disposition, 'shared');
    assert.equal(sharedAction.defaultSelected, false);
    assert.deepEqual(sharedAction.references, [{ id: b.id, name: b.name }]);
    const taskA = await deletions.start(a.id, selectionOf(previewA.revision, 'alpha'));
    await waitFor(() => store.deletion(taskA.id)?.status === 'completed', '共享资源跳过并完成本地删除');
    assert.deepEqual(state.executeCalls, []);
    assert.equal(store.account(a.id), undefined);
    assert.deepEqual(store.resources()[0]!.accountIds, [b.id]);

    const previewB = await deletions.preview(b.id);
    assert.equal(previewB.actions[0]!.disposition, 'ready');
    assert.deepEqual(previewB.actions[0]!.references, []);
    const taskB = await deletions.start(b.id, selectionOf(previewB.revision, 'beta', { selectedActionIds: [previewB.actions[0]!.id] }));
    await waitFor(() => store.deletion(taskB.id)?.status === 'completed', '最后引用可清理');
    assert.deepEqual(state.executeCalls, ['tok-shared']);
    assert.equal(store.account(b.id), undefined);
    assert.equal(store.resources().length, 1);
    assert.deepEqual(store.resources()[0]!.accountIds, []);
  } finally {
    await deletions.close();
    await transport.close();
    store.close();
  }
});

test('预览过期、配置变化或未知revision拒绝启动', async () => {
  const store = new Store(':memory:', key());
  const registry = new ProviderRegistry();
  const transport = new Transport();
  const providers = new Providers(store, registry, transport);
  const deletions = new ProviderDeletions(store, providers, () => undefined);
  const account = accountOf('account-a', 'alpha');
  registry.register(fakeCleanup('fake', [resourceOf('tok-1')]).plugin);
  try {
    store.saveAccount(account);
    const first = await deletions.preview(account.id);
    store.saveAccount({ ...account, name: '配置已变化' });
    await assert.rejects(deletions.start(account.id, selectionOf(first.revision, 'alpha')), code('deletion_conflict'));

    const second = await deletions.preview(account.id);
    store.saveAccount(accountOf('account-c', 'gamma'));
    await assert.rejects(deletions.start(account.id, selectionOf(second.revision, 'alpha')), code('deletion_conflict'));

    const third = await deletions.preview(account.id);
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60_000;
    try {
      await assert.rejects(deletions.start(account.id, selectionOf(third.revision, 'alpha')), code('deletion_conflict'));
    } finally {
      Date.now = realNow;
    }

    const fourth = await deletions.preview(account.id);
    await assert.rejects(deletions.start(account.id, selectionOf('unknown-revision', 'alpha')), code('deletion_conflict'));
    await assert.rejects(deletions.start(account.id, selectionOf(fourth.revision, 'wrong')), code('deletion_confirmation'));

    const task = await deletions.start(account.id, selectionOf(fourth.revision, 'alpha', { acknowledgeUncleaned: true }));
    await waitFor(() => store.deletion(task.id)?.status === 'completed', '确认命名空间后完成');
    assert.equal(store.account(account.id), undefined);
  } finally {
    await deletions.close();
    await transport.close();
    store.close();
  }
});

test('无清理能力或preview失败必须确认未清理才可仅删本地', async () => {
  const store = new Store(':memory:', key());
  const registry = new ProviderRegistry();
  const transport = new Transport();
  const providers = new Providers(store, registry, transport);
  const deletions = new ProviderDeletions(store, providers, () => undefined);
  const plain = accountOf('account-plain', 'plain', 'plain');
  const broken = accountOf('account-broken', 'broken', 'broken');
  const { plugin: brokenPlugin, state: brokenState } = fakeCleanup('broken', [resourceOf('tok-1')]);
  brokenState.previewMode = 'throw';
  registry.register(barePlugin('plain'));
  registry.register(brokenPlugin);
  try {
    store.saveAccount(plain);
    store.saveAccount(broken);

    const plainPreview = await deletions.preview(plain.id);
    assert.equal(plainPreview.cleanupSupported, false);
    assert.deepEqual(plainPreview.actions, []);
    assert.ok(plainPreview.warnings.some(item => item.includes('尚不支持可验证的上游清理')));
    await assert.rejects(deletions.start(plain.id, selectionOf(plainPreview.revision, 'plain')), code('deletion_confirmation'));
    const plainTask = await deletions.start(plain.id, selectionOf(plainPreview.revision, 'plain', { acknowledgeUncleaned: true }));
    await waitFor(() => store.deletion(plainTask.id)?.status === 'completed', '无清理能力仅删本地');
    assert.equal(store.account(plain.id), undefined);

    const brokenPreview = await deletions.preview(broken.id);
    assert.equal(brokenPreview.cleanupSupported, true);
    assert.deepEqual(brokenPreview.actions, []);
    assert.ok(brokenPreview.warnings.some(item => item.startsWith('无法核验')));
    await assert.rejects(deletions.start(broken.id, selectionOf(brokenPreview.revision, 'broken')), code('deletion_confirmation'));
    const brokenTask = await deletions.start(broken.id, selectionOf(brokenPreview.revision, 'broken', { acknowledgeUncleaned: true }));
    await waitFor(() => store.deletion(brokenTask.id)?.status === 'completed', '预览失败后仅删本地');
    assert.equal(store.account(broken.id), undefined);
    assert.deepEqual(brokenState.executeCalls, []);
  } finally {
    await deletions.close();
    await transport.close();
    store.close();
  }
});

test('在途prepare/sync/OAuth租约使任务保持draining，拒绝新acquire，释放后才清理', async () => {
  const store = new Store(':memory:', key());
  const registry = new ProviderRegistry();
  const transport = new Transport();
  const providers = new Providers(store, registry, transport);
  const deletions = new ProviderDeletions(store, providers, () => undefined);
  const account = accountOf('account-a', 'alpha');
  const resource = resourceOf('tok-1');
  const { plugin, state } = fakeCleanup('fake', [resource]);
  registry.register(plugin);
  try {
    store.saveAccount(account);
    store.recordResource('fake', account.id, resource);
    const preview = await deletions.preview(account.id);
    const release = providers.acquire(account.id);
    try {
      const task = await deletions.start(account.id, selectionOf(preview.revision, 'alpha', {
        selectedActionIds: [preview.actions[0]!.id], acknowledgeUnsettled: true,
      }));
      await flush(); await flush();
      const during = store.deletion(task.id)!;
      assert.equal(during.status, 'draining');
      assert.deepEqual(state.executeCalls, []);
      assert.throws(() => providers.acquire(account.id), /供应商正在删除或已不存在/);
      assert.equal(providers.isBusy(account.id), true);

      release();
      await waitFor(() => store.deletion(task.id)?.status === 'completed', '租约释放后执行清理');
      assert.deepEqual(state.executeCalls, ['tok-1']);
      assert.equal(store.account(account.id), undefined);
    } finally {
      release();
    }
  } finally {
    await deletions.close();
    await transport.close();
    store.close();
  }
});

test('failed/unknown不删本地且不自动重试，手动retry重新核验absent且不盲目DELETE', async () => {
  const store = new Store(':memory:', key());
  const registry = new ProviderRegistry();
  const transport = new Transport();
  const providers = new Providers(store, registry, transport);
  const deletions = new ProviderDeletions(store, providers, () => undefined);
  const account = accountOf('account-a', 'alpha');
  const resource = resourceOf('tok-1');
  const { plugin, state } = fakeCleanup('fake', [resource]);
  state.executeResults = ['failed', 'unknown'];
  registry.register(plugin);
  try {
    store.saveAccount(account, { apiKey: 'sensitive-upstream-key' });
    store.replaceCatalog(account, [modelOf('alpha', 'one')], NOW);
    store.recordResource('fake', account.id, resource);
    const preview = await deletions.preview(account.id);
    const task = await deletions.start(account.id, selectionOf(preview.revision, 'alpha', { selectedActionIds: [preview.actions[0]!.id] }));

    await waitFor(() => store.deletion(task.id)?.status === 'failed', '首次失败');
    assert.equal(store.deletion(task.id)!.actions[0]!.state, 'failed');
    assert.deepEqual(state.executeCalls, ['tok-1']);
    assert.deepEqual(state.deleteAttempts, ['tok-1']);
    assert.ok(store.account(account.id), '失败不删除本地配置');
    assert.equal(store.account(account.id)!.enabled, false);
    assert.equal(store.secrets(account.id).apiKey, 'sensitive-upstream-key');
    assert.deepEqual(store.models().map(item => item.id), ['alpha/one']);
    assert.deepEqual(store.history(), []);
    await sleep(30);
    assert.deepEqual(state.executeCalls, ['tok-1'], '不自动重试上游删除');

    await deletions.retry(task.id);
    await waitFor(() => state.executeCalls.length === 2 && store.deletion(task.id)?.status === 'failed', '未知结果');
    assert.equal(store.deletion(task.id)!.actions[0]!.state, 'unknown');
    assert.deepEqual(state.executeCalls, ['tok-1', 'tok-1']);
    assert.deepEqual(state.deleteAttempts, ['tok-1', 'tok-1']);
    assert.ok(store.account(account.id));
    assert.deepEqual(store.history(), []);

    state.previewMode = 'absent';
    state.executeResults.push('absent');
    await deletions.retry(task.id);
    await waitFor(() => store.deletion(task.id)?.status === 'completed', '核验不存在后完成');
    assert.equal(store.deletion(task.id)!.actions[0]!.state, 'absent');
    assert.deepEqual(state.executeCalls, ['tok-1', 'tok-1', 'tok-1']);
    assert.deepEqual(state.deleteAttempts, ['tok-1', 'tok-1'], 'absent重试不得再次删除');
    assert.equal(state.previewCalls, 4, '初始预览加每次retry都重新preview核验');
    assert.equal(store.account(account.id), undefined);
    assert.equal(store.historicalAccount(account.id)!.id, account.id);

    await assert.rejects(deletions.retry(task.id), code('deletion_busy'));
  } finally {
    await deletions.close();
    await transport.close();
    store.close();
  }
});

test('取消运行中的动作会等本次返回，不继续后续、不恢复已删分项并保留停用与凭据', async () => {
  const store = new Store(':memory:', key());
  const registry = new ProviderRegistry();
  const transport = new Transport();
  const providers = new Providers(store, registry, transport);
  const deletions = new ProviderDeletions(store, providers, () => undefined);
  const account = accountOf('account-a', 'alpha');
  const resources = [resourceOf('tok-1'), resourceOf('tok-2'), resourceOf('tok-3')];
  const { plugin, state } = fakeCleanup('fake', resources);
  const gate = deferred<Outcome>();
  state.gates.set('tok-2', gate);
  registry.register(plugin);
  try {
    store.saveAccount(account, { apiKey: 'sensitive-upstream-key' });
    store.replaceCatalog(account, [modelOf('alpha', 'one')], NOW);
    for (const resource of resources) store.recordResource('fake', account.id, resource);
    const preview = await deletions.preview(account.id);
    const task = await deletions.start(account.id, selectionOf(preview.revision, 'alpha', {
      selectedActionIds: preview.actions.map(item => item.id),
    }));

    await waitFor(() => state.executeCalls.length === 2, '第二个动作执行中');
    const during = store.deletion(task.id)!;
    assert.equal(during.status, 'cleaning');
    assert.equal(during.actions[0]!.state, 'deleted');
    assert.equal(during.actions[1]!.state, 'running');
    assert.equal(during.actions[2]!.state, 'pending');
    assert.ok(store.account(account.id), '取消前不本地删除');

    const pending = deletions.cancel(task.id);
    assert.equal(pending.cancelRequested, true);
    assert.equal(pending.status, 'cleaning', '等待运行中的动作返回');
    assert.equal(store.secrets(account.id).apiKey, 'sensitive-upstream-key');

    gate.resolve('deleted');
    await waitFor(() => store.deletion(task.id)?.status === 'cancelled', '取消完成');
    const cancelled = store.deletion(task.id)!;
    assert.deepEqual(state.executeCalls, ['tok-1', 'tok-2'], '不继续后续动作');
    assert.deepEqual(cancelled.actions.map(item => item.state), ['deleted', 'deleted', 'pending']);
    assert.equal(cancelled.cancelRequested, true);
    assert.ok(store.account(account.id), '取消保留停用供应商');
    assert.equal(store.account(account.id)!.enabled, false);
    assert.equal(store.account(account.id)!.deletionTaskId, undefined);
    assert.equal(store.secrets(account.id).apiKey, 'sensitive-upstream-key');
    assert.deepEqual(store.models().map(item => item.id), ['alpha/one']);
    assert.deepEqual(store.history(), []);
    assert.equal(store.deleting(account.id), false);
  } finally {
    gate.resolve('deleted');
    await deletions.close();
    await transport.close();
    store.close();
  }
});

test('协调器关闭后任务暂停，重启不自动重发上游删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moris-deletion-coordinator-'));
  const path = join(dir, 'test.sqlite');
  const k = key();
  const registry = new ProviderRegistry();
  const transport = new Transport();
  let store = new Store(path, k);
  let providers = new Providers(store, registry, transport);
  let deletions = new ProviderDeletions(store, providers, () => undefined);
  const account = accountOf('account-a', 'alpha');
  const resource = resourceOf('tok-1');
  const { plugin, state } = fakeCleanup('fake', [resource]);
  registry.register(plugin);
  try {
    store.saveAccount(account, { apiKey: 'sensitive-upstream-key' });
    store.replaceCatalog(account, [modelOf('alpha', 'one')], NOW);
    store.recordResource('fake', account.id, resource);
    const preview = await deletions.preview(account.id);
    const release = providers.acquire(account.id);
    const task = await deletions.start(account.id, selectionOf(preview.revision, 'alpha', {
      selectedActionIds: [preview.actions[0]!.id], acknowledgeUnsettled: true,
    }));
    await flush();
    assert.equal(store.deletion(task.id)!.status, 'draining');

    await deletions.close();
    release();
    assert.equal(store.deletion(task.id)!.status, 'paused');
    assert.deepEqual(state.executeCalls, []);

    await providers.close();
    store.close();

    // 模拟网关重启：同一文件库、新的协调器实例。
    store = new Store(path, k);
    providers = new Providers(store, registry, transport);
    deletions = new ProviderDeletions(store, providers, () => undefined);
    assert.equal(store.deletion(task.id)!.status, 'paused');
    await sleep(30);
    assert.deepEqual(state.executeCalls, [], '重启不自动重发上游删除');
    assert.ok(store.account(account.id));
    assert.equal(store.account(account.id)!.enabled, false);
    assert.equal(store.deletion(task.id)!.actions[0]!.state, 'pending');
  } finally {
    await deletions.close();
    await providers.close();
    await transport.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('重复start/retry受保护，并发启动只有一个成功', async () => {
  const store = new Store(':memory:', key());
  const registry = new ProviderRegistry();
  const transport = new Transport();
  const providers = new Providers(store, registry, transport);
  const deletions = new ProviderDeletions(store, providers, () => undefined);
  const a = accountOf('account-a', 'alpha', 'fake-a');
  const b = accountOf('account-b', 'beta', 'fake-b');
  const resourceA = resourceOf('tok-a');
  const resourceB = resourceOf('tok-b');
  const fakeA = fakeCleanup('fake-a', [resourceA]);
  const fakeB = fakeCleanup('fake-b', [resourceB]);
  registry.register(fakeA.plugin);
  registry.register(fakeB.plugin);
  try {
    store.saveAccount(a);
    store.saveAccount(b);
    store.recordResource('fake-a', a.id, resourceA);
    store.recordResource('fake-b', b.id, resourceB);

    const previewA = await deletions.preview(a.id);
    const selectA = selectionOf(previewA.revision, 'alpha', { selectedActionIds: [previewA.actions[0]!.id] });
    // 用租约让任务停留在draining，避免与全局resourceLock互相等待。
    const release = providers.acquire(a.id);
    try {
      const taskA = await deletions.start(a.id, { ...selectA, acknowledgeUnsettled: true });
      await flush();
      assert.equal(store.deletion(taskA.id)!.status, 'draining');
      await assert.rejects(deletions.start(a.id, { ...selectA, acknowledgeUnsettled: true }), code('deletion_busy'));
      await assert.rejects(deletions.preview(a.id), /正在删除或已不存在/);
      await assert.rejects(deletions.retry(taskA.id), code('deletion_busy'));
      release();
      await waitFor(() => store.deletion(taskA.id)?.status === 'completed', '首个任务完成');
      assert.deepEqual(fakeA.state.executeCalls, ['tok-a']);
      await assert.rejects(deletions.retry(taskA.id), code('deletion_busy'));
      await assert.rejects(deletions.retry('missing-task'), code('not_found'));
    } finally {
      release();
    }

    const previewB = await deletions.preview(b.id);
    const selectB = selectionOf(previewB.revision, 'beta', { selectedActionIds: [previewB.actions[0]!.id] });
    const results = await Promise.allSettled([deletions.start(b.id, selectB), deletions.start(b.id, selectB)]);
    assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
    const rejected = results.find(item => item.status === 'rejected');
    assert.ok(rejected && rejected.status === 'rejected' && rejected.reason.code === 'deletion_busy');
    const taskB = store.deletions().find(item => item.accountId === b.id)!;
    await waitFor(() => store.deletion(taskB.id)?.status === 'completed', '并发启动的唯一任务完成');
    assert.deepEqual(fakeB.state.executeCalls, ['tok-b']);
    assert.equal(store.account(b.id), undefined);
  } finally {
    await deletions.close();
    await transport.close();
    store.close();
  }
});
