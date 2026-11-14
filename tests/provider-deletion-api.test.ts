import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../apps/gateway/src/server.js';
import { Store, type AttemptRecord, type StoredDeletion } from '../apps/gateway/src/store.js';
import { ProviderRegistry } from '../apps/gateway/src/providers.js';
import type { ProviderPlugin } from '../packages/provider-sdk/src/index.js';
import type { DeletionPreview, ManagedResourceInput, ProviderAccount, ProviderModel } from '../packages/contracts/src/index.js';

const key = () => randomBytes(32).toString('base64');
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, message: string, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${message}`);
    await sleep(5);
  }
}

async function waitUntil(predicate: () => Promise<boolean>, message: string, timeout = 4000): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeout) throw new Error(`等待超时: ${message}`);
    await sleep(5);
  }
}

function accountOf(id: string, namespace: string, plugin = 'fake'): ProviderAccount {
  return {
    id, namespace, name: `供应商-${namespace}`, plugin, baseUrl: 'https://upstream.test', billingType: 'metered',
    enabled: true, proxyId: null, autoCreateTokens: false, options: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
}

function modelOf(namespace: string): ProviderModel {
  return {
    path: 'g/m', upstreamModel: 'm', name: 'M', family: 'test', protocol: 'chat-completions',
    capabilities: { tools: true, input: ['text'], output: ['text'] }, limit: { context: 10000, output: 1000 },
    variants: {}, price: { kind: 'token', currency: 'USD', input: 1, output: 2 },
  };
}

function resourceFor(account: ProviderAccount): ManagedResourceInput {
  return {
    kind: 'token', scope: `fake:${account.baseUrl}:${account.namespace}`, externalId: `tok-${account.id}`,
    name: `moris-${account.namespace}`, group: 'default', fingerprint: 'fingerprint-1',
    provenance: 'created', credentialKey: 'token:default',
  };
}

type Outcome = 'deleted' | 'absent' | 'failed' | 'unknown';

interface Gates {
  prepare?: ReturnType<typeof deferred<void>>;
  discover?: ReturnType<typeof deferred<void>>;
  monitor?: ReturnType<typeof deferred<void>>;
  reconcile?: ReturnType<typeof deferred<void>>;
  oauthStart?: ReturnType<typeof deferred<void>>;
  oauthStatus?: ReturnType<typeof deferred<void>>;
  execute?: ReturnType<typeof deferred<Outcome>>;
}

interface ApiFakeState {
  previewMode: 'normal' | 'absent' | 'throw';
  executeResults: Outcome[];
  previewCalls: number;
  executeCalls: string[];
  deleteAttempts: string[];
  prepareCalls: number;
  discoverCalls: number;
  monitorCalls: number;
  reconcileCalls: number;
  oauthStartCalls: number;
  oauthStatusCalls: number;
  gates: Gates;
}

function apiPlugin(id = 'fake') {
  const state: ApiFakeState = {
    previewMode: 'normal', executeResults: [], previewCalls: 0, executeCalls: [], deleteAttempts: [],
    prepareCalls: 0, discoverCalls: 0, monitorCalls: 0, reconcileCalls: 0, oauthStartCalls: 0, oauthStatusCalls: 0, gates: {},
  };
  const plugin: ProviderPlugin = {
    id, name: id,
    cleanup: {
      preview: async context => {
        state.previewCalls += 1;
        if (state.previewMode === 'throw') throw new Error('模拟上游清单读取失败');
        const resource = resourceFor(context.account);
        if (state.previewMode === 'absent') return [{ resource, verified: false, absent: true }];
        return [{ resource, verified: true }];
      },
      execute: async (_context, resource) => {
        state.executeCalls.push(resource.externalId);
        const outcome: Outcome = state.gates.execute ? await state.gates.execute.promise : (state.executeResults.shift() ?? 'deleted');
        if (outcome !== 'absent') state.deleteAttempts.push(resource.externalId);
        return { state: outcome };
      },
    },
    discover: async context => {
      state.discoverCalls += 1;
      if (state.gates.discover) await state.gates.discover.promise;
      return { complete: true, models: [modelOf(context.account.namespace)] };
    },
    monitor: async () => {
      state.monitorCalls += 1;
      if (state.gates.monitor) await state.gates.monitor.promise;
      return { state: 'ok', balances: [], windows: [], sampledAt: new Date().toISOString() };
    },
    reconcile: async () => {
      state.reconcileCalls += 1;
      if (state.gates.reconcile) await state.gates.reconcile.promise;
      return [];
    },
    prepare: async () => {
      state.prepareCalls += 1;
      if (state.gates.prepare) await state.gates.prepare.promise;
      return { url: 'https://upstream.test/v1/chat/completions', headers: {}, body: {} };
    },
    authorization: {
      start: async () => {
        state.oauthStartCalls += 1;
        if (state.gates.oauthStart) await state.gates.oauthStart.promise;
        return {
          deviceAuthId: 'device-auth', userCode: 'ABCD', verificationUrl: 'https://upstream.test/device',
          intervalSeconds: 1, expiresAt: new Date(Date.now() + 300_000).toISOString(),
        };
      },
      poll: async () => ({ state: 'pending', intervalSeconds: 1, message: '等待授权' }),
      status: async () => {
        state.oauthStatusCalls += 1;
        if (state.gates.oauthStatus) await state.gates.oauthStatus.promise;
        return { authorized: false };
      },
    },
  };
  return { plugin, state };
}

const fakeFetch: typeof fetch = async input => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/v1/chat/completions')) return new Response('not found', { status: 404 });
  return new Response(JSON.stringify({
    id: 'upstream-1', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 2 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

async function harness(plugin: ProviderPlugin, fetcher: typeof fetch = fakeFetch) {
  const store = new Store(':memory:', key());
  store.initializeAdmin('admin', 'a-test-password-only');
  const registry = new ProviderRegistry(); registry.register(plugin);
  const app = await createApp({ store, registry, fetch: fetcher, secureCookie: false, background: false });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-test-password-only' } });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken as string };
  const device = store.createDevice('test');
  return { app, store, headers, deviceHeaders: { authorization: `Bearer ${device.key}` }, close: async () => { await app.close(); store.close(); } };
}

function seed(store: Store, account: ProviderAccount): ManagedResourceInput {
  store.saveAccount(account, { apiKey: 'sensitive-upstream-key' });
  store.replaceCatalog(account, [modelOf(account.namespace)], new Date().toISOString());
  const resource = resourceFor(account);
  store.recordResource(account.plugin, account.id, resource);
  return resource;
}

function selection(preview: DeletionPreview, overrides: Record<string, unknown> = {}) {
  return {
    revision: preview.revision,
    selectedActionIds: preview.actions.filter(action => action.defaultSelected).map(action => action.id),
    adoptActionIds: [], confirmNamespace: preview.account.namespace,
    acknowledgeUnsettled: false, acknowledgeUncleaned: false, ...overrides,
  };
}

function errorCode(body: string): string | undefined {
  try { return (JSON.parse(body) as { error?: { code?: string } }).error?.code; } catch { return undefined; }
}

async function taskItem(app: FastifyInstance, headers: Record<string, string>, id: string) {
  return (await app.inject({ url: `/api/admin/provider-deletions/${id}`, headers })).json().item;
}

async function waitTask(app: FastifyInstance, headers: Record<string, string>, id: string, status: string) {
  await waitUntil(async () => (await taskItem(app, headers, id)).status === status, `任务状态变为 ${status}`);
}

async function fastInject(app: FastifyInstance, options: Parameters<FastifyInstance['inject']>[0], label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}未立即返回`)), 2000); });
  const started = Date.now();
  try {
    const response = await Promise.race([app.inject(options), timeout]);
    assert.ok(Date.now() - started < 2000, `${label}不应等待上游清理结束`);
    return response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test('API完成预览、202确认、进度、历史，账单接受历史ID且复用命名空间需确认', async () => {
  const fake = apiPlugin();
  const f = await harness(fake.plugin);
  const account = accountOf('account-a', 'alpha');
  try {
    seed(f.store, account);

    const previewRes = await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview`, headers: f.headers });
    assert.equal(previewRes.statusCode, 200, previewRes.body);
    const preview = previewRes.json() as DeletionPreview;
    assert.equal(preview.account.id, account.id);
    assert.equal(preview.actions[0]!.disposition, 'ready');

    const start = await f.app.inject({
      method: 'POST', url: `/api/admin/providers/${account.id}/deletions`, headers: f.headers,
      payload: selection(preview),
    });
    assert.equal(start.statusCode, 202, start.body);
    const id = start.json().item.id as string;
    await waitTask(f.app, f.headers, id, 'completed');

    const progress = await taskItem(f.app, f.headers, id);
    assert.equal(progress.accountId, account.id);
    assert.equal(progress.actions[0]!.state, 'deleted');
    const list = await f.app.inject({ url: '/api/admin/provider-deletions', headers: f.headers });
    assert.ok(list.json().items.some((item: { id: string }) => item.id === id));
    const history = await f.app.inject({ url: '/api/admin/provider-history', headers: f.headers });
    assert.ok(history.json().items.some((item: { id: string }) => item.id === account.id));
    assert.equal(f.store.account(account.id), undefined);
    assert.deepEqual(fake.state.executeCalls, [`tok-${account.id}`]);

    // 历史身份可继续记账，但不能再预览或启动删除。
    const bill = await f.app.inject({
      method: 'POST', url: '/api/admin/bills', headers: f.headers,
      payload: { accountId: account.id, paidAt: '2026-11-14T12:00:00+08:00', amountCny: 66.5, note: '补录旧账号付款' },
    });
    assert.equal(bill.statusCode, 200, bill.body);
    assert.equal(f.store.bills()[0]!.accountId, account.id);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview`, headers: f.headers })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletions`, headers: f.headers, payload: selection(preview) })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/admin/provider-deletions/${id}/retry`, headers: f.headers, payload: {} })).statusCode, 409);

    // 复用历史命名空间必须显式确认。
    const body = {
      namespace: 'alpha', name: '新供应商', plugin: 'fake', baseUrl: 'https://upstream.test',
      billingType: 'metered', enabled: true, autoCreateTokens: false, options: {}, secrets: { apiKey: 'new' },
    };
    const refused = await f.app.inject({ method: 'POST', url: '/api/admin/providers', headers: f.headers, payload: body });
    assert.equal(refused.statusCode, 409, refused.body);
    assert.equal(errorCode(refused.body), 'namespace_reuse');
    const accepted = await f.app.inject({ method: 'POST', url: '/api/admin/providers', headers: f.headers, payload: { ...body, acknowledgeNamespaceReuse: true } });
    assert.equal(accepted.statusCode, 200, accepted.body);
    assert.notEqual(accepted.json().item.id, account.id);
    assert.equal(accepted.json().item.namespace, 'alpha');
  } finally {
    await f.close();
  }
});

test('API在途prepare（attempt未入库）期间任务draining并拒绝新同步/授权/启用，结束后自然清理', async () => {
  const fake = apiPlugin();
  fake.state.gates.prepare = deferred<void>();
  const f = await harness(fake.plugin);
  const account = accountOf('account-a', 'alpha');
  try {
    seed(f.store, account);
    const inference = f.app.inject({
      method: 'POST', url: '/v1/chat/completions', headers: f.deviceHeaders,
      payload: { model: `${account.namespace}/g/m`, messages: [{ role: 'user', content: 'hello' }] },
    });
    await waitFor(() => fake.state.prepareCalls === 1, 'prepare开始');
    assert.deepEqual(f.store.attempts(), [], 'prepare期间attempt尚未保存');
    assert.equal(f.store.requests()[0]!.status, 'running');

    const previewRes = await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview`, headers: f.headers });
    assert.equal(previewRes.statusCode, 200, previewRes.body);
    const preview = previewRes.json() as DeletionPreview;
    assert.equal(preview.unsettledAttempts, 1);
    const start = await f.app.inject({
      method: 'POST', url: `/api/admin/providers/${account.id}/deletions`, headers: f.headers,
      payload: selection(preview, { acknowledgeUnsettled: true }),
    });
    assert.equal(start.statusCode, 202, start.body);
    const id = start.json().item.id as string;
    await waitTask(f.app, f.headers, id, 'draining');
    assert.deepEqual(fake.state.executeCalls, [], '在途请求结束前不执行清理');

    for (const [method, url, payload] of [
      ['POST', `/api/admin/providers/${account.id}/sync`, undefined],
      ['POST', `/api/admin/providers/${account.id}/oauth/start`, undefined],
      ['PATCH', `/api/admin/providers/${account.id}`, { enabled: true }],
      ['PATCH', `/api/admin/providers/${account.id}`, { secrets: { apiKey: 'new' } }],
      ['PATCH', `/api/admin/models/${encodeURIComponent(`${account.namespace}/g/m`)}/parameters`, { overrides: {}, revision: null }],
    ] as const) {
      const response = await f.app.inject({ method, url, headers: f.headers, payload });
      assert.equal(response.statusCode, 409, `${method} ${url}: ${response.body}`);
      assert.equal(errorCode(response.body), 'deletion_busy');
    }

    fake.state.gates.prepare.resolve();
    const completed = await inference;
    assert.equal(completed.statusCode, 200, completed.body);
    await waitTask(f.app, f.headers, id, 'completed');
    assert.deepEqual(fake.state.executeCalls, [`tok-${account.id}`]);
    assert.ok(f.store.historicalAccount(account.id));
    assert.equal(f.store.deleting(account.id), false);
  } finally {
    fake.state.gates.prepare?.resolve();
    await f.close();
  }
});

test('API在途sync的discover/monitor/reconcile期间不提前清理，结束后才执行删除', async () => {
  const fake = apiPlugin();
  fake.state.gates.discover = deferred<void>();
  fake.state.gates.monitor = deferred<void>();
  fake.state.gates.reconcile = deferred<void>();
  const f = await harness(fake.plugin);
  const account = accountOf('account-a', 'alpha');
  try {
    seed(f.store, account);
    const at = new Date().toISOString();
    f.store.saveRequest({ id: 'request-1', modelId: `${account.namespace}/g/m`, deviceId: 'device', startedAt: at, finishedAt: at, status: 'succeeded' });
    const attempt: AttemptRecord = {
      id: 'attempt-1', requestId: 'request-1', accountId: account.id, modelId: `${account.namespace}/g/m`, number: 1,
      startedAt: at, finishedAt: at, status: 'succeeded', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      price: { kind: 'token', currency: 'USD', input: 1, output: 2 }, estimatedCost: null, settledCost: null,
      equivalentUsd: null, usdCny: null, estimatedCny: null, settledCny: null, billingType: 'metered',
    };
    f.store.saveAttempt(attempt);

    const previewRes = await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview`, headers: f.headers });
    const preview = previewRes.json() as DeletionPreview;
    assert.equal(preview.unsettledAttempts, 1);

    const sync = f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/sync`, headers: f.headers });
    await waitFor(() => fake.state.discoverCalls === 1, 'discover开始');
    const start = f.app.inject({
      method: 'POST', url: `/api/admin/providers/${account.id}/deletions`, headers: f.headers,
      payload: selection(preview, { acknowledgeUnsettled: true }),
    });
    await flush();
    assert.equal(f.store.deletions().length, 0, 'sync占用资源锁时删除任务尚未创建');
    assert.deepEqual(fake.state.executeCalls, []);

    fake.state.gates.discover!.resolve();
    await waitFor(() => fake.state.monitorCalls === 1, 'monitor开始');
    assert.equal(f.store.deletions().length, 0);
    assert.deepEqual(fake.state.executeCalls, []);

    fake.state.gates.monitor!.resolve();
    await waitFor(() => fake.state.reconcileCalls === 1, 'reconcile开始');
    assert.equal(f.store.deletions().length, 0);
    assert.deepEqual(fake.state.executeCalls, []);

    fake.state.gates.reconcile!.resolve();
    const synced = await sync;
    assert.equal(synced.statusCode, 200, synced.body);
    const started = await start;
    assert.equal(started.statusCode, 202, started.body);
    const id = started.json().item.id as string;
    await waitTask(f.app, f.headers, id, 'completed');
    assert.deepEqual(fake.state.executeCalls, [`tok-${account.id}`]);
    assert.equal(f.store.account(account.id), undefined);
    assert.ok(f.store.historicalAccount(account.id));
  } finally {
    for (const gate of [fake.state.gates.discover, fake.state.gates.monitor, fake.state.gates.reconcile]) gate?.resolve();
    await f.close();
  }
});

test('API在途oauth start/status期间draining等待，结束后才清理且不保存授权', async () => {
  const fake = apiPlugin();
  fake.state.gates.oauthStart = deferred<void>();
  fake.state.gates.oauthStatus = deferred<void>();
  const f = await harness(fake.plugin);
  const a = accountOf('account-a', 'alpha');
  const b = accountOf('account-b', 'beta');
  try {
    seed(f.store, a);
    seed(f.store, b);

    const previewA = (await f.app.inject({ method: 'POST', url: `/api/admin/providers/${a.id}/deletion-preview`, headers: f.headers })).json() as DeletionPreview;
    const oauthStart = f.app.inject({ method: 'POST', url: `/api/admin/providers/${a.id}/oauth/start`, headers: f.headers });
    await waitFor(() => fake.state.oauthStartCalls === 1, 'oauth start开始');
    const startA = await f.app.inject({
      method: 'POST', url: `/api/admin/providers/${a.id}/deletions`, headers: f.headers,
      payload: selection(previewA, { acknowledgeUnsettled: true }),
    });
    assert.equal(startA.statusCode, 202, startA.body);
    const idA = startA.json().item.id as string;
    await waitTask(f.app, f.headers, idA, 'draining');
    assert.deepEqual(fake.state.executeCalls, []);
    for (const url of [`/api/admin/providers/${a.id}/oauth/start`, `/api/admin/providers/${a.id}/authorization`]) {
      const response = await f.app.inject({ method: url.endsWith('/authorization') ? 'GET' : 'POST', url, headers: f.headers, ...(url.endsWith('/authorization') ? {} : { payload: {} }) });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(errorCode(response.body), 'deletion_busy');
    }
    fake.state.gates.oauthStart!.resolve();
    const auth = await oauthStart;
    assert.equal(auth.statusCode, 200, auth.body);
    await waitTask(f.app, f.headers, idA, 'completed');
    assert.deepEqual(fake.state.executeCalls, [`tok-${a.id}`]);
    const poll = await f.app.inject({ method: 'POST', url: `/api/admin/providers/${a.id}/oauth/poll`, headers: f.headers, payload: {} });
    assert.equal(poll.statusCode, 404);

    const previewB = (await f.app.inject({ method: 'POST', url: `/api/admin/providers/${b.id}/deletion-preview`, headers: f.headers })).json() as DeletionPreview;
    const status = f.app.inject({ url: `/api/admin/providers/${b.id}/authorization`, headers: f.headers });
    await waitFor(() => fake.state.oauthStatusCalls === 1, 'authorization status开始');
    const startB = await f.app.inject({
      method: 'POST', url: `/api/admin/providers/${b.id}/deletions`, headers: f.headers,
      payload: selection(previewB, { acknowledgeUnsettled: true }),
    });
    assert.equal(startB.statusCode, 202, startB.body);
    const idB = startB.json().item.id as string;
    await waitTask(f.app, f.headers, idB, 'draining');
    assert.deepEqual(fake.state.executeCalls, [`tok-${a.id}`]);
    fake.state.gates.oauthStatus!.resolve();
    const checked = await status;
    assert.equal(checked.statusCode, 200, checked.body);
    await waitTask(f.app, f.headers, idB, 'completed');
    assert.deepEqual(fake.state.executeCalls, [`tok-${a.id}`, `tok-${b.id}`]);
  } finally {
    fake.state.gates.oauthStart?.resolve();
    fake.state.gates.oauthStatus?.resolve();
    await f.close();
  }
});

test('API删除中PATCH只允许failed/paused修复凭据与代理，其他配置、参数、同步和授权均409', async () => {
  const fake = apiPlugin();
  fake.state.gates.prepare = deferred<void>();
  fake.state.gates.execute = deferred<Outcome>();
  const f = await harness(fake.plugin);
  const account = accountOf('account-a', 'alpha');
  account.autoCreateTokens = true;
  account.options = { quotaPool: 'pool-1', note: 'keep' };
  try {
    seed(f.store, account);
    const inference = f.app.inject({
      method: 'POST', url: '/v1/chat/completions', headers: f.deviceHeaders,
      payload: { model: `${account.namespace}/g/m`, messages: [{ role: 'user', content: 'hello' }] },
    });
    await waitFor(() => fake.state.prepareCalls === 1, 'prepare开始');
    const preview = (await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview`, headers: f.headers })).json() as DeletionPreview;
    const start = await f.app.inject({
      method: 'POST', url: `/api/admin/providers/${account.id}/deletions`, headers: f.headers,
      payload: selection(preview, { acknowledgeUnsettled: true }),
    });
    assert.equal(start.statusCode, 202, start.body);
    const id = start.json().item.id as string;
    await waitTask(f.app, f.headers, id, 'draining');

    for (const payload of [{ secrets: { apiKey: 'new' } }, { proxyUrl: 'http://127.0.0.1:8080' }, { enabled: false }, { name: '改名' }]) {
      const response = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload });
      assert.equal(response.statusCode, 409, `${JSON.stringify(payload)}: ${response.body}`);
      assert.equal(errorCode(response.body), 'deletion_busy');
    }
    for (const [url, payload] of [
      [`/api/admin/providers/${account.id}/sync`, undefined],
      [`/api/admin/providers/${account.id}/oauth/start`, {}],
    ] as const) {
      const response = await f.app.inject({ method: 'POST', url, headers: f.headers, payload });
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(errorCode(response.body), 'deletion_busy');
    }
    const parameters = await f.app.inject({
      method: 'PATCH', url: `/api/admin/models/${encodeURIComponent(`${account.namespace}/g/m`)}/parameters`,
      headers: f.headers, payload: { overrides: {}, revision: null },
    });
    assert.equal(parameters.statusCode, 409, parameters.body);
    assert.equal(errorCode(parameters.body), 'deletion_busy');

    fake.state.gates.prepare!.resolve();
    assert.equal((await inference).statusCode, 200);
    await waitFor(() => fake.state.executeCalls.length === 1, '清理动作执行中');
    await waitTask(f.app, f.headers, id, 'cleaning');
    fake.state.gates.execute!.resolve('failed');
    await waitTask(f.app, f.headers, id, 'failed');
    await sleep(30);

    const locked = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { name: '改名' } });
    assert.equal(locked.statusCode, 409, locked.body);
    assert.equal(errorCode(locked.body), 'deletion_locked');
    const lockedEnabled = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { enabled: true } });
    assert.equal(lockedEnabled.statusCode, 409);
    assert.equal(errorCode(lockedEnabled.body), 'deletion_locked');

    // failed后仅修复secrets/proxy：不隐式启用，也不覆盖options/autoCreateTokens。
    const repair = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { secrets: { apiKey: 'repaired-key' } } });
    assert.equal(repair.statusCode, 200, repair.body);
    assert.equal(f.store.secrets(account.id).apiKey, 'repaired-key');
    let stored = f.store.account(account.id)!;
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.options, { quotaPool: 'pool-1', note: 'keep' });
    assert.equal(stored.autoCreateTokens, true);

    const profile = { id: randomUUID(), name: '修复代理', protocol: 'http' as const, host: '127.0.0.1', port: 8081, username: '', hasPassword: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    f.store.saveProxy(profile, '');
    const bound = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { proxyId: profile.id } });
    assert.equal(bound.statusCode, 200, bound.body);
    stored = f.store.account(account.id)!;
    assert.equal(stored.proxyId, profile.id);
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.options, { quotaPool: 'pool-1', note: 'keep' });
    assert.equal(stored.autoCreateTokens, true);
    const inline = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { proxyUrl: 'http://127.0.0.1:8082' } });
    assert.equal(inline.statusCode, 200, inline.body);
    stored = f.store.account(account.id)!;
    assert.equal(stored.proxyUrl, 'http://127.0.0.1:8082/');
    assert.equal(stored.proxyId, undefined);
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.options, { quotaPool: 'pool-1', note: 'keep' });
    assert.equal(stored.autoCreateTokens, true);

    const cancel = await f.app.inject({ method: 'POST', url: `/api/admin/provider-deletions/${id}/cancel`, headers: f.headers, payload: {} });
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(cancel.json().item.status, 'cancelled');
    assert.ok(f.store.account(account.id), '取消保留停用供应商');
    assert.equal(f.store.account(account.id)!.enabled, false);
    assert.equal(f.store.secrets(account.id).apiKey, 'repaired-key');
    assert.equal(f.store.deleting(account.id), false);

    // 普通已停用账号（无删除任务）编辑name或secrets也不启用、不覆盖原配置。
    const renamed = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { name: '取消后改名' } });
    assert.equal(renamed.statusCode, 200, renamed.body);
    stored = f.store.account(account.id)!;
    assert.equal(stored.name, '取消后改名');
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.options, { quotaPool: 'pool-1', note: 'keep' });
    assert.equal(stored.autoCreateTokens, true);
    const rotated = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { secrets: { apiKey: 'rotated-again' } } });
    assert.equal(rotated.statusCode, 200, rotated.body);
    stored = f.store.account(account.id)!;
    assert.equal(f.store.secrets(account.id).apiKey, 'rotated-again');
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.options, { quotaPool: 'pool-1', note: 'keep' });
    assert.equal(stored.autoCreateTokens, true);
  } finally {
    fake.state.gates.prepare?.resolve();
    fake.state.gates.execute?.resolve('failed');
    await f.close();
  }
});

test('API手动retry重新核验absent，不盲目DELETE；完成后再retry返回409', async () => {
  const fake = apiPlugin();
  fake.state.executeResults = ['failed', 'unknown'];
  const f = await harness(fake.plugin);
  const account = accountOf('account-a', 'alpha');
  try {
    seed(f.store, account);
    const preview = (await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview`, headers: f.headers })).json() as DeletionPreview;
    const start = await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletions`, headers: f.headers, payload: selection(preview) });
    const id = start.json().item.id as string;
    await waitTask(f.app, f.headers, id, 'failed');
    assert.equal(f.store.account(account.id)!.enabled, false);
    assert.equal(f.store.secrets(account.id).apiKey, 'sensitive-upstream-key');

    const retry = await f.app.inject({ method: 'POST', url: `/api/admin/provider-deletions/${id}/retry`, headers: f.headers, payload: {} });
    assert.equal(retry.statusCode, 200, retry.body);
    await waitUntil(async () => fake.state.executeCalls.length === 2 && (await taskItem(f.app, f.headers, id)).status === 'failed', '第二次失败');
    assert.equal((await taskItem(f.app, f.headers, id)).actions[0]!.state, 'unknown');
    assert.ok(f.store.account(account.id));

    fake.state.previewMode = 'absent';
    fake.state.executeResults.push('absent');
    const retryAbsent = await f.app.inject({ method: 'POST', url: `/api/admin/provider-deletions/${id}/retry`, headers: f.headers, payload: {} });
    assert.equal(retryAbsent.statusCode, 200, retryAbsent.body);
    await waitTask(f.app, f.headers, id, 'completed');
    assert.equal((await taskItem(f.app, f.headers, id)).actions[0]!.state, 'absent');
    assert.deepEqual(fake.state.executeCalls, [`tok-${account.id}`, `tok-${account.id}`, `tok-${account.id}`]);
    assert.deepEqual(fake.state.deleteAttempts, [`tok-${account.id}`, `tok-${account.id}`], 'absent重试不得再次DELETE');
    assert.equal(f.store.account(account.id), undefined);
    const retryAgain = await f.app.inject({ method: 'POST', url: `/api/admin/provider-deletions/${id}/retry`, headers: f.headers, payload: {} });
    assert.equal(retryAgain.statusCode, 409, retryAgain.body);
    assert.equal(errorCode(retryAgain.body), 'deletion_busy');
  } finally {
    await f.close();
  }
});

test('账本写入异常后lease不泄漏，删除仍能排空并完成', async () => {
  const fake = apiPlugin();
  const f = await harness(fake.plugin);
  const account = accountOf('account-a', 'alpha');
  const original = f.store.saveAttempt.bind(f.store);
  try {
    seed(f.store, account);
    f.store.saveAttempt = () => { throw new Error('ledger unavailable'); };
    const failed = await f.app.inject({
      method: 'POST', url: '/v1/chat/completions', headers: f.deviceHeaders,
      payload: { model: `${account.namespace}/g/m`, messages: [{ role: 'user', content: 'hello' }] },
    });
    assert.ok(failed.statusCode >= 500, failed.body);
    assert.deepEqual(f.store.attempts(), []);
    f.store.saveAttempt = original;

    const preview = (await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview`, headers: f.headers })).json() as DeletionPreview;
    assert.equal(preview.unsettledAttempts, 0, '租约已释放且没有未结算attempt');
    const start = await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletions`, headers: f.headers, payload: selection(preview) });
    assert.equal(start.statusCode, 202, start.body);
    const id = start.json().item.id as string;
    await waitTask(f.app, f.headers, id, 'completed');
    assert.deepEqual(fake.state.executeCalls, [`tok-${account.id}`]);
    assert.ok(f.store.historicalAccount(account.id));
  } finally {
    f.store.saveAttempt = original;
    await f.close();
  }
});

test('API paused删除任务仅允许修复secrets/proxyId，且不启用或改写其他配置', async () => {
  const fake = apiPlugin();
  const f = await harness(fake.plugin);
  const account = accountOf('account-a', 'alpha');
  account.autoCreateTokens = true;
  account.options = { quotaPool: 'pool-paused' };
  try {
    seed(f.store, account);
    const task: StoredDeletion = {
      id: 'paused-task', accountId: account.id, name: account.name, namespace: account.namespace,
      status: 'paused', actions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), resources: {},
    };
    f.store.saveDeletion(task);
    f.store.saveAccount({ ...account, enabled: false, deletionTaskId: task.id });

    const locked = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { name: '改名' } });
    assert.equal(locked.statusCode, 409, locked.body);
    assert.equal(errorCode(locked.body), 'deletion_locked');
    assert.equal((await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { enabled: true } })).statusCode, 409);

    const secrets = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { secrets: { apiKey: 'paused-repair' } } });
    assert.equal(secrets.statusCode, 200, secrets.body);
    let stored = f.store.account(account.id)!;
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.options, { quotaPool: 'pool-paused' });
    assert.equal(stored.autoCreateTokens, true);
    assert.equal(f.store.secrets(account.id).apiKey, 'paused-repair');

    const profile = { id: randomUUID(), name: '暂停修复代理', protocol: 'http' as const, host: '127.0.0.1', port: 8083, username: '', hasPassword: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    f.store.saveProxy(profile, '');
    const bound = await f.app.inject({ method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { proxyId: profile.id } });
    assert.equal(bound.statusCode, 200, bound.body);
    stored = f.store.account(account.id)!;
    assert.equal(stored.proxyId, profile.id);
    assert.equal(stored.enabled, false);
    assert.deepEqual(stored.options, { quotaPool: 'pool-paused' });
    assert.equal(stored.autoCreateTokens, true);
    assert.equal(f.store.deleting(account.id), true);
  } finally {
    await f.close();
  }
});

test('cleaning期间PATCH供应商与被引用代理立即409，不等待上游清理结束', async () => {
  const fake = apiPlugin();
  fake.state.gates.execute = deferred<Outcome>();
  const f = await harness(fake.plugin);
  const account = accountOf('account-a', 'alpha');
  const profile = { id: 'proxy-cleaning', name: '清理期间代理', protocol: 'http' as const, host: '127.0.0.1', port: 8084, username: '', hasPassword: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  account.proxyId = profile.id;
  try {
    f.store.saveProxy(profile, '');
    seed(f.store, account);
    const preview = (await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview`, headers: f.headers })).json() as DeletionPreview;
    const start = await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletions`, headers: f.headers, payload: selection(preview) });
    assert.equal(start.statusCode, 202, start.body);
    const id = start.json().item.id as string;
    await waitFor(() => fake.state.executeCalls.length === 1, '清理动作执行中');
    await waitTask(f.app, f.headers, id, 'cleaning');

    const providerPatch = await fastInject(f.app, {
      method: 'PATCH', url: `/api/admin/providers/${account.id}`, headers: f.headers, payload: { secrets: { apiKey: 'during-clean' } },
    }, '供应商PATCH');
    assert.equal(providerPatch.statusCode, 409, providerPatch.body);
    assert.equal(errorCode(providerPatch.body), 'deletion_busy');

    const proxyPatch = await fastInject(f.app, {
      method: 'PATCH', url: `/api/admin/proxies/${profile.id}`, headers: f.headers,
      payload: { name: '改名代理', protocol: 'http', host: '127.0.0.1', port: 8084, username: '', passwordAction: 'keep' },
    }, '代理PATCH');
    assert.equal(proxyPatch.statusCode, 409, proxyPatch.body);
    assert.equal(errorCode(proxyPatch.body), 'deletion_busy');
    assert.equal(f.store.account(account.id)!.deletionTaskId, id, '预检拒绝不应结束清理任务');

    fake.state.gates.execute!.resolve('deleted');
    await waitTask(f.app, f.headers, id, 'completed');
    assert.equal(f.store.account(account.id), undefined);
    assert.deepEqual(fake.state.executeCalls, [`tok-${account.id}`]);
  } finally {
    fake.state.gates.execute?.resolve('deleted');
    await f.close();
  }
});

test('删除相关管理写接口要求CSRF，未登录返回401', async () => {
  const fake = apiPlugin();
  const f = await harness(fake.plugin);
  const account = accountOf('account-a', 'alpha');
  try {
    seed(f.store, account);
    const noLogin = await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview` });
    assert.equal(noLogin.statusCode, 401);
    const noCsrf = await f.app.inject({ method: 'POST', url: `/api/admin/providers/${account.id}/deletion-preview`, headers: { cookie: f.headers.cookie } });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(errorCode(noCsrf.body), 'csrf');
    assert.equal((await f.app.inject({ url: '/api/admin/provider-deletions', headers: f.headers })).statusCode, 200);
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/admin/provider-deletions/missing/retry', headers: f.headers, payload: {} })).statusCode, 404);
  } finally {
    await f.close();
  }
});
