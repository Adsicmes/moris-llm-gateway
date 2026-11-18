import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { decodeCache, encodeCache, hasFreshEntry, CACHE_KEY } from '../packages/opencode-plugin/src/cache.js';
import { businessModelId, isSupplierFresh, normalizeCatalog } from '../packages/opencode-plugin/src/catalog.js';
import { readConfig, gatewayApiBase, gatewayRoot } from '../packages/opencode-plugin/src/config.js';
import type { CatalogModel, CatalogResponse } from '../packages/opencode-plugin/src/contracts.js';
import { fetchCatalog } from '../packages/opencode-plugin/src/gateway.js';
import { install } from '../packages/opencode-plugin/src/install.js';
import { costForModel, modelSpec, modelSpecs, providerInfo, PACKAGE_BY_PROTOCOL } from '../packages/opencode-plugin/src/provider.js';
import { RETRY_HOOK, RETRY_HOOK_OPTIONS, vetoRetry } from '../packages/opencode-plugin/src/retry.js';
import { createService } from '../packages/openchamber-plugin/src/service/app.js';
import { gatewayRoot as serviceGatewayRoot, resolveTarget } from '../packages/openchamber-plugin/src/service/config.js';
import { fetchQuota, normalizeQuota, QuotaError } from '../packages/openchamber-plugin/src/service/gateway.js';
import { parseJsonc } from '../packages/openchamber-plugin/src/service/jsonc.js';
import { createQuotaCache, QUOTA_TTL_MS } from '../packages/openchamber-plugin/src/service/quota-cache.js';
import type { QuotaSummary } from '../packages/openchamber-plugin/src/service/quota.js';
import { buildStatusView, redact } from '../packages/openchamber-plugin/src/service/view.js';

const NOW = Date.parse('2026-11-13T10:00:00.000Z');
const HOUR = 3_600_000;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function modelFixture(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'deepseek/deepseek-flash',
    accountId: 'acc_1',
    namespace: 'deepseek',
    path: 'deepseek/deepseek-flash',
    upstreamModel: 'deepseek-flash',
    name: 'DeepSeek Flash',
    family: 'deepseek',
    protocol: 'chat-completions',
    capabilities: { tools: true, input: ['text'], output: ['text'] },
    limit: { context: 128_000, output: 8_192 },
    variants: {},
    price: { kind: 'token', currency: 'USD', input: 1, output: 2, cacheRead: 0.25, cacheWrite: 1.25 },
    billingType: 'metered',
    enabled: true,
    syncedAt: iso(-HOUR),
    ...overrides,
  };
}

function catalogFixture(models: CatalogModel[]): CatalogResponse {
  return {
    providerID: 'moris',
    fetchedAt: iso(0),
    models,
    accounts: [{ id: 'acc_1', lastSyncedAt: iso(-HOUR), state: 'ok' }],
  };
}

const SPEC_OPTIONS = {
  apiBase: 'https://gateway.example.com/v1',
  apiKey: 'device-secret',
  catalogTtlMs: 86_400_000,
  now: NOW,
  headerTimeoutMs: 120_000,
  chunkTimeoutMs: 90_000,
  requestTimeoutMs: 900_000,
};

function quotaFixture(overrides: Partial<QuotaSummary> = {}): QuotaSummary {
  return {
    accountId: 'acc_1',
    name: 'OpenAI 订阅',
    namespace: 'openai',
    monitor: {
      state: 'ok',
      balances: [{ currency: 'USD', amount: 12.5 }],
      windows: [
        {
          id: 'win_5h',
          name: '5 小时窗口',
          pool: 'openai',
          startsAt: iso(-HOUR),
          resetsAt: iso(4 * HOUR),
          usedRatio: 0.42,
          sampledAt: iso(-10_000),
        },
      ],
      sampledAt: iso(-10_000),
    },
    estimates: [
      {
        windowId: 'win_5h',
        state: 'ok',
        totalUsd: 100,
        remainingUsd: 58,
        spentUsd: 77.77,
        sampledAt: iso(-10_000),
        label: '5 小时窗口',
      },
    ],
    ...overrides,
  };
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => handler(String(input), init)) as typeof fetch;
}

interface FakeInstallEditor {
  added?: { info: { id: string; settings: Record<string, unknown> }; models: Array<Record<string, unknown>> };
  updatedSettings?: Record<string, unknown>;
  setModels?: Array<Record<string, unknown>>;
}

interface FakeEditor extends FakeInstallEditor {
  get: (id: string) => { provider: { settings: Record<string, unknown> }; models: Map<string, { id: string }> } | undefined;
  add: (value: NonNullable<FakeInstallEditor['added']>) => void;
  update: (id: string, update: (provider: { settings: Record<string, unknown> }) => void) => void;
  models: { set: (id: string, models: Array<Record<string, unknown>>) => void };
}

function fakeInstallContext(input: {
  baseUrl: string;
  catalog?: CatalogResponse;
  fetchError?: boolean;
  cache?: CatalogResponse;
  existingModels?: string[];
  existingSettings?: Record<string, unknown>;
  reloadError?: boolean;
}) {
  const transforms: Array<(editor: FakeEditor) => void> = [];
  const hooks: Array<{ name: string; options: unknown }> = [];
  const storage = new Map<string, unknown>();
  const calls = { reload: 0, get: [] as string[], update: [] as string[], set: [] as string[] };
  const disposals: string[] = [];
  if (input.cache !== undefined) storage.set('catalog/moris/v1', encodeCache(input.cache, iso(0)));

  const editor: FakeEditor = {
    get(id: string) {
      calls.get.push(id);
      if (id !== 'moris' || input.existingModels === undefined) return undefined;
      return {
        provider: { settings: { ...(input.existingSettings ?? {}) } },
        models: new Map(input.existingModels.map((modelID) => [modelID, { id: modelID }])),
      };
    },
    add(value) {
      this.added = value;
    },
    update(id, update) {
      calls.update.push(id);
      const provider = { settings: { ...(input.existingSettings ?? {}) } };
      update(provider);
      this.updatedSettings = provider.settings;
    },
    models: {
      set(id, models) {
        calls.set.push(id);
        editor.setModels = models;
      },
    },
  };

  const ctx = {
    options: {
      baseUrl: input.baseUrl,
      apiKey: 'device-secret',
      refreshIntervalMs: 300_000,
    },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value);
      },
    },
    provider: {
      transform: async (callback: (editor: FakeEditor) => void) => {
        transforms.push(callback);
        return { dispose: async () => { disposals.push('transform'); } };
      },
      reload: async () => {
        calls.reload += 1;
        if (input.reloadError === true) throw new Error('reload failed');
      },
    },
    session: {
      hook: async (name: string, _callback: unknown, options: unknown) => {
        hooks.push({ name, options });
        return { dispose: async () => { disposals.push('hook'); } };
      },
    },
  };

  const fetchImpl = fakeFetch(() => {
    if (input.fetchError === true) throw new Error('network down');
    return new Response(JSON.stringify(input.catalog ?? catalogFixture([modelFixture()])), { status: 200 });
  });

  return { ctx, editor, calls, hooks, transforms, storage, disposals, fetchImpl };
}

function readRepoJson(relative: string): Record<string, unknown> {
  const path = fileURLToPath(new URL(`../${relative}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

test('OpenCode: each protocol selects its own runtime package', () => {
  assert.equal(modelSpec(modelFixture({ protocol: 'chat-completions' }), SPEC_OPTIONS).package, PACKAGE_BY_PROTOCOL['chat-completions']);
  assert.equal(modelSpec(modelFixture({ protocol: 'responses' }), SPEC_OPTIONS).package, '@opencode/ai/providers/openai-compatible/responses');
  assert.equal(modelSpec(modelFixture({ protocol: 'messages' }), SPEC_OPTIONS).package, '@opencode/ai/providers/anthropic-compatible');

  const unknown = modelSpec(modelFixture({ protocol: 'unknown' }), SPEC_OPTIONS);
  assert.equal(unknown.enabled, false, 'an unknown protocol must not be routed as chat');
});

test('OpenCode: provider info disables WebSocket, skips credential resolution and keeps the key off the provider object', () => {
  const info = providerInfo({ apiBase: 'https://gateway.example.com/v1', headerTimeoutMs: 1, chunkTimeoutMs: 2, requestTimeoutMs: 3 });
  assert.equal(info.id, 'moris');
  assert.equal(info.settings.transport, 'http');
  assert.equal(info.settings.baseURL, 'https://gateway.example.com/v1');
  // `false` is what keeps the responses-protocol models usable: OpenCode only
  // drops its credential requirement on its own for allowlisted packages, and
  // `openai-compatible/responses` is not listed.
  assert.equal(info.settings.apiKey, false);
  assert.equal(JSON.stringify(info).includes('device-secret'), false);
});

test('OpenCode: the device key travels on model headers, never in the cache', () => {
  const spec = modelSpec(modelFixture(), SPEC_OPTIONS);
  assert.equal(spec.headers.Authorization, 'Bearer device-secret');
  assert.equal(spec.modelID, 'deepseek/deepseek-flash');

  const cache = encodeCache(catalogFixture([modelFixture()]), iso(0));
  const serialized = JSON.stringify(cache);
  assert.equal(serialized.includes('device-secret'), false);
  assert.equal(serialized.includes('gateway.example.com'), false);
  assert.equal(serialized.includes('Authorization'), false);
  assert.equal(CACHE_KEY, 'catalog/moris/v1');

  const decoded = decodeCache(JSON.parse(serialized));
  assert.ok(decoded);
  assert.equal(decoded.catalog.models.length, 1);
});

test('OpenCode: business ids drop the provider prefix and reject unusable ids', () => {
  assert.equal(businessModelId('moris/openai/gpt-6.1-sol'), 'openai/gpt-6.1-sol');
  assert.equal(businessModelId('openai/gpt-6.1-sol'), 'openai/gpt-6.1-sol');
  assert.equal(businessModelId('openai/bad#id'), null);
  assert.equal(businessModelId('bad id'), null);
  assert.equal(businessModelId(''), null);
});

test('OpenCode: catalog normalization rejects a foreign provider id and duplicate models', () => {
  const foreign = normalizeCatalog({ providerID: 'openai', models: [modelFixture()], fetchedAt: iso(0), accounts: [] });
  assert.equal(foreign, null);
  const body = catalogFixture([modelFixture(), modelFixture()]);
  const normalized = normalizeCatalog(body);
  assert.ok(normalized);
  assert.equal(normalized.models.length, 1);
  const badProtocol = normalizeCatalog({ ...body, models: [modelFixture({ protocol: 'grpc' as never })] });
  assert.ok(badProtocol);
  assert.equal(badProtocol.models[0]?.protocol, 'unknown');
});

test('OpenCode: subscription cost is zero; full token price maps; unexpressible prices stay callable with cost []', () => {
  const subscription = costForModel(modelFixture({ billingType: 'subscription', price: { kind: 'complex', currency: 'USD', expression: 'x*2' } }));
  assert.equal(subscription.mode, 'zero');
  assert.deepEqual(subscription.cost, [{ input: 0, output: 0, cache: { read: 0, write: 0 } }]);

  const token = costForModel(modelFixture());
  assert.equal(token.mode, 'priced');
  assert.deepEqual(token.cost, [{ input: 1, output: 2, cache: { read: 0.25, write: 1.25 } }]);

  // No cache amounts: do not invent a fallback from the input price.
  const noCache = costForModel(modelFixture({ price: { kind: 'token', currency: 'USD', input: 3, output: 4 } }));
  assert.equal(noCache.mode, 'unexpressed');
  assert.deepEqual(noCache.cost, []);
  const noCacheModel = modelSpec(modelFixture({ price: { kind: 'token', currency: 'USD', input: 3, output: 4 } }), SPEC_OPTIONS);
  assert.equal(noCacheModel.enabled, true, 'a missing cache price must not hide the model');
  assert.deepEqual(noCacheModel.cost, []);
  assert.match(noCacheModel.name, /价格见网关/);

  for (const price of [
    { kind: 'complex' as const, currency: 'USD' as const, expression: 'tiered' },
    { kind: 'request' as const, currency: 'USD' as const, perRequest: 0.02 },
    { kind: 'unknown' as const, currency: 'USD' as const },
    { kind: 'token' as const, currency: 'CNY' as const, input: 1, output: 2, cacheRead: 1, cacheWrite: 1 },
  ]) {
    const verdict = costForModel(modelFixture({ price }));
    assert.equal(verdict.mode, 'unexpressed', `${price.kind}/${price.currency} has no SDK price representation`);
    assert.deepEqual(verdict.cost, [], 'no zero or Infinity is fabricated');
    const spec = modelSpec(modelFixture({ price }), SPEC_OPTIONS);
    assert.equal(spec.enabled, true, `${price.kind}/${price.currency} must stay callable`);
    assert.deepEqual(spec.cost, []);
    assert.match(spec.name, /价格见网关/);
  }
});

test('OpenCode: supplier syncedAt TTL gates models and a fresh cache write cannot revive them', () => {
  const fresh = modelFixture({ syncedAt: iso(-23 * HOUR) });
  assert.equal(isSupplierFresh(fresh, NOW, SPEC_OPTIONS.catalogTtlMs), true);
  assert.equal(modelSpec(fresh, SPEC_OPTIONS).enabled, true);

  const expired = modelFixture({ syncedAt: iso(-25 * HOUR) });
  assert.equal(isSupplierFresh(expired, NOW, SPEC_OPTIONS.catalogTtlMs), false);
  assert.equal(modelSpec(expired, SPEC_OPTIONS).enabled, false);

  // Cached "now", supplier synced 25 h ago: the local write must not extend it.
  const cache = decodeCache(encodeCache(catalogFixture([expired]), iso(0)));
  assert.ok(cache);
  assert.equal(modelSpecs(cache.catalog.models, SPEC_OPTIONS)[0]?.enabled, false);
  assert.equal(hasFreshEntry(cache.catalog, NOW, SPEC_OPTIONS.catalogTtlMs), false);
  assert.equal(hasFreshEntry(catalogFixture([fresh]), NOW, SPEC_OPTIONS.catalogTtlMs), true);
});

test('OpenCode: a failed refresh keeps the last successful catalog; only expired entries go dark', () => {
  const lastGood = catalogFixture([modelFixture({ id: 'fresh', path: 'fresh', syncedAt: iso(-2 * HOUR) }), modelFixture({ id: 'old', path: 'old', syncedAt: iso(-30 * HOUR) })]);
  const decoded = decodeCache(encodeCache(lastGood, iso(-HOUR)));
  assert.ok(decoded);
  const specs = modelSpecs(decoded.catalog.models, SPEC_OPTIONS);
  assert.equal(specs.find((spec) => spec.id === 'fresh')?.enabled, true);
  assert.equal(specs.find((spec) => spec.id === 'old')?.enabled, false);
});

test('OpenCode: retry is vetoed for moris only, for every request kind', () => {
  assert.equal(RETRY_HOOK, 'retry');
  assert.deepEqual(RETRY_HOOK_OPTIONS, { providerID: 'moris' });

  const moris = { model: { providerID: 'moris' }, decision: { retry: true, delay: 500 } as { retry: false } | { retry: true; delay: number } };
  assert.equal(vetoRetry(moris), true);
  assert.deepEqual(moris.decision, { retry: false });

  const openai = { model: { providerID: 'openai' }, decision: { retry: true, delay: 500 } as { retry: false } | { retry: true; delay: number } };
  assert.equal(vetoRetry(openai), false);
  assert.deepEqual(openai.decision, { retry: true, delay: 500 }, 'another provider keeps OpenCode’s decision');

  // The hook event has no `kind`: provider scoping is what covers primary,
  // title, compaction and generate.
  const title = { model: { providerID: 'moris' }, decision: { retry: true, delay: 0 } as { retry: false } | { retry: true; delay: number } };
  vetoRetry(title);
  assert.deepEqual(title.decision, { retry: false });
});

test('OpenCode install: first start without a cache replays the fetched catalog', async () => {
  const harness = fakeInstallContext({
    baseUrl: 'https://gw.test/v1',
    catalog: catalogFixture([modelFixture({ id: 'sync/one', path: 'sync/one', protocol: 'responses' })]),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetchImpl;
  try {
    const cleanup = await install(harness.ctx as never);
    assert.equal(harness.calls.reload, 1, 'the first catalog is replayed through provider.reload()');
    harness.transforms[0]?.(harness.editor);
    assert.equal(harness.editor.added?.info.id, 'moris');
    assert.equal(harness.editor.added?.info.settings.transport, 'http');
    assert.deepEqual((harness.editor.added?.models ?? []).map((model) => model.id), ['sync/one']);
    assert.equal(harness.editor.added?.models[0]?.package, PACKAGE_BY_PROTOCOL.responses);
    assert.equal(harness.hooks.length, 1);
    assert.deepEqual(harness.hooks[0]?.options, { providerID: 'moris' });
    await cleanup();
    assert.deepEqual(harness.disposals.sort(), ['hook', 'transform']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenCode install: the moris namespace is fully gateway-managed and its settings are reconciled', async () => {
  const harness = fakeInstallContext({
    baseUrl: 'https://gw.test/v1',
    catalog: catalogFixture([modelFixture({ id: 'sync/new', path: 'sync/new' })]),
    existingModels: ['sync/removed-by-upstream', 'user/moris-extra'],
    existingSettings: { baseURL: 'https://old.example/v1', transport: 'websocket', headerTimeout: 1, custom: 'keep' },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetchImpl;
  try {
    const cleanup = await install(harness.ctx as never);
    harness.transforms[0]?.(harness.editor);
    assert.deepEqual(harness.calls.update, ['moris'], 'only the moris provider is updated');
    assert.deepEqual(harness.calls.set, ['moris'], 'only the moris inventory is replaced');
    assert.equal(harness.editor.added, undefined);
    assert.equal(harness.editor.updatedSettings?.baseURL, 'https://gw.test/v1');
    assert.equal(harness.editor.updatedSettings?.transport, 'http');
    assert.equal(harness.editor.updatedSettings?.headerTimeout, 120_000);
    assert.equal(harness.editor.updatedSettings?.custom, 'keep', 'unrelated user settings are preserved');
    assert.deepEqual((harness.editor.setModels ?? []).map((model) => model.id), ['sync/new'], 'an upstream removal disappears');
    await cleanup();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenCode install: a failed first read still reloads and never rejects the plugin', async () => {
  const harness = fakeInstallContext({ baseUrl: 'https://gw.test/v1', fetchError: true, reloadError: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetchImpl;
  try {
    const cleanup = await install(harness.ctx as never);
    assert.equal(harness.calls.reload, 1, 'the empty inventory is replayed after the failure too');
    harness.transforms[0]?.(harness.editor);
    assert.equal(harness.editor.added?.info.id, 'moris');
    assert.deepEqual(harness.editor.added?.models, []);
    await cleanup();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenCode install: a cached start keeps the last catalog and survives a failing refresh', async () => {
  const cached = catalogFixture([modelFixture({ id: 'cached/model', path: 'cached/model', syncedAt: iso(-HOUR) })]);
  const harness = fakeInstallContext({ baseUrl: 'https://gw.test/v1', cache: cached, fetchError: true, reloadError: true });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = harness.fetchImpl;
  try {
    const cleanup = await install(harness.ctx as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(harness.calls.reload >= 1, 'the failed background refresh still triggers a replay');
    harness.transforms[0]?.(harness.editor);
    const models = harness.editor.added?.models ?? [];
    assert.deepEqual(models.map((model) => model.id), ['cached/model']);
    assert.equal(models[0]?.enabled, true);
    await cleanup();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OpenCode: catalog client sends the bearer and rejects wrong contracts', async () => {
  let authorization = '';
  const ok = await fetchCatalog({
    rootUrl: 'https://gateway.example.com',
    apiKey: 'device-secret',
    timeoutMs: 1000,
    fetchImpl: fakeFetch((url, init) => {
      authorization = String((init?.headers as Record<string, string>).Authorization);
      assert.equal(url, 'https://gateway.example.com/api/catalog');
      return new Response(JSON.stringify(catalogFixture([modelFixture()])), { status: 200 });
    }),
  });
  assert.equal(ok.ok, true);
  assert.equal(authorization, 'Bearer device-secret');

  const denied = await fetchCatalog({
    rootUrl: 'https://gateway.example.com',
    apiKey: 'device-secret',
    timeoutMs: 1000,
    fetchImpl: fakeFetch(() => new Response('upstream secret body', { status: 401 })),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? '', /401/);
  assert.equal((denied.error ?? '').includes('upstream secret body'), false);

  const wrong = await fetchCatalog({
    rootUrl: 'https://gateway.example.com',
    apiKey: 'device-secret',
    timeoutMs: 1000,
    fetchImpl: fakeFetch(() => new Response(JSON.stringify({ providerID: 'other', models: [] }), { status: 200 })),
  });
  assert.equal(wrong.ok, false);
});

test('OpenCode: plugin options normalize the gateway URL and honour the five-minute default', () => {
  const config = readConfig({ baseUrl: 'https://gateway.example.com/v1/' }, { MORIS_GATEWAY_KEY: 'env-key' });
  assert.equal(config.ok, true);
  if (!config.ok) return;
  assert.equal(config.value.rootUrl, 'https://gateway.example.com');
  assert.equal(config.value.apiBase, 'https://gateway.example.com/v1');
  assert.equal(config.value.apiKey, 'env-key');
  assert.equal(config.value.refreshMs, 300_000);
  assert.equal(config.value.catalogTtlMs, 86_400_000);
  assert.equal(config.value.fetchTimeoutMs, 15_000);

  const tooFast = readConfig({ baseUrl: 'https://gateway.example.com', refreshIntervalMs: 1000 });
  assert.equal(tooFast.ok, true);
  if (tooFast.ok) assert.equal(tooFast.value.refreshMs, 300_000, 'refresh is floored, never faster than one minute');

  const missing = readConfig({});
  assert.equal(missing.ok, false);
  assert.equal(JSON.stringify(missing).includes('device-secret'), false);

  assert.equal(gatewayRoot('https://x.example/v1'), 'https://x.example');
  assert.equal(gatewayApiBase('https://x.example/v1'), 'https://x.example/v1');
  assert.equal(gatewayApiBase('https://x.example'), 'https://x.example/v1');
});

test('OpenChamber: manifest is a loadable status-source package', () => {
  const pkg = readRepoJson('packages/openchamber-plugin/package.json');
  const openchamber = pkg.openchamber as Record<string, unknown>;
  const contributes = openchamber.contributes as Record<string, unknown>;
  const statusSection = contributes.statusSection as { source?: { path?: string; interval?: number }; entry?: string };
  const service = contributes.service as { entry?: string; runtime?: string };
  const panel = contributes.panel as { id?: string; entry?: string };
  assert.equal(openchamber.apiVersion, 1);
  assert.equal((openchamber.engines as { openchamber?: string }).openchamber, '>=2.7.1');
  assert.equal(panel.id, 'moris-gateway');
  assert.equal(panel.entry, undefined, 'a source-only section needs no iframe page');
  assert.equal(statusSection.entry, undefined, 'the section has no frame of its own either');
  assert.equal(statusSection.source?.path, '/status');
  assert.equal(statusSection.source?.interval, 60_000);
  assert.equal(service.runtime, 'host');
  assert.equal(typeof service.entry, 'string');
  const entry = fileURLToPath(new URL(`../packages/openchamber-plugin/${service.entry}`, import.meta.url));
  assert.equal(existsSync(entry), true, 'the service entry is built JS inside the package');

  const opencodePkg = readRepoJson('packages/opencode-plugin/package.json');
  assert.equal((opencodePkg.dependencies as Record<string, string>)['@opencode/plugin'], '2.2.7');
  const exportsField = opencodePkg.exports as Record<string, { types?: string; import?: string }>;
  assert.equal(exportsField['.']?.import, './build/index.js', 'exports point at the built artifact');
  assert.equal(exportsField['.']?.types, './build/index.d.ts');
  assert.deepEqual(opencodePkg.files, ['build', 'README.md']);
  const opencodeEntry = fileURLToPath(new URL('../packages/opencode-plugin/build/index.js', import.meta.url));
  assert.equal(existsSync(opencodeEntry), true, 'the OpenCode plugin build output exists');
});

test('OpenChamber: only balance, window, estimate and freshness are rendered', () => {
  const view = buildStatusView({ read: { items: [quotaFixture()], readAt: NOW - 5_000, error: null, stale: false }, now: NOW });
  const texts = JSON.stringify(view);
  assert.equal(texts.includes('device-secret'), false);
  assert.equal(texts.includes('gateway.example.com'), false);
  assert.equal(texts.includes('77.77'), false, 'spend is not part of this section');
  assert.equal(texts.includes('实付'), false);

  const balance = view.rows.find((row) => row.kind === 'line' && row.id === 'balance-0-0');
  assert.ok(balance && balance.kind === 'line');
  assert.match(balance.value ?? '', /\$12\.50/);
  assert.match(balance.label, /USD/);

  const window = view.rows.find((row) => row.kind === 'line' && row.id === 'window-0-0');
  assert.ok(window && window.kind === 'line');
  assert.ok(window.content && window.content.kind === 'bar');
  assert.equal(window.content.value, 42);
  assert.match(window.value ?? '', /42%/);
  assert.match(window.value ?? '', /重置/);

  const estimate = view.rows.find((row) => row.kind === 'line' && row.id === 'estimate-0-0');
  assert.ok(estimate && estimate.kind === 'line');
  assert.match(estimate.label, /估算/);
  assert.match(estimate.value ?? '', /总额 \$100\.00/);
  assert.match(estimate.value ?? '', /剩余 \$58\.00/);

  const updated = view.rows.find((row) => row.kind === 'line' && row.id === 'updated');
  assert.ok(updated && updated.kind === 'line');
  assert.equal(updated.label, '数据更新时间');
  assert.ok(view.rows.some((row) => row.kind === 'note' && row.id === 'scope'));
});

test('OpenChamber: unknown, error, stale and old samples are distinguishable', () => {
  const unknown = quotaFixture();
  unknown.monitor.state = 'unknown';
  const unknownView = buildStatusView({ read: { items: [unknown], readAt: NOW, error: null, stale: false }, now: NOW });
  const unknownRow = unknownView.rows.find((row) => row.kind === 'line' && row.id === 'updated');
  assert.ok(unknownRow && unknownRow.kind === 'line');
  assert.deepEqual(unknownRow.content, { kind: 'text', text: '未知', tone: 'muted' });

  const failed = quotaFixture();
  failed.monitor.state = 'error';
  const failedView = buildStatusView({ read: { items: [failed], readAt: NOW, error: null, stale: false }, now: NOW });
  const failedRow = failedView.rows.find((row) => row.kind === 'line' && row.id === 'updated');
  assert.ok(failedRow && failedRow.kind === 'line');
  assert.deepEqual(failedRow.content, { kind: 'text', text: '获取失败', tone: 'error' });

  const old = quotaFixture();
  old.monitor.sampledAt = iso(-10 * 60_000);
  old.monitor.windows[0]!.sampledAt = iso(-10 * 60_000);
  const oldView = buildStatusView({ read: { items: [old], readAt: NOW, error: null, stale: false }, now: NOW });
  const oldRow = oldView.rows.find((row) => row.kind === 'line' && row.id === 'updated');
  assert.ok(oldRow && oldRow.kind === 'line');
  assert.deepEqual(oldRow.content, { kind: 'text', text: '过期', tone: 'warning' });

  const staleView = buildStatusView({
    read: { items: [quotaFixture()], readAt: NOW - 120_000, error: '无法连接网关', stale: true },
    now: NOW,
  });
  const staleRow = staleView.rows.find((row) => row.kind === 'line' && row.id === 'updated');
  assert.ok(staleRow && staleRow.kind === 'line');
  assert.equal((staleRow.content as { text?: string }).text, '过期');
  assert.ok(staleView.rows.some((row) => row.kind === 'note' && row.id === 'read-error' && row.tone === 'error'));
  assert.ok(staleView.rows.some((row) => row.kind === 'line' && row.id === 'balance-0-0'), 'last data stays visible');
  assert.equal(redact('x Bearer abc.def y'), 'x Bearer [redacted] y');
});

test('OpenChamber: the service cache is one upstream read per 60 s, shared by concurrent callers', async () => {
  assert.equal(QUOTA_TTL_MS, 60_000);
  let now = NOW;
  let calls = 0;
  const cache = createQuotaCache({
    ttlMs: 60_000,
    now: () => now,
    load: async () => {
      calls += 1;
      return [quotaFixture()];
    },
  });
  assert.equal((await cache.read()).items?.length, 1);
  assert.equal(calls, 1);
  now += 59_000;
  await cache.read();
  assert.equal(calls, 1);
  now += 2_000;
  await cache.read();
  assert.equal(calls, 2);

  let resolve: ((items: QuotaSummary[]) => void) | null = null;
  let slowCalls = 0;
  const slow = createQuotaCache({
    now: () => NOW,
    load: () => {
      slowCalls += 1;
      return new Promise<QuotaSummary[]>((done) => {
        resolve = done;
      });
    },
  });
  const first = slow.read();
  const second = slow.read();
  assert.equal(slowCalls, 1, 'concurrent clients share one upstream request');
  assert.ok(resolve);
  (resolve as (items: QuotaSummary[]) => void)([quotaFixture()]);
  await Promise.all([first, second]);
});

test('OpenChamber: a failed read keeps the last values and marks them stale, never zero', async () => {
  let now = NOW;
  let fail = false;
  const cache = createQuotaCache({
    ttlMs: 60_000,
    now: () => now,
    load: async () => {
      if (fail) throw new Error('网关额度请求失败（HTTP 500）');
      return [quotaFixture()];
    },
  });
  await cache.read();
  now += 61_000;
  fail = true;
  const stale = await cache.read();
  assert.equal(stale.stale, true);
  assert.equal(stale.items?.length, 1);
  assert.match(stale.error ?? '', /500/);
  assert.equal(stale.items?.[0]?.monitor.balances[0]?.amount, 12.5);

  const empty = createQuotaCache({ load: async () => { throw new Error('无法连接网关'); } });
  const none = await empty.read();
  assert.equal(none.items, null);
  assert.equal(none.error, '无法连接网关');
});

test('OpenChamber: an account with no sample yet is kept as unknown', () => {
  const items = normalizeQuota({
    items: [
      {
        accountId: 'acc_new',
        name: '新账号',
        namespace: 'openai',
        monitor: { state: 'unknown', balances: [], windows: [], sampledAt: '' },
        estimates: [],
      },
    ],
  });
  assert.ok(items);
  assert.equal(items.length, 1, 'sampledAt "" must not drop the account');
  assert.equal(items[0]?.monitor.state, 'unknown');
  assert.equal(items[0]?.monitor.sampledAt, '');

  const view = buildStatusView({
    read: { items, readAt: NOW, error: null, stale: false },
    now: NOW,
  });
  const updated = view.rows.find((row) => row.kind === 'line' && row.id === 'updated');
  assert.ok(updated && updated.kind === 'line');
  assert.deepEqual(updated.content, { kind: 'text', text: '未知', tone: 'muted' });
  assert.ok(view.rows.length <= 16);
  assert.equal(view.rows.some((row) => row.kind === 'note' && row.id === 'read-error'), false);
});

test('OpenChamber: quota client rejects HTTP errors without echoing the body', async () => {
  const items = await fetchQuota({
    rootUrl: 'https://gateway.example.com',
    apiKey: 'device-secret',
    timeoutMs: 1000,
    fetchImpl: fakeFetch((url, init) => {
      assert.equal(url, 'https://gateway.example.com/api/quota');
      assert.equal(String((init?.headers as Record<string, string>).Authorization), 'Bearer device-secret');
      return new Response(JSON.stringify({ items: [quotaFixture()] }), { status: 200 });
    }),
  });
  assert.equal(items.length, 1);

  await assert.rejects(
    fetchQuota({
      rootUrl: 'https://gateway.example.com',
      apiKey: 'device-secret',
      timeoutMs: 1000,
      fetchImpl: fakeFetch(() => new Response('secret upstream body', { status: 500 })),
    }),
    (error: unknown) => error instanceof QuotaError && !error.message.includes('secret upstream body'),
  );
});

test('OpenChamber: config discovery reads the OpenCode plugin options and keeps the key in the service', async () => {
  const home = join('C:\\', 'moris-home');
  const files = new Map<string, string>();
  const readText = async (path: string): Promise<string | null> => files.get(path) ?? null;
  const env = {
    home,
    dataDir: undefined as string | undefined,
    vars: { MORIS_DEVICE_KEY: 'device-secret' } as Record<string, string | undefined>,
  };
  const configPath = join(home, '.config', 'opencode', 'opencode.jsonc');
  files.set(
    configPath,
    `{
      // Moris gateway plugin
      "plugins": [{ "package": "@moris/opencode-plugin", "options": { "baseUrl": "https://gateway.example.com/v1", "apiKey": "{env:MORIS_DEVICE_KEY}" } }],
    }`,
  );
  const target = await resolveTarget(null, { readText, env });
  assert.equal(target.ok, true);
  if (!target.ok) return;
  assert.equal(target.target.rootUrl, 'https://gateway.example.com');
  assert.equal(target.target.apiKey, 'device-secret');
  assert.equal(serviceGatewayRoot('https://gateway.example.com/v1/'), 'https://gateway.example.com');

  const none = await resolveTarget(null, { readText: async () => null, env: { home, vars: {} } });
  assert.equal(none.ok, false);
  assert.match(none.message, /moris/);

  files.set(join(home, '.config', 'opencode', 'opencode.json'), '{ "providers": { "moris": { "settings": { "baseURL": "https://gw.example/v1", "apiKey": "k" } } } }');
  files.delete(configPath);
  const providerTarget = await resolveTarget(null, { readText, env: { home, vars: {} } });
  assert.equal(providerTarget.ok, true);
  if (providerTarget.ok) assert.equal(providerTarget.target.apiKey, 'k');

  const dataDir = join('C:\\', 'srv', 'openchamber', 'data', 'ext-moris-gateway');
  files.set(join(dataDir, 'config.json'), JSON.stringify({ baseUrl: 'https://explicit.example', apiKey: 'explicit-key' }));
  const explicit = await resolveTarget(null, { readText, env: { home, dataDir, vars: {} } });
  assert.equal(explicit.ok, true);
  if (explicit.ok) assert.equal(explicit.target.source, 'service-config');
});

test('OpenChamber: JSONC parsing handles comments and trailing commas', () => {
  const parsed = parseJsonc('{\n  // comment\n  "a": [1, 2,],\n  /* block */\n  "b": "// not a comment",\n}') as Record<string, unknown>;
  assert.deepEqual(parsed, { a: [1, 2], b: '// not a comment' });
  assert.throws(() => parseJsonc('{ "a": }'));
});

test('OpenChamber: a read with no config reports failure, not a zero balance', () => {
  const view = buildStatusView({
    read: { items: null, readAt: null, error: '未找到 moris 网关配置。', stale: false },
    now: NOW,
  });
  const updated = view.rows.find((row) => row.kind === 'line' && row.id === 'updated');
  assert.ok(updated && updated.kind === 'line');
  assert.deepEqual(updated.content, { kind: 'text', text: '获取失败', tone: 'error' });
  assert.equal(view.rows.some((row) => row.kind === 'line' && row.id.startsWith('balance-')), false);
  assert.ok(view.rows.some((row) => row.kind === 'note' && row.id === 'read-error'));
  assert.ok(view.rows.length <= 16);
});

test('OpenChamber: multiple accounts carry their own state badge', () => {
  const failed = quotaFixture();
  failed.accountId = 'acc_2';
  failed.name = 'DeepSeek';
  failed.monitor.state = 'error';
  const view = buildStatusView({
    read: { items: [quotaFixture(), failed], readAt: NOW, error: null, stale: false },
    now: NOW,
  });
  const first = view.rows.find((row) => row.kind === 'line' && row.id === 'balance-0-0');
  assert.ok(first && first.kind === 'line');
  assert.deepEqual(first.badge, { label: '正常', tone: 'success' });
  const second = view.rows.find((row) => row.kind === 'line' && row.id === 'balance-1-0');
  assert.ok(second && second.kind === 'line');
  assert.deepEqual(second.badge, { label: '获取失败', tone: 'error' });
});

test('OpenChamber: the loopback service enforces its bearer and serves rows over HTTP', async () => {
  const dataDir = join('C:\\', 'data');
  const files = new Map<string, string>();
  files.set(
    join(dataDir, 'config.json'),
    JSON.stringify({ baseUrl: 'https://gateway.example.com', apiKey: 'device-secret' }),
  );
  let upstreamCalls = 0;
  const server = createServer(
    createService({
      token: 'host-token',
      env: { home: join('C:\\', 'moris-home'), dataDir, vars: {} },
      readText: async (path) => files.get(path) ?? null,
      fetchImpl: fakeFetch(() => {
        upstreamCalls += 1;
        return new Response(JSON.stringify({ items: [quotaFixture()] }), { status: 200 });
      }),
      now: () => NOW,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.equal((await fetch(`${base}/status`)).status, 401);
    const health = await fetch(`${base}/health`, { headers: { authorization: 'Bearer host-token' } });
    assert.equal(health.status, 200);

    const first = await fetch(`${base}/status?directory=%2Fproject`, { headers: { authorization: 'Bearer host-token' } });
    assert.equal(first.status, 200);
    const body = (await first.json()) as { rows: Array<{ kind: string; id: string }> };
    assert.ok(body.rows.some((row) => row.id === 'balance-0-0'));
    assert.equal(JSON.stringify(body).includes('device-secret'), false);

    const second = await fetch(`${base}/status?directory=%2Fproject`, { headers: { authorization: 'Bearer host-token' } });
    assert.equal(second.status, 200);
    assert.equal(upstreamCalls, 1, 'two sections in the same directory within 60 s share one gateway read');

    const post = await fetch(`${base}/status`, { method: 'POST', headers: { authorization: 'Bearer host-token' } });
    assert.equal(post.status, 405);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('OpenChamber: two directories never share config, quota or cache', async () => {
  const dirA = join('C:\\', 'proj-a');
  const dirB = join('C:\\', 'proj-b');
  const files = new Map<string, string>();
  files.set(
    join(dirA, 'opencode.json'),
    JSON.stringify({ providers: { moris: { settings: { baseURL: 'https://a.test/v1', apiKey: 'key-a' } } } }),
  );
  files.set(
    join(dirB, 'opencode.json'),
    JSON.stringify({ providers: { moris: { settings: { baseURL: 'https://b.test/v1', apiKey: 'key-b' } } } }),
  );

  const calls: string[] = [];
  const itemFor = (amount: number) => {
    const item = quotaFixture();
    item.monitor.balances = [{ currency: 'USD', amount }];
    item.monitor.windows = [];
    item.estimates = [];
    return item;
  };
  const server = createServer(
    createService({
      token: 'host-token',
      env: { home: join('C:\\', 'moris-home'), vars: {} },
      readText: async (path) => files.get(path) ?? null,
      fetchImpl: fakeFetch((url) => {
        calls.push(url);
        const amount = url.startsWith('https://a.test/') ? 1 : 2;
        return new Response(JSON.stringify({ items: [itemFor(amount)] }), { status: 200 });
      }),
      now: () => NOW,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { authorization: 'Bearer host-token' };
  const statusFor = async (directory: string) =>
    (await fetch(`${base}/status?directory=${encodeURIComponent(directory)}`, { headers })).json() as Promise<{ rows: Array<{ kind: string; id: string; value?: string }> }>;
  try {
    const [a, b] = await Promise.all([statusFor(dirA), statusFor(dirB)]);
    const aText = JSON.stringify(a);
    const bText = JSON.stringify(b);
    assert.match(aText, /\$1\.00/);
    assert.equal(aText.includes('$2.00'), false);
    assert.match(bText, /\$2\.00/);
    assert.equal(bText.includes('$1.00'), false);
    assert.equal(calls.length, 2, 'each directory loads its own gateway');
    assert.ok(calls.some((url) => url.startsWith('https://a.test/')));

    const again = await statusFor(dirA);
    assert.match(JSON.stringify(again), /\$1\.00/);
    assert.equal(calls.length, 2, 'the per-directory cache still deduplicates within 60 s');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
