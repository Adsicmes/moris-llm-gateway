import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createApp } from '../apps/gateway/src/server.js';
import { Store } from '../apps/gateway/src/store.js';
import { ProviderRegistry } from '../apps/gateway/src/providers.js';
import type { ProviderAccount, ProviderModel } from '../packages/contracts/src/index.js';
import { accountProxy, proxyUrl } from '../apps/gateway/src/proxy.js';

async function fixture(fetcher: typeof fetch) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  store.initializeAdmin('admin', 'a-test-password-only');
  const account: ProviderAccount = { id: 'a', namespace: 'test', name: '测试', plugin: 'test', baseUrl: 'https://upstream.test', billingType: 'metered', enabled: true, autoCreateTokens: false, options: {}, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const model: ProviderModel = { path: 'g/m', upstreamModel: 'm', name: 'M', family: 'm', protocol: 'chat-completions', capabilities: { tools: true, input: ['text', 'image'], output: ['text'] }, limit: { context: 10000, output: 1000 }, variants: {}, price: { kind: 'token', currency: 'USD', input: 1, output: 2 } };
  store.saveAccount(account, { apiKey: 'upstream-secret' }); store.replaceCatalog(account, [model], new Date().toISOString());
  const registry = new ProviderRegistry();
  registry.register({
    id: 'test',
    name: 'test',
    setup: {
      baseUrl: { default: 'https://upstream.test', hint: '测试用推荐地址' },
      billingType: { default: 'metered', hint: '测试按量计费' },
      secrets: [{ key: 'apiKey', label: '测试密钥', required: true, description: '测试说明' }],
      tokenTemplate: { supported: true, hint: '测试模板' },
      authorization: { supported: false, hint: '测试不支持授权' },
    },
    discover: async () => ({ complete: true, models: [model] }),
    prepare: async (ctx, m, body) => ({ url: 'https://upstream.test/v1/chat/completions', headers: { authorization: `Bearer ${ctx.secrets.apiKey}` }, body: { ...body, model: m.upstreamModel } }),
  });
  const device = store.createDevice('test');
  const app = await createApp({ store, registry, fetch: fetcher, secureCookie: false, background: false });
  return { app, store, headers: { authorization: `Bearer ${device.key}` }, close: async () => { await app.close(); store.close(); } };
}
test('代理档案密码加密、不回显、保留替换清除；绑定、旧配置兼容与引用删除保护', async () => {
  const f = await fixture(fetch);
  try {
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-test-password-only' } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken as string };
    const payload = { name: '测试出口', protocol: 'http', host: 'localhost', port: 7890, username: 'user@name', passwordAction: 'replace', password: 'p@ss#word%:/中文' };
    assert.equal((await f.app.inject({ url: '/api/admin/proxies', headers: f.headers })).statusCode, 401);
    for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
      assert.equal((await f.app.inject({ method, url: '/api/admin/proxies' + (method === 'POST' ? '' : '/missing'), headers: { cookie: headers.cookie }, payload: method === 'DELETE' ? undefined : payload })).statusCode, 403);
    }
    const created = await f.app.inject({ method: 'POST', url: '/api/admin/proxies', headers, payload });
    assert.equal(created.statusCode, 200, created.body);
    assert.ok(!created.body.includes(payload.password));
    const profile = created.json().item;
    const encoded = new URL(proxyUrl(profile, payload.password));
    assert.equal(decodeURIComponent(encoded.password), payload.password);
    assert.equal(decodeURIComponent(encoded.username), payload.username);
    const url = `/api/admin/proxies/${profile.id}`;
    const encrypted = f.store.db.prepare('SELECT * FROM proxies WHERE id=?').get(profile.id);
    assert.ok(!JSON.stringify(encrypted).includes(payload.password));
    assert.equal(f.store.proxyPassword(profile.id), payload.password);
    const { password: _, ...withoutPassword } = payload;
    assert.equal((await f.app.inject({ method: 'PATCH', url, headers, payload: { ...withoutPassword, host: 'example.com', passwordAction: 'keep' } })).statusCode, 200);
    assert.equal(f.store.proxyPassword(profile.id), payload.password);
    assert.equal((await f.app.inject({ method: 'PATCH', url, headers, payload: { ...withoutPassword, passwordAction: 'replace', password: 'new-pass' } })).statusCode, 200);
    assert.equal(f.store.proxyPassword(profile.id), 'new-pass');
    // 旧内联认证配置在未选择新档案时仍可使用。
    await f.app.inject({ method: 'PATCH', url: '/api/admin/providers/a', headers, payload: { proxyUrl: 'http://old:pass@localhost:9999' } });
    assert.equal(accountProxy(f.store, f.store.account('a')!), 'http://old:pass@localhost:9999');
    await f.app.inject({ method: 'PATCH', url: '/api/admin/providers/a', headers, payload: { name: '保留旧认证' } });
    assert.match(accountProxy(f.store, f.store.account('a')!)!, /old:pass/);
    assert.equal((await f.app.inject({ method: 'PATCH', url: '/api/admin/providers/a', headers, payload: { proxyId: profile.id } })).statusCode, 200);
    const actual = new URL(accountProxy(f.store, f.store.account('a')!)!);
    assert.equal(decodeURIComponent(actual.username), payload.username); assert.equal(decodeURIComponent(actual.password), 'new-pass');
    assert.equal(f.store.secrets('a').__proxyUrl, undefined);
    const list = await f.app.inject({ url: '/api/admin/proxies', headers });
    assert.equal(list.json().items[0].references[0].id, 'a'); assert.ok(!list.body.includes('new-pass'));
    assert.equal((await f.app.inject({ method: 'DELETE', url, headers })).statusCode, 409);
    assert.equal((await f.app.inject({ method: 'PATCH', url: '/api/admin/providers/a', headers, payload: { proxyId: 'missing' } })).statusCode, 404);
    assert.equal((await f.app.inject({ method: 'PATCH', url: '/api/admin/providers/a', headers, payload: { proxyId: null, proxyUrl: '' } })).statusCode, 400);
    f.store.saveAccount({ ...f.store.account('a')!, proxyId: 'missing' });
    assert.throws(() => accountProxy(f.store, f.store.account('a')!), /代理档案不存在/);
    await f.app.inject({ method: 'PATCH', url: '/api/admin/providers/a', headers, payload: { proxyId: null } });
    assert.equal(accountProxy(f.store, f.store.account('a')!), undefined);
    await f.app.inject({ method: 'PATCH', url, headers, payload: { ...withoutPassword, username: '', passwordAction: 'clear' } });
    assert.equal(f.store.proxyPassword(profile.id), ''); assert.equal(f.store.proxy(profile.id)?.hasPassword, false);
    assert.equal((await f.app.inject({ method: 'DELETE', url, headers })).statusCode, 200);
    for (const invalid of [{ host: 'user:pass@host' }, { host: 'https://host' }, { host: 'host:80' }, { port: 0 }, { port: 65536 }, { passwordAction: 'replace', password: '' }, { protocol: 'socks5', username: '' }]) {
      assert.equal((await f.app.inject({ method: 'POST', url: '/api/admin/proxies', headers, payload: { ...payload, ...invalid } })).statusCode, 400, JSON.stringify(invalid));
    }
  } finally { await f.close(); }
});

test('代理诊断使用固定目标、HEAD且不带凭据；安全分类响应与错误', async () => {
  let failure: unknown; let status = 200; let calls = 0;
  const f = await fixture((async (url, init) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(init?.method, 'HEAD'); assert.equal(init?.headers, undefined);
    if (failure) throw failure;
    return new Response(null, { status });
  }) as typeof fetch);
  try {
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-test-password-only' } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken as string };
    const created = await f.app.inject({ method: 'POST', url: '/api/admin/proxies', headers, payload: { name: 'probe', protocol: 'http', host: 'localhost', port: 7890, username: '', passwordAction: 'keep' } });
    const url = `/api/admin/proxies/${created.json().item.id}/diagnose`;
    assert.equal((await f.app.inject({ method: 'POST', url, headers, payload: { target: 'https://private.test' } })).statusCode, 400); assert.equal(calls, 0);
    assert.equal((await f.app.inject({ method: 'POST', url, headers: { cookie: headers.cookie }, payload: { target: 'openai' } })).statusCode, 403);
    for (const [value, code] of [[200, 'reachable'], [401, 'upstream_rejected'], [407, 'proxy_auth']] as const) {
      status = value;
      assert.equal((await f.app.inject({ method: 'POST', url, headers, payload: { target: 'openai' } })).json().code, code);
    }
    for (const [error, code] of [[new Error('http://private:secret@host', { cause: Object.assign(new Error('hidden'), { code: 'PROXY_AUTH' }) }), 'proxy_auth'], [new DOMException('hidden-secret', 'TimeoutError'), 'timeout'], [new Error('private:secret'), 'connection_failed']] as const) {
      failure = error; const result = await f.app.inject({ method: 'POST', url, headers, payload: { target: 'openai' } });
      assert.equal(result.json().code, code); assert.ok(!result.body.includes('secret'));
    }
  } finally { await f.close(); }
});
test('临时失败最多三次，每次费用留存，不透传设备密钥', async () => {
  let calls = 0;
  const f = await fixture((async (_url, init) => {
    calls++; assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer upstream-secret');
    assert.equal(JSON.parse(String(init?.body)).model, 'm');
    return Response.json({ error: { message: 'private prompt here' }, usage: { prompt_tokens: 100, completion_tokens: 10 } }, { status: 503 });
  }) as typeof fetch);
  try {
    const result = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: f.headers, payload: { model: 'test/g/m', messages: [{ role: 'user', content: 'secret prompt' }] } });
    assert.equal(result.statusCode, 503); assert.equal(calls, 3); assert.equal(f.store.attempts().length, 3);
    assert.equal(f.store.requests().length, 1); assert.ok(f.store.attempts().every(a => a.estimatedCost !== null));
    assert.ok(!JSON.stringify(f.store.attempts()).includes('secret prompt')); assert.ok(!result.body.includes('private prompt'));
  } finally { await f.close(); }
});
test('认证错误不重试，未知用量保持null', async () => {
  let calls = 0; const f = await fixture((async () => { calls++; return Response.json({ error: 'invalid key' }, { status: 401 }); }) as typeof fetch);
  try {
    const res = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: f.headers, payload: { model: 'test/g/m' } });
    assert.equal(res.statusCode, 502); assert.equal(calls, 1); assert.equal(f.store.attempts()[0]!.estimatedCost, null);
  } finally { await f.close(); }
});
test('有效流输出后中断不重放，正常完整流保留usage', async () => {
  let calls = 0; const f = await fixture((async () => { calls++; return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', { headers: { 'content-type': 'text/event-stream' } }); }) as typeof fetch);
  try {
    const res = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: f.headers, payload: { model: 'test/g/m', stream: true } });
    assert.equal(calls, 1); assert.match(res.body, /hello/); assert.match(res.body, /upstream_interrupted/);
    assert.equal(f.store.requests()[0]?.status, 'interrupted');
  } finally { await f.close(); }
});
test('设备key不能管理；cookie管理写入必须CSRF；凭据不回传', async () => {
  const f = await fixture(fetch);
  try {
    assert.equal((await f.app.inject({ url: '/api/admin/providers', headers: f.headers })).statusCode, 401);
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-test-password-only' } });
    assert.equal(login.statusCode, 200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!; const csrf = login.json().csrfToken as string;
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/admin/devices', headers: { cookie }, payload: { name: 'new' } })).statusCode, 403);
    const create = await f.app.inject({ method: 'POST', url: '/api/admin/devices', headers: { cookie, 'x-csrf-token': csrf }, payload: { name: 'new' } });
    assert.equal(create.statusCode, 200); assert.match(create.json().key, /^moris_/);
    const list = await f.app.inject({ url: '/api/admin/providers', headers: { cookie } }); assert.ok(!list.body.includes('upstream-secret'));
    const patch = await f.app.inject({ method: 'PATCH', url: '/api/admin/providers/a', headers: { cookie, 'x-csrf-token': csrf }, payload: { proxyUrl: 'http://user:private-password@localhost:7890' } });
    assert.equal(patch.statusCode, 200); assert.ok(!patch.body.includes('private-password')); assert.match(f.store.secrets('a').__proxyUrl!, /private-password/);
  } finally { await f.close(); }
});
test('协议不匹配和过期目录在发出上游前拒绝', async () => {
  let calls = 0; const f = await fixture((async () => { calls++; throw new Error('should not call'); }) as typeof fetch);
  try {
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/responses', headers: f.headers, payload: { model: 'test/g/m' } })).statusCode, 400);
    f.store.saveSettings({ ...f.store.settings(), catalogTtlMs: 1 }); await new Promise(r => setTimeout(r, 5));
    assert.equal((await f.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: f.headers, payload: { model: 'test/g/m' } })).statusCode, 503);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('插件元数据只暴露默认值与字段说明，不暴露凭据', async () => {
  const f = await fixture(fetch);
  try {
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-test-password-only' } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]! };
    const response = await f.app.inject({ url: '/api/admin/plugins', headers });
    assert.equal(response.statusCode, 200);
    const plugin = response.json().items[0];
    assert.equal(plugin.id, 'test');
    assert.equal(plugin.setup.baseUrl.default, 'https://upstream.test');
    assert.equal(plugin.setup.billingType.default, 'metered');
    assert.equal(plugin.setup.secrets[0].key, 'apiKey');
    assert.equal(plugin.setup.authorization.supported, false);
    assert.ok(!response.body.includes('upstream-secret'));
  } finally {
    await f.close();
  }
});

test('令牌模板支持长期有效并拒绝负数或小数天数', async () => {
  const f = await fixture(fetch);
  try {
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-test-password-only' } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken as string };
    for (const days of [0, -1, 0.5]) {
      const result = await f.app.inject({ method: 'PATCH', url: '/api/admin/providers/a', headers, payload: { autoCreateTokens: true, tokenTemplate: { namePrefix: 'moris', quota: 0, unlimited: true, expiresInDays: days } } });
      assert.equal(result.statusCode, days === 0 ? 200 : 400);
    }
    assert.equal(f.store.account('a')?.tokenTemplate?.expiresInDays, 0);
  } finally { await f.close(); }
});

test('模型参数API校验、并发冲突、认证与CSRF；目录即时生效', async () => {
  const f = await fixture(fetch);
  const url = `/api/admin/models/${encodeURIComponent('test/g/m')}/parameters`;
  try {
    assert.equal((await f.app.inject({ url, headers: f.headers })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'PATCH', url, headers: f.headers, payload: { overrides: {}, revision: null } })).statusCode, 401);
    const login = await f.app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'a-test-password-only' } });
    const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, 'x-csrf-token': login.json().csrfToken as string };
    assert.equal((await f.app.inject({ method: 'PATCH', url, headers: { cookie: headers.cookie }, payload: { overrides: {}, revision: null } })).statusCode, 403);
    const state = (await f.app.inject({ url, headers })).json();
    assert.equal(state.revision, null);
    for (const overrides of [{ context: 0 }, { output: -1 }, { input: 1.5 }, { context: '100' }, { context: Number.MAX_SAFE_INTEGER + 1 }, { tools: 'false' }, { name: ' ' }, { protocol: 'messages' }, { output: 10001 }, { input: 10001 }, { context: 500 }]) {
      const res = await f.app.inject({ method: 'PATCH', url, headers, payload: { overrides, revision: null } });
      assert.equal(res.statusCode, 400, JSON.stringify(overrides));
    }
    const saved = await f.app.inject({ method: 'PATCH', url, headers, payload: { overrides: { context: 12000, tools: false, imageInput: false }, revision: null } });
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().effective.capabilities.tools, false);
    assert.equal(saved.json().effective.syncedAt, state.automatic.syncedAt);
    const catalog = (await f.app.inject({ url: '/api/admin/models', headers })).json();
    assert.equal(catalog.items[0].limit.context, 12000);
    assert.equal((await f.app.inject({ method: 'PATCH', url, headers, payload: { overrides: {}, revision: null } })).statusCode, 409);
    const reset = await f.app.inject({ method: 'PATCH', url, headers, payload: { overrides: {}, revision: saved.json().revision } });
    assert.equal(reset.statusCode, 200); assert.equal(reset.json().effective.limit.context, 10000);
    assert.equal((await f.app.inject({ url: '/api/admin/models/missing/parameters', headers })).statusCode, 404);
  } finally { await f.close(); }
});

test('只按显式配置回退，完成响应及工具参数原样保留', async () => {
  const models: string[] = [];
  const f = await fixture((async (_url, init) => {
    const body = JSON.parse(String(init?.body)); models.push(body.model);
    if (body.model === 'm') return Response.json({ error: {} }, { status: 503 });
    assert.deepEqual(body.tools, [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }]);
    return Response.json({ id: 'up-ok', choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  }) as typeof fetch);
  try {
    const original = f.store.models()[0]!;
    f.store.replaceCatalog(f.store.account('a')!, [original, { ...original, path: 'other/m', upstreamModel: 'other' }], new Date().toISOString());
    f.store.saveSettings({ ...f.store.settings(), fallback: { 'test/g/m': ['test/other/m'] } });
    const result = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: f.headers, payload: { model: 'test/g/m', tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }] } });
    assert.equal(result.statusCode, 200); assert.deepEqual(models, ['m', 'other']);
    assert.equal(result.json().choices[0].message.tool_calls[0].id, 'call_1');
    assert.equal(f.store.attempts()[1]?.modelId, 'test/other/m');
    assert.equal(f.store.requests()[0]?.status, 'succeeded');
  } finally { await f.close(); }
});

test('完整SSE流成功终止并结算usage，订阅费用与等价值分开', async () => {
  const f = await fixture((async () => new Response([
    'data: {"id":"up","choices":[{"delta":{"content":"ok"}}]}',
    'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10}}',
    'data: [DONE]', '',
  ].join('\n\n'), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch);
  try {
    f.store.saveAccount({ ...f.store.account('a')!, billingType: 'subscription' });
    const result = await f.app.inject({ method: 'POST', url: '/v1/chat/completions', headers: f.headers, payload: { model: 'test/g/m', stream: true } });
    assert.match(result.body, /\[DONE\]/); assert.equal(f.store.requests()[0]?.status, 'succeeded');
    assert.deepEqual(f.store.attempts()[0]?.usage, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 });
    assert.equal(f.store.attempts()[0]?.estimatedCost?.amount, 0);
    assert.ok(f.store.attempts()[0]!.equivalentUsd! > 0);
  } finally { await f.close(); }
});
