import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  Price,
  ProviderAccount,
  ProviderContext,
  ProviderModel,
  ProviderMonitor,
  Usage,
} from '@moris/provider-sdk';
import realseek from '../packages/providers/realseek/src/index.js';
import deepseek, { deepSeekCost, isDeepSeekPeak } from '../packages/providers/deepseek/src/index.js';
import vm2api from '../packages/providers/vm2api/src/index.js';
import openaiSubscription, {
  pollDeviceAuthorization,
  startDeviceAuthorization,
} from '../packages/providers/openai-subscription/src/index.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function account(plugin: string, overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'account-1',
    namespace: plugin,
    name: 'test account',
    plugin,
    baseUrl: 'https://newapi.example.com',
    billingType: 'metered',
    enabled: true,
    autoCreateTokens: false,
    options: {},
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

function makeContext(
  pluginAccount: ProviderAccount,
  secrets: Record<string, string>,
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { context: ProviderContext; calls: Call[]; patches: Record<string, string>[] } {
  const calls: Call[] = [];
  const patches: Record<string, string>[] = [];
  const context = {
    account: pluginAccount,
    secrets: { ...secrets },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const requestInit = init ?? {};
      calls.push({ url, init: requestInit });
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`test fetch stub received non-HTTP URL: ${url}`);
      }
      if (new URL(url).hostname === 'models.dev') {
        throw new Error('test fetch stub must not request models.dev; set options.modelsDev=false or stub it explicitly');
      }
      return handler(url, requestInit);
    },
    signal: new AbortController().signal,
    now: () => NOW,
    updateSecrets: async (patch: Record<string, string>) => {
      patches.push(patch);
      Object.assign(context.secrets, patch);
    },
  } as ProviderContext;
  return { context, calls, patches };
}

function model(models: ProviderModel[], path: string): ProviderModel {
  const found = models.find((item) => item.path === path);
  assert.ok(found, `missing model ${path}`);
  return found;
}

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

function authJwt(accountId: string, exp: number): string {
  return jwt({
    exp,
    email: 'user@example.com',
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: 'pro',
      chatgpt_user_id: 'user-1',
    },
  });
}

const pricing = {
  success: true,
  data: [
    {
      model_name: 'gpt-test',
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 2,
      cache_ratio: 0.1,
      create_cache_ratio: 1.25,
      enable_groups: ['group-c', 'group-d'],
      supported_endpoint_types: ['openai'],
      vendor_id: 1,
      pricing_version: 'p1',
    },
    {
      model_name: 'complex-model',
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 1,
      enable_groups: ['group-c'],
      supported_endpoint_types: ['openai'],
      billing_mode: 'tiered_expr',
      billing_expr: 'tier("标准", p * 2 + c * 10 + cr * 0.2)',
      pricing_version: 'p1',
    },
    {
      model_name: 'mystery',
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 1,
      enable_groups: ['group-c'],
      supported_endpoint_types: ['openai'],
      pricing_version: 'p1',
    },
    {
      model_name: 'secret-model',
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 1,
      enable_groups: ['secret'],
      supported_endpoint_types: ['openai'],
      pricing_version: 'p1',
    },
  ],
  group_ratio: { 'group-c': 0.5, 'group-d': 0.4, secret: 1 },
  vendors: [{ id: 1, name: 'OpenAI' }],
  pricing_version: 'p1',
};

test("realseek: account permissions, missing params, complex price and credential key", { timeout: 5000 }, async () => {
  const tokens = [{ id: 1, name: 'mine', group: 'group-c', status: 1, key: 'sk-masked****' }];
  const { context, calls, patches } = makeContext(
    account('realseek', {
      options: {
        allowUserTokens: true,
        modelOverrides: {
          'gpt-test': { context: 200_000, output: 8_192, tools: true },
          'complex-model': { context: 200_000, output: 8_192, tools: true },
        },
      },
    }),
    { accessToken: 'access-token', userId: '7' },
    (url) => {
      if (url.endsWith('/api/status')) {
        return json({ success: true, data: { quota_per_unit: 500_000, quota_display_type: 'USD' } });
      }
      if (url.endsWith('/api/pricing')) return json(pricing);
      if (url.endsWith('/api/user/self')) {
        return json({ success: true, data: { id: 7, quota: 1_000_000, used_quota: 500_000 } });
      }
      if (url.endsWith('/api/user/self/groups')) {
        return json({ success: true, data: ['group-c', 'group-d'] });
      }
      if (url.includes('/api/token/?p=1')) {
        return json({ success: true, data: { page: 1, page_size: 100, total: tokens.length, items: tokens } });
      }
      if (url.endsWith('/api/token/1/key')) return json({ success: true, data: { key: 'sk-full-one' } });
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  const result = await realseek.discover(context);
  assert.equal(result.complete, true);
  const gpt = model(result.models, 'group-c/gpt-test');
  assert.equal(gpt.enabled, true);
  assert.equal(gpt.protocol, 'chat-completions');
  assert.equal(gpt.family, 'OpenAI');
  assert.equal(gpt.limit.context, 200_000);
  assert.equal(gpt.limit.output, 8_192);
  assert.equal(gpt.capabilities.tools, true);
  assert.equal(gpt.credentialKey, 'token:group-c');
  assert.equal(gpt.price.kind, 'token');
  assert.equal(gpt.price.input, 1);
  assert.equal(gpt.price.output, 2);
  assert.equal(gpt.price.cacheRead, 0.1);
  assert.equal(gpt.price.cacheWrite, 1.25);
  assert.equal(gpt.referencePrice?.input, 2);
  assert.equal(context.secrets['token:group-c'], 'sk-full-one');
  assert.deepEqual(patches[0], { 'token:group-c': 'sk-full-one' });

  const missingParams = model(result.models, 'group-c/mystery');
  assert.equal(missingParams.enabled, false);
  assert.equal(missingParams.limit.context, null);
  assert.equal(missingParams.limit.output, null);
  assert.equal(missingParams.capabilities.tools, false);
  assert.match(missingParams.disabledReason ?? '', /上下文长度未知/);

  const otherGroup = model(result.models, 'group-d/gpt-test');
  assert.equal(otherGroup.enabled, false);
  assert.match(otherGroup.disabledReason ?? '', /没有可用推理令牌/);

  assert.throws(() => model(result.models, 'secret/secret-model'));
  const complex = model(result.models, 'group-c/complex-model');
  assert.equal(complex.price.kind, 'complex');
  assert.match(complex.price.expression ?? '', /tier\("标准", p \* 2 \+ c \* 10 \+ cr \* 0\.2\)\) \* 0\.5/);
  const estimate = realseek.estimate?.(complex.price, { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 }, {});
  assert.ok(estimate);
  assert.equal(estimate.amount, 0.0015);

  assert.ok(calls.some((call) => call.url.endsWith('/api/pricing')));
});

test("realseek: auto token creation uses complete template, reuses token, never mutates or deletes", { timeout: 5000 }, async () => {
  const tokens = [{ id: 1, name: 'mine', group: 'group-c', status: 1, key: 'sk-masked****' }];
  let posts = 0;
  const { context, calls } = makeContext(
    account('realseek', {
      autoCreateTokens: true,
      tokenTemplate: { namePrefix: 'moris', quota: 2, expiresInDays: 30 },
      options: {
        allowUserTokens: true,
        modelOverrides: { 'gpt-test': { context: 200_000, output: 8_192, tools: true } },
      },
    }),
    { accessToken: 'access-token', userId: '7' },
    (url, init) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(pricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7, quota: 1_000_000 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c', 'group-d'] });
      if (url.includes('/api/token/?p=1')) {
        return json({ success: true, data: { page: 1, page_size: 100, total: tokens.length, items: tokens } });
      }
      if (url.endsWith('/api/token/1/key')) return json({ success: true, data: { key: 'sk-full-one' } });
      if (url.endsWith('/api/token/2/key')) return json({ success: true, data: { key: 'sk-full-two' } });
      if (url.endsWith('/api/token/') && init.method === 'POST') {
        posts += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert.equal(body.name, 'moris-group-d');
        assert.equal(body.group, 'group-d');
        assert.equal(body.unlimited_quota, false);
        assert.equal(body.remain_quota, 1_000_000);
        assert.equal(body.expired_time, Math.floor(NOW.getTime() / 1000) + 30 * 86_400);
        tokens.push({ id: 2, name: 'moris-group-d', group: 'group-d', status: 1, key: 'sk-masked-two' });
        return json({ success: true });
      }
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  const first = await realseek.discover(context);
  assert.equal(posts, 1);
  assert.equal(context.secrets['token:group-d'], 'sk-full-two');
  assert.equal(model(first.models, 'group-d/gpt-test').enabled, true);
  assert.equal(calls.some((call) => call.init.method === 'DELETE' || call.init.method === 'PUT'), false);

  const second = await realseek.discover(context);
  assert.equal(posts, 1, 'existing matching token must be reused, not recreated');
  assert.equal(model(second.models, 'group-d/gpt-test').enabled, true);
});

test("realseek: public pricing alone is not an account catalog and token pagination must be complete", { timeout: 5000 }, async () => {
  const { context: publicContext } = makeContext(account('realseek'), {}, () => {
    throw new Error('public pricing must not be requested without accessToken');
  });
  const publicResult = await realseek.discover(publicContext);
  assert.equal(publicResult.complete, false);
  assert.equal(publicResult.models.length, 0);

  const { context } = makeContext(
    account('realseek'),
    { accessToken: 'access-token', userId: '7' },
    (url) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(pricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c'] });
      if (url.includes('/api/token/?p=1')) {
        return json({
          success: true,
          data: { page: 1, page_size: 100, total: 2, items: [{ id: 1, name: 'mine', group: 'group-c', status: 1 }] },
        });
      }
      return json({ success: false, message: 'page failed' }, 500);
    },
  );
  await assert.rejects(() => realseek.discover(context), /page failed|HTTP 500/);
});

test('realseek: moris-only configuration creates unlimited permanent keys without using other tokens', { timeout: 5000 }, async () => {
  const tokens = [{ id: 1, name: 'personal', group: 'group-c', status: 1, key: 'private-existing-key-must-not-be-used' }];
  const posts: Record<string, unknown>[] = [];
  const { context, calls } = makeContext(account('realseek', {
    autoCreateTokens: true,
    tokenTemplate: { namePrefix: 'moris', quota: 0, unlimited: true, expiresInDays: 0 },
    options: { managedTokenPrefix: 'moris', allowUserTokens: false, modelOverrides: { 'gpt-test': { context: 200_000, output: 8192, tools: true } } },
  }), { accessToken: 'account-access', userId: '7' }, (url, init) => {
    if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
    if (url.endsWith('/api/pricing')) return json(pricing);
    if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
    if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c', 'group-d', 'images-only'] });
    if (url.includes('/api/token/?')) return json({ success: true, data: { total: tokens.length, items: tokens } });
    if (url.endsWith('/api/token/') && init.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push(body);
      assert.match(body.name, /^moris-/); assert.equal(body.unlimited_quota, true); assert.equal(body.expired_time, -1); assert.equal(body.remain_quota, 0);
      assert.notEqual(body.group, 'images-only');
      tokens.push({ id: tokens.length + 1, name: body.name, group: body.group, status: 1, key: 'sk-masked****' });
      return json({ success: true });
    }
    const keyMatch = url.match(/\/api\/token\/(\d+)\/key$/);
    if (keyMatch) {
      assert.equal(init.method, 'POST', 'New API requires POST to reveal a key');
      const token = tokens.find(item => item.id === Number(keyMatch[1]));
      assert.ok(token);
      assert.ok(token.name.startsWith('moris-'), 'never reveal another token');
      return json({ success: true, data: { key: `dedicated-moris-key-${token.group}` } });
    }
    throw new Error('unexpected call; existing token key must not be revealed');
  });
  const discovery = await realseek.discover(context);
  assert.equal(posts.length, 2);
  assert.equal(context.secrets['token:group-c'], 'dedicated-moris-key-group-c');
  const prepared = await realseek.prepare(context, model(discovery.models, 'group-c/gpt-test'), {}, 'chat-completions');
  assert.equal(prepared.headers.Authorization, 'Bearer dedicated-moris-key-group-c');
  await realseek.discover(context);
  assert.equal(posts.length, 2, 'second discovery reuses the dedicated tokens');
  assert.ok(calls.every(call => !['PUT', 'DELETE'].includes(call.init.method ?? 'GET')));
});

test("realseek: autoCreateTokens with incomplete template fails discovery instead of inventing values", { timeout: 5000 }, async () => {
  const { context } = makeContext(
    account('realseek', {
      autoCreateTokens: true,
      tokenTemplate: { namePrefix: '', quota: 0, expiresInDays: 0 },
    }),
    { accessToken: 'access-token', userId: '7' },
    (url) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(pricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c'] });
      if (url.includes('/api/token/?p=1')) {
        return json({ success: true, data: { page: 1, page_size: 100, total: 0, items: [] } });
      }
      throw new Error(`unexpected test URL: ${url}`);
    },
  );
  await assert.rejects(() => realseek.discover(context), /tokenTemplate/);
});

test("deepseek: official /models metadata, complex peak/off-peak price, balance and prepare", { timeout: 5000 }, async () => {
  const { context, calls } = makeContext(account('deepseek', { baseUrl: 'https://api.deepseek.com' }), { apiKey: 'sk-deep' }, (url) => {
    if (url.endsWith('/models')) {
      return json({
        object: 'list',
        data: [
          {
            id: 'deepseek-flash',
            name: 'DeepSeek-V4.1-Flash',
            context_window: 1_048_576,
            max_output_tokens: 393_216,
            input_modalities: ['text', 'image'],
            output_modalities: ['text'],
            effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
          },
          {
            id: 'deepseek-v4-pro',
            name: 'DeepSeek-V4-Pro',
            context_window: 1_048_576,
            max_output_tokens: 393_216,
            input_modalities: ['text'],
            output_modalities: ['text'],
            effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' },
          },
        ],
      });
    }
    if (url.endsWith('/user/balance')) {
      return json({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
      });
    }
    throw new Error(`unexpected test URL: ${url}`);
  });

  const result = await deepseek.discover(context);
  assert.equal(result.complete, true);
  const flash = model(result.models, 'deepseek-flash');
  assert.equal(flash.protocol, 'chat-completions');
  assert.equal(flash.limit.context, 1_048_576);
  assert.equal(flash.limit.output, 393_216);
  assert.deepEqual(flash.capabilities.input, ['text', 'image']);
  assert.equal(flash.capabilities.tools, true);
  assert.equal(flash.price.kind, 'complex');
  assert.match(flash.price.expression ?? '', /cache_miss_peak=0\.3/);
  assert.ok(flash.variants.low);
  assert.ok(flash.variants['non-thinking']);
  assert.equal(deepseek.estimate?.(flash.price, { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0 }, {}), null);

  const prepared = await deepseek.prepare(
    context,
    flash,
    { model: 'client-model', authorization: 'Bearer client', url: 'https://evil.example', messages: [] },
    'chat-completions',
  );
  assert.equal(prepared.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(prepared.headers.Authorization, 'Bearer sk-deep');
  assert.equal(prepared.body.model, 'deepseek-flash');
  assert.equal('authorization' in prepared.body, false);
  assert.equal('url' in prepared.body, false);

  const peak = new Date('2026-11-13T02:00:00.000Z');
  const offPeak = new Date('2026-11-13T12:00:00.000Z');
  assert.equal(isDeepSeekPeak(peak), true);
  assert.equal(isDeepSeekPeak(offPeak), false);
  const peakCost = deepSeekCost(peak, 'deepseek-flash', { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
  const offPeakCost = deepSeekCost(offPeak, 'deepseek-flash', { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
  assert.equal(peakCost?.amount, 1.5);
  assert.equal(offPeakCost?.amount, 0.75);
  assert.equal(
    deepSeekCost(peak, 'deepseek-flash', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, { isChinesePublicHoliday: true })?.amount,
    0.15,
  );

  const monitor = (await deepseek.monitor?.(context)) as ProviderMonitor;
  assert.equal(monitor.state, 'ok');
  assert.deepEqual(monitor.balances, [{ currency: 'CNY', amount: 110, unit: 'total_balance' }]);
  assert.ok(calls.some((call) => call.url.endsWith('/user/balance')));
});

test("vm2api: key-scoped catalog, quota windows, unknown price and protocol prepare", { timeout: 5000 }, async () => {
  const { context } = makeContext(
    account('vm2api', {
      baseUrl: 'https://vm.test',
      options: {
        modelOverrides: {
          'gpt-x': {
            context: 272_000,
            output: 128_000,
            tools: true,
            price: { kind: 'token', currency: 'USD', input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          },
          'claude-y': { context: 200_000, output: 64_000, tools: true },
        },
      },
    }),
    { apiKey: 'sk-vm' },
    (url) => {
      if (url.endsWith('/v1/models')) {
        return json({
          object: 'list',
          data: [
            {
              id: 'gpt-x',
              object: 'model',
              display_name: 'GPT X',
              family: 'codex',
              owned_by: 'openai',
              enabled: true,
              capabilities: { tools: true, input: ['text', 'image'] },
            },
            {
              id: 'claude-y',
              object: 'model',
              display_name: 'Claude Y',
              family: 'claude',
              owned_by: 'anthropic',
              enabled: true,
            },
          ],
        });
      }
      if (url.endsWith('/v1/me/quota')) {
        return json({
          object: 'api_key_quota',
          checked_at: '2026-11-13T12:00:00.000Z',
          usd: { limit: 10, used: 2.5, remaining: 7.5, exceeded: false },
          windows: {
            '5h': {
              limit: 5,
              used: 1,
              remaining: 4,
              exceeded: false,
              window_start: '2026-11-13T08:00:00.000Z',
              reset_at: '2026-11-13T13:00:00.000Z',
            },
            '1d': { limit: null, used: 0, remaining: null, exceeded: false, window_start: null, reset_at: null },
            '7d': {
              limit: 20,
              used: 4,
              remaining: 16,
              exceeded: false,
              window_start: '2026-11-07T12:00:00.000Z',
              reset_at: '2026-11-14T12:00:00.000Z',
            },
          },
          requests: { limit: 100, used: 3, remaining: 97, exceeded: false },
          blocked_by: null,
        });
      }
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  const result = await vm2api.discover(context);
  assert.equal(result.complete, true);
  const gpt = model(result.models, 'gpt-x');
  assert.equal(gpt.protocol, 'responses');
  assert.equal(gpt.enabled, true);
  assert.equal(gpt.price.kind, 'token');
  assert.equal(gpt.price.input, 2);

  const claude = model(result.models, 'claude-y');
  assert.equal(claude.protocol, 'messages');
  assert.equal(claude.price.kind, 'unknown');
  assert.equal(claude.enabled, true);
  assert.equal(claude.disabledReason, undefined);
  assert.match(result.warnings?.join('\n') ?? '', /价格未知/);

  const prepared = await vm2api.prepare(
    context,
    claude,
    { model: 'client', Authorization: 'client', base_url: 'https://evil', messages: [] },
    'messages',
  );
  assert.equal(prepared.url, 'https://vm.test/v1/messages');
  assert.equal(prepared.headers.Authorization, 'Bearer sk-vm');
  assert.equal(prepared.body.model, 'claude-y');
  assert.equal('Authorization' in prepared.body, false);
  assert.equal('base_url' in prepared.body, false);

  const monitor = (await vm2api.monitor?.(context)) as ProviderMonitor;
  assert.equal(monitor.state, 'ok');
  assert.deepEqual(monitor.balances, [{ currency: 'USD', amount: 7.5, unit: 'remaining_usd' }]);
  assert.equal(monitor.windows.length, 2);
  assert.equal(monitor.windows[0]?.id, 'vm2api-5h');
  assert.equal(monitor.windows[0]?.usedRatio, 0.2);
  assert.equal(monitor.windows[0]?.pool, 'default');

  const estimate = vm2api.estimate?.(
    gpt.price,
    { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 },
    {},
  );
  assert.equal(estimate?.amount, 3);
});

test("vm2api: missing usage or remaining values are not published as zero", { timeout: 5000 }, async () => {
  const { context } = makeContext(
    account('vm2api', { baseUrl: 'https://vm.test' }),
    { apiKey: 'sk-vm' },
    (url) => {
      if (url.endsWith('/v1/me/quota')) {
        return json({
          object: 'api_key_quota',
          checked_at: '2026-11-13T12:00:00.000Z',
          usd: { limit: 10 },
          windows: {
            '5h': { limit: 5, reset_at: '2026-11-13T13:00:00.000Z' },
            '7d': { limit: 20, used: 4, remaining: 16, reset_at: '2026-11-14T12:00:00.000Z' },
          },
          requests: { limit: 100 },
        });
      }
      throw new Error(`unexpected test URL: ${url}`);
    },
  );
  const monitor = (await vm2api.monitor?.(context)) as ProviderMonitor;
  assert.equal(monitor.state, 'unknown');
  assert.equal(monitor.balances.length, 0);
  assert.equal(monitor.windows.length, 1);
  assert.equal(monitor.windows[0]?.id, 'vm2api-7d');
  assert.match(monitor.message ?? '', /USD remaining\/used 缺失/);
  assert.match(monitor.message ?? '', /5h 窗口 used 缺失/);
  assert.match(monitor.message ?? '', /请求额度上限 100，已用未知/);
});

test("openai subscription: refresh token, account header, Responses prepare and usage windows", { timeout: 5000 }, async () => {
  const expired = authJwt('acct-old', Math.floor(NOW.getTime() / 1000) - 3600);
  const refreshed = authJwt('acct-1', Math.floor(NOW.getTime() / 1000) + 3600);
  const refreshId = authJwt('acct-1', Math.floor(NOW.getTime() / 1000) + 3600);
  const { context, patches } = makeContext(
    account('openai-subscription', {
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      billingType: 'subscription',
      options: { modelsDev: false, clientVersion: '0.153.0', planPrice: { amount: 100, currency: 'USD' } },
    }),
    { accessToken: expired, refreshToken: 'refresh-1', accountId: 'acct-old' },
    (url, init) => {
      if (url === 'https://auth.openai.com/oauth/token') {
        assert.equal(init.method, 'POST');
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert.equal(body.grant_type, 'refresh_token');
        assert.equal(body.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
        assert.equal(body.refresh_token, 'refresh-1');
        return json({ access_token: refreshed, refresh_token: 'refresh-2', id_token: refreshId });
      }
      if (url.includes('/backend-api/codex/models?client_version=0.153.0')) {
        assert.equal((init.headers as Record<string, string>).Authorization, `Bearer ${refreshed}`);
        assert.equal((init.headers as Record<string, string>)['chatgpt-account-id'], 'acct-1');
        assert.equal((init.headers as Record<string, string>).originator, 'codex_cli_rs');
        return json({
          models: [
            {
              slug: 'gpt-test',
              display_name: 'GPT Test',
              context_window: 272_000,
              max_output_tokens: 128_000,
              input_modalities: ['text', 'image'],
              supported_in_api: true,
              visibility: 'list',
              supports_parallel_tool_calls: true,
              supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
            },
          ],
        });
      }
      if (url === 'https://chatgpt.com/backend-api/wham/usage') {
        assert.equal((init.headers as Record<string, string>)['chatgpt-account-id'], 'acct-1');
        return json({
          plan_type: 'pro',
          rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_after_seconds: 100, reset_at: 1_800_000_000 },
            secondary_window: { used_percent: 50, limit_window_seconds: 604_800, reset_after_seconds: 200, reset_at: 1_800_100_000 },
          },
          credits: { has_credits: true, unlimited: false, balance: '12.5' },
        });
      }
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  const result = await openaiSubscription.discover(context);
  assert.equal(result.complete, true);
  const gpt = model(result.models, 'gpt-test');
  assert.equal(gpt.protocol, 'responses');
  assert.equal(gpt.enabled, true);
  assert.equal(gpt.price.kind, 'token');
  assert.equal(gpt.price.input, 0);
  assert.equal(gpt.price.output, 0);
  assert.equal(gpt.referencePrice?.kind, 'unknown');
  assert.ok(gpt.variants.low);
  assert.equal(context.secrets.refreshToken, 'refresh-2');
  assert.equal(context.secrets.accountId, 'acct-1');
  assert.equal(patches.length, 1);
  assert.equal(patches[0]?.refreshToken, 'refresh-2');

  const prepared = await openaiSubscription.prepare(
    context,
    gpt,
    {
      model: 'client',
      authorization: 'Bearer client',
      url: 'https://evil',
      input: 'hello',
      store: true,
      stream: false,
      max_output_tokens: 123,
      max_tokens: 456,
    },
    'responses',
  );
  assert.equal(prepared.url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.equal(prepared.headers.Authorization, `Bearer ${refreshed}`);
  assert.equal(prepared.headers['chatgpt-account-id'], 'acct-1');
  assert.equal(prepared.body.model, 'gpt-test');
  assert.equal(prepared.body.store, false);
  assert.equal(prepared.body.stream, true);
  assert.equal('max_output_tokens' in prepared.body, false);
  assert.equal('max_tokens' in prepared.body, false);
  assert.equal(prepared.responseFormat, 'sse');
  assert.equal('authorization' in prepared.body, false);
  assert.equal('url' in prepared.body, false);

  const monitor = (await openaiSubscription.monitor?.(context)) as ProviderMonitor;
  assert.equal(monitor.state, 'ok');
  assert.equal(monitor.windows.length, 2);
  assert.equal(monitor.windows[0]?.usedRatio, 0.2);
  assert.equal(monitor.windows[0]?.pool, 'default');
  assert.deepEqual(monitor.balances, [{ currency: 'credits', amount: 12.5, unit: 'balance' }]);
  assert.deepEqual(monitor.planPrice, { amount: 100, currency: 'USD', source: 'account.options.planPrice' });
  assert.equal(openaiSubscription.estimate?.(gpt.price, { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, {})?.amount, 0);

  const tiered: Price = {
    kind: 'complex',
    currency: 'USD',
    expression: `models.dev:${JSON.stringify({
      input: 2,
      output: 10,
      tiers: [{ input: 4, output: 15, tier: { type: 'context', size: 272_000 } }],
    })}`,
  };
  assert.equal(
    openaiSubscription.estimate?.(tiered, { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0 }, {})?.amount,
    1.2,
  );
  assert.equal(
    openaiSubscription.estimate?.(
      { kind: 'token', currency: 'USD', input: 2, output: 10 },
      { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 },
      {},
    ),
    null,
  );
  assert.equal(
    openaiSubscription.estimate?.(gpt.price, { input: 100, output: 0, cacheRead: 200, cacheWrite: 0 }, {}),
    null,
  );
});

test("openai subscription: missing OAuth credentials fails explicitly and does not fake authentication", { timeout: 5000 }, async () => {
  const { context } = makeContext(
    account('openai-subscription', {
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      billingType: 'subscription',
      options: { modelsDev: false },
    }),
    {},
    () => {
      throw new Error('network must not be called without credentials');
    },
  );
  await assert.rejects(() => openaiSubscription.discover(context), /专用 OAuth 授权服务|accessToken/);
});

test("openai subscription: valid access token does not refresh and still uses account id", { timeout: 5000 }, async () => {
  const valid = authJwt('acct-2', Math.floor(NOW.getTime() / 1000) + 3600);
  const { context, calls } = makeContext(
    account('openai-subscription', { baseUrl: 'https://chatgpt.com/backend-api/codex', options: { modelsDev: false } }),
    { accessToken: valid, accountId: 'acct-2' },
    (url) => {
      if (url.includes('/models?')) {
        return json({
          models: [
            {
              slug: 'gpt-test',
              context_window: 272_000,
              max_output_tokens: 128_000,
              input_modalities: ['text'],
              supported_in_api: true,
              supports_parallel_tool_calls: true,
            },
          ],
        });
      }
      throw new Error(`unexpected test URL: ${url}`);
    },
  );
  const result = await openaiSubscription.discover(context);
  assert.equal(result.models.length, 1);
  assert.equal(calls.some((call) => call.url === 'https://auth.openai.com/oauth/token'), false);
});

test("openai subscription: device authorization start, pending poll, token exchange and persistence", { timeout: 5000 }, async () => {
  const access = authJwt('acct-device', Math.floor(NOW.getTime() / 1000) + 3600);
  const idToken = authJwt('acct-device', Math.floor(NOW.getTime() / 1000) + 3600);
  let polls = 0;
  const { context, patches } = makeContext(
    account('openai-subscription', { baseUrl: 'https://chatgpt.com/backend-api/codex', options: { modelsDev: false } }),
    {},
    (url, init) => {
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/usercode') {
        assert.equal(init.method, 'POST');
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert.equal(body.client_id, 'app_EMoamEEZ73f0CkXaXp7hrann');
        return json({ device_auth_id: 'dev-1', user_code: 'USER-CODE', interval: '3' });
      }
      if (url === 'https://auth.openai.com/api/accounts/deviceauth/token') {
        polls += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assert.equal(body.device_auth_id, 'dev-1');
        assert.equal(body.user_code, 'USER-CODE');
        if (polls === 1) return json({ message: 'pending' }, 403);
        return json({ authorization_code: 'code-1', code_challenge: 'challenge', code_verifier: 'verifier' });
      }
      if (url === 'https://auth.openai.com/oauth/token') {
        assert.equal(new Headers(init.headers).get('content-type'), 'application/x-www-form-urlencoded');
        const form = new URLSearchParams(String(init.body));
        assert.equal(form.get('grant_type'), 'authorization_code');
        assert.equal(form.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
        assert.equal(form.get('code'), 'code-1');
        assert.equal(form.get('redirect_uri'), 'https://auth.openai.com/deviceauth/callback');
        assert.equal(form.get('code_verifier'), 'verifier');
        return json({ access_token: access, refresh_token: 'refresh-device', id_token: idToken });
      }
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  const start = await startDeviceAuthorization(context);
  assert.equal(start.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(start.userCode, 'USER-CODE');
  assert.equal(start.deviceAuthId, 'dev-1');
  assert.equal(start.intervalSeconds, 3);
  assert.equal(new Date(start.expiresAt).getTime(), NOW.getTime() + 15 * 60_000);
  assert.equal(Object.keys(context.secrets).length, 0);

  const pending = await pollDeviceAuthorization(context, { deviceAuthId: start.deviceAuthId, userCode: start.userCode });
  assert.equal(pending.state, 'pending');
  assert.equal(context.secrets.accessToken, undefined);

  const complete = await pollDeviceAuthorization(context, {
    deviceAuthId: start.deviceAuthId,
    userCode: start.userCode,
    intervalSeconds: start.intervalSeconds,
  });
  assert.equal(complete.state, 'complete');
  assert.equal(complete.accountId, 'acct-device');
  assert.equal(context.secrets.accessToken, access);
  assert.equal(context.secrets.refreshToken, 'refresh-device');
  assert.equal(context.secrets.accountId, 'acct-device');
  assert.equal(patches.length, 1);
});

test("all plugins: monitor failures do not echo upstream error bodies", { timeout: 5000 }, async () => {
  const leak = 'sk-secret-should-not-appear';
  const cases = [
    (() => {
      const { context } = makeContext(account('realseek'), { accessToken: 'access' }, (url) => {
        if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
        return json({ success: false, message: `upstream body ${leak}` }, 401);
      });
      return realseek.monitor!(context);
    })(),
    (() => {
      const { context } = makeContext(account('deepseek', { baseUrl: 'https://api.deepseek.com' }), { apiKey: 'key' }, () =>
        json({ error: { message: `upstream body ${leak}` } }, 401),
      );
      return deepseek.monitor!(context);
    })(),
    (() => {
      const { context } = makeContext(account('vm2api', { baseUrl: 'https://vm.test' }), { apiKey: 'key' }, () =>
        json({ error: { message: `upstream body ${leak}` } }, 500),
      );
      return vm2api.monitor!(context);
    })(),
    (() => {
      const valid = authJwt('acct-error', Math.floor(NOW.getTime() / 1000) + 3600);
      const { context } = makeContext(
        account('openai-subscription', { baseUrl: 'https://chatgpt.com/backend-api/codex', options: { modelsDev: false } }),
        { accessToken: valid, accountId: 'acct-error' },
        () => json({ error: { message: `upstream body ${leak}` } }, 500),
      );
      return openaiSubscription.monitor!(context);
    })(),
  ];
  for (const monitor of await Promise.all(cases)) {
    assert.equal(monitor.state, 'error');
    assert.equal(monitor.message?.includes(leak), false);
  }
});

test("realseek: removed account group cannot be revived by cached token or secret", { timeout: 5000 }, async () => {
  const localPricing = {
    success: true,
    data: [
      {
        model_name: 'm',
        quota_type: 0,
        model_ratio: 1,
        completion_ratio: 1,
        enable_groups: ['a', 'b'],
        supported_endpoint_types: ['openai'],
        pricing_version: 'p',
      },
    ],
    group_ratio: { a: 1, b: 1 },
    pricing_version: 'p',
  };
  const { context } = makeContext(
    account('realseek', { options: { modelOverrides: { m: { context: 100_000, output: 1_000, tools: true } } } }),
    { accessToken: 'access', 'token:a': 'sk-a', 'token:b': 'sk-b' },
    (url) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(localPricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['a'] });
      if (url.includes('/api/token/?p=1')) return json({ success: true, data: { page: 1, page_size: 100, total: 0, items: [] } });
      throw new Error(`unexpected test URL: ${url}`);
    },
  );
  const result = await realseek.discover(context);
  assert.ok(result.models.some((item) => item.path === 'a/m'));
  assert.equal(result.models.some((item) => item.path === 'b/m'), false);
  assert.match(result.warnings?.join('\n') ?? '', /token\/secret 所在分组不在账号可用分组内/);
});

test("realseek: apiKey fallback uses apiKey credential key, not token:group", { timeout: 5000 }, async () => {
  const localPricing = {
    success: true,
    data: [
      {
        model_name: 'm',
        quota_type: 0,
        model_ratio: 1,
        completion_ratio: 1,
        enable_groups: ['a'],
        supported_endpoint_types: ['openai'],
      },
    ],
    group_ratio: { a: 1 },
  };
  const { context } = makeContext(
    account('realseek', {
      options: {
        apiKeyGroup: 'a',
        modelOverrides: { m: { context: 100_000, output: 1_000, tools: true } },
      },
    }),
    { accessToken: 'access', apiKey: 'sk-api' },
    (url) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(localPricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['a'] });
      if (url.includes('/api/token/?p=1')) return json({ success: true, data: { page: 1, page_size: 100, total: 0, items: [] } });
      throw new Error(`unexpected test URL: ${url}`);
    },
  );
  const result = await realseek.discover(context);
  const item = model(result.models, 'a/m');
  assert.equal(item.enabled, true);
  assert.equal(item.credentialKey, 'apiKey');
  const prepared = await realseek.prepare(context, item, { model: 'client', messages: [] }, 'chat-completions');
  assert.equal(prepared.headers.Authorization, 'Bearer sk-api');
});

test("realseek: unknown price stays callable and estimate is null", { timeout: 5000 }, async () => {
  const localPricing = {
    success: true,
    data: [
      {
        model_name: 'm',
        quota_type: 0,
        model_ratio: 1,
        completion_ratio: 1,
        enable_groups: ['a'],
        supported_endpoint_types: ['openai'],
      },
    ],
    group_ratio: {},
  };
  const { context } = makeContext(
    account('realseek', {
      options: { modelOverrides: { m: { context: 100_000, output: 1_000, tools: true } } },
    }),
    { accessToken: 'access', 'token:a': 'sk-a' },
    (url) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(localPricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['a'] });
      if (url.includes('/api/token/?p=1')) return json({ success: true, data: { page: 1, page_size: 100, total: 0, items: [] } });
      throw new Error(`unexpected test URL: ${url}`);
    },
  );
  const result = await realseek.discover(context);
  const item = model(result.models, 'a/m');
  assert.equal(item.enabled, true);
  assert.equal(item.price.kind, 'unknown');
  assert.equal(item.disabledReason, undefined);
  assert.equal(realseek.estimate?.(item.price, { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 }, {}), null);
  assert.match(result.warnings?.join('\n') ?? '', /价格未知/);
});

test("realseek: explicit token:group is not overwritten and user tokens need explicit opt-in", { timeout: 5000 }, async () => {
  const localPricing = {
    success: true,
    data: [
      {
        model_name: 'm',
        quota_type: 0,
        model_ratio: 1,
        completion_ratio: 1,
        enable_groups: ['a'],
        supported_endpoint_types: ['openai'],
      },
    ],
    group_ratio: { a: 1 },
  };
  const tokens = [{ id: 1, name: 'moris-a', group: 'a', status: 1, key: 'sk-masked****' }];
  const { context, patches } = makeContext(
    account('realseek', {
      tokenTemplate: { namePrefix: 'moris', quota: 1, expiresInDays: 1 },
      options: { modelOverrides: { m: { context: 100_000, output: 1_000, tools: true } } },
    }),
    { accessToken: 'access', 'token:a': 'sk-explicit' },
    (url) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(localPricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['a'] });
      if (url.includes('/api/token/?p=1')) return json({ success: true, data: { page: 1, page_size: 100, total: tokens.length, items: tokens } });
      if (url.includes('/api/token/1/key')) throw new Error('explicit token must not be replaced by managed token reveal');
      throw new Error(`unexpected test URL: ${url}`);
    },
  );
  const result = await realseek.discover(context);
  const item = model(result.models, 'a/m');
  assert.equal(item.enabled, true);
  assert.equal(item.credentialKey, 'token:a');
  assert.equal(context.secrets['token:a'], 'sk-explicit');
  assert.equal(patches.length, 0);
  const prepared = await realseek.prepare(context, item, { model: 'client', messages: [] }, 'chat-completions');
  assert.equal(prepared.headers.Authorization, 'Bearer sk-explicit');

  const userOnly = makeContext(
    account('realseek', { options: { modelOverrides: { m: { context: 100_000, output: 1_000, tools: true } } } }),
    { accessToken: 'access' },
    (url) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(localPricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['a'] });
      if (url.includes('/api/token/?p=1')) return json({ success: true, data: { page: 1, page_size: 100, total: tokens.length, items: tokens } });
      if (url.includes('/api/token/1/key')) return json({ success: true, data: { key: 'sk-user' } });
      throw new Error(`unexpected test URL: ${url}`);
    },
  );
  const withoutOptIn = await realseek.discover(userOnly.context);
  assert.equal(model(withoutOptIn.models, 'a/m').enabled, false);
  assert.match(model(withoutOptIn.models, 'a/m').disabledReason ?? '', /没有可用推理令牌/);
});
