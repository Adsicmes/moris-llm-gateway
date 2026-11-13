import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store, type AttemptRecord } from '../apps/gateway/src/store.js';
import { Vault } from '../apps/gateway/src/security.js';
import { estimateCost, estimateWindow, settle, sumMoney } from '../apps/gateway/src/billing.js';
import { ProviderRegistry, Providers } from '../apps/gateway/src/providers.js';
import { Transport } from '../apps/gateway/src/network.js';
import { SseDecoder, inspectEvent, readUsage } from '../apps/gateway/src/protocol.js';
import type { ProviderAccount, ProviderModel } from '../packages/contracts/src/index.js';

const key = () => randomBytes(32).toString('base64');
const account: ProviderAccount = { id: 'account', namespace: 'test', name: '测试', plugin: 'test', baseUrl: 'https://example.test', billingType: 'metered', enabled: true, autoCreateTokens: false, options: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
const model: ProviderModel = { path: 'group/model', upstreamModel: 'model', name: 'Model', family: 'test', protocol: 'chat-completions', capabilities: { tools: true, input: ['text', 'image'], output: ['text'] }, limit: { context: 128000, output: 8192 }, variants: {}, price: { kind: 'token', currency: 'USD', input: 1, output: 2 } };

test('秘密使用认证加密，错误主密钥不能解密；设备撤销立即生效', () => {
  const k = key(); const store = new Store(':memory:', k);
  try {
    store.saveAccount(account, { apiKey: 'sensitive-upstream-key' });
    const row = store.db.prepare('SELECT secrets FROM accounts').get()!;
    assert.ok(!String(row.secrets).includes('sensitive'));
    assert.equal(store.secrets(account.id).apiKey, 'sensitive-upstream-key');
    assert.throws(() => new Vault(key()).open(String(row.secrets)));
    const device = store.createDevice('电脑'); assert.ok(store.deviceForKey(device.key));
    assert.equal(store.devices()[0]?.name, '电脑');
    store.revokeDevice(device.item.id); assert.equal(store.deviceForKey(device.key), undefined);
  } finally { store.close(); }
});
test('完整目录删除停用旧路径，失败不清目录且TTL不因读取延长', async () => {
  const store = new Store(':memory:', key()); const transport = new Transport();
  try {
    store.saveAccount(account); const at = new Date(Date.now() - 23 * 3600000).toISOString();
    store.replaceCatalog(account, [model], at);
    const registry = new ProviderRegistry(); registry.register({ id: 'test', name: 'test', discover: async () => { throw new Error('network'); }, prepare: async () => { throw new Error(); } });
    const providers = new Providers(store, registry, transport);
    await providers.sync(account.id);
    assert.equal(providers.catalog().models.length, 1); assert.equal(providers.catalog().models[0]?.syncedAt, at);
    assert.equal(providers.callable(store.model('test/group/model')!, Date.parse(at) + 86400000), false);
    assert.throws(() => store.replaceCatalog(account, [model, model], new Date().toISOString()));
    assert.equal(store.models()[0]?.enabled, true);
    store.replaceCatalog(account, [], new Date().toISOString()); assert.equal(store.models()[0]?.enabled, false);
  } finally { await transport.close(); store.close(); }
});
test('缓存单独计价，复杂和未知价格不能估成零', () => {
  assert.equal(estimateCost({ kind: 'complex', currency: 'USD', expression: 'x' }, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), null);
  assert.equal(estimateCost({ kind: 'token', currency: 'USD', input: 2, output: 4 }, { input: 100, output: 10, cacheRead: 90, cacheWrite: 0 }), null);
  assert.deepEqual(estimateCost({ kind: 'token', currency: 'USD', input: 2, output: 4, cacheRead: 0.2 }, { input: 100, output: 10, cacheRead: 90, cacheWrite: 0 }), { amount: 0.000078, currency: 'USD' });
});
test('对账按唯一请求关联，真实与估算不重复累计，历史汇率不变', () => {
  const store = new Store(':memory:', key());
  try {
    store.saveRequest({ id: 'r', modelId: 'm', deviceId: 'd', startedAt: new Date().toISOString(), finishedAt: null, status: 'running' });
    const attempt: AttemptRecord = { id: 'a', requestId: 'r', accountId: 's', modelId: 'm', number: 1, startedAt: new Date().toISOString(), finishedAt: null, status: 'failed', usage: null, price: { kind: 'unknown', currency: 'USD' }, estimatedCost: { amount: 1, currency: 'USD' }, estimatedCny: 7, settledCost: null, settledCny: null, equivalentUsd: null, usdCny: 7, billingType: 'metered', upstreamRequestId: 'up' };
    store.saveAttempt(attempt); store.saveSettings({ ...store.settings(), usdCny: 8 });
    assert.equal(settle(store, 's', 'up', { amount: 0.8, currency: 'USD' }, 'supplier'), true);
    assert.equal(store.attempts()[0]?.settledCny, 5.6000000000000005);
    assert.deepEqual(sumMoney(store.attempts(), 'estimatedCost'), []);
    assert.deepEqual(sumMoney(store.attempts(), 'settledCost'), [{ amount: 0.8, currency: 'USD' }]);
    assert.equal(settle(store, 'other', 'up', { amount: 99, currency: 'USD' }, 'supplier'), false);
  } finally { store.close(); }
});
test('当前窗口必须覆盖完整记录，未知attempt会使估算不可用', () => {
  const store = new Store(':memory:', key());
  try {
    const now = new Date(); const startsAt = new Date(now.getTime() - 3600000).toISOString();
    const window = { id: 'w', pool: 'default', name: '5小时', startsAt, resetsAt: new Date(now.getTime() + 3600000).toISOString(), usedRatio: 0.2, sampledAt: now.toISOString() };
    store.setMeta('recordingSince:s', now.toISOString());
    assert.match(estimateWindow(store, 's', window, now).reason!, /起点/);
    store.setMeta('recordingSince:s', startsAt);
    store.saveRequest({ id: 'r', modelId: 'm', deviceId: 'd', startedAt: startsAt, finishedAt: startsAt, status: 'succeeded' });
    const a: AttemptRecord = { id: 'a', requestId: 'r', accountId: 's', modelId: 'm', number: 1, startedAt: startsAt, finishedAt: startsAt, status: 'succeeded', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, price: { kind: 'token', currency: 'USD' }, estimatedCost: null, settledCost: null, equivalentUsd: 40, usdCny: null, estimatedCny: null, settledCny: null, billingType: 'subscription', pool: 'default' };
    store.saveAttempt(a);
    assert.equal(estimateWindow(store, 's', window, now).totalUsd, 200);
    store.saveAttempt({ ...a, usage: null }); assert.equal(estimateWindow(store, 's', window, now).state, 'unavailable');
    assert.equal(estimateWindow(store, 's', { ...window, usedRatio: 0 }, now).state, 'unavailable');
  } finally { store.close(); }
});
test('SSE处理UTF8跨块、多行与工具/推理有效输出，Anthropic缓存不漏计', () => {
  const parser = new SseDecoder(); const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"中文"}}]}\r\n\r\n');
  const first = parser.push(bytes.slice(0, bytes.length - 5)); const second = parser.push(bytes.slice(bytes.length - 5));
  const frames = [...first, ...second]; assert.equal(frames.length, 1);
  assert.equal(inspectEvent('chat-completions', frames[0]!.data, null).effective, true);
  assert.equal(inspectEvent('responses', '{"type":"response.output_item.added","item":{"type":"function_call"}}', null).effective, true);
  assert.deepEqual(readUsage('messages', { usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 } }), { input: 60, output: 5, cacheRead: 20, cacheWrite: 30 });
});
