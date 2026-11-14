import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ManagedResource,
  ManagedResourceInput,
  ProviderAccount,
  ProviderContext,
} from '@moris/provider-sdk';
import { credentialFingerprint } from '@moris/provider-sdk';
import realseek from '../packages/providers/realseek/src/index.js';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const ROOT = 'https://newapi.example.com';
const SCOPE = `newapi:${ROOT}#user:7`;

interface Call {
  url: string;
  init: RequestInit;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    id: 'account-1',
    namespace: 'realseek',
    name: 'test account',
    plugin: 'realseek',
    baseUrl: ROOT,
    billingType: 'metered',
    enabled: true,
    autoCreateTokens: false,
    options: { modelOverrides: { m: { context: 100_000, output: 1_000, tools: true } } },
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

const pricing = {
  success: true,
  data: [
    {
      model_name: 'm',
      quota_type: 0,
      model_ratio: 1,
      completion_ratio: 1,
      enable_groups: ['group-c'],
      supported_endpoint_types: ['openai'],
    },
  ],
  group_ratio: { 'group-c': 1 },
};

function managedResource(overrides: Partial<ManagedResource> = {}): ManagedResource {
  return {
    kind: 'token',
    scope: SCOPE,
    externalId: '51',
    name: 'moris-group-c',
    group: 'group-c',
    fingerprint: credentialFingerprint('sk-trusted'),
    provenance: 'created',
    credentialKey: 'token:group-c',
    id: 'resource-1',
    plugin: 'realseek',
    accountIds: ['account-1'],
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function resourceInput(overrides: Partial<ManagedResourceInput> = {}): ManagedResourceInput {
  return {
    kind: 'token',
    scope: SCOPE,
    externalId: '81',
    name: 'moris-group-c',
    group: 'group-c',
    fingerprint: credentialFingerprint('sk-key'),
    provenance: 'created',
    credentialKey: 'token:group-c',
    ...overrides,
  };
}

function makeContext(
  accountOverrides: Partial<ProviderAccount>,
  secrets: Record<string, string>,
  resources: ManagedResource[],
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): { context: ProviderContext; calls: Call[]; recorded: ManagedResourceInput[]; resources: ManagedResource[] } {
  const calls: Call[] = [];
  const recorded: ManagedResourceInput[] = [];
  const context = {
    account: account(accountOverrides),
    secrets: { ...secrets },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const requestInit = init ?? {};
      calls.push({ url, init: requestInit });
      if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`test fetch stub received non-HTTP URL: ${url}`);
      }
      return handler(url, requestInit);
    },
    signal: new AbortController().signal,
    now: () => NOW,
    updateSecrets: async (patch: Record<string, string>) => {
      Object.assign(context.secrets, patch);
    },
    managedResources: resources,
    recordResource: async (input: ManagedResourceInput) => {
      recorded.push(input);
      const existing = resources.find(
        (resource) =>
          resource.kind === input.kind &&
          resource.scope === input.scope &&
          resource.externalId === input.externalId,
      );
      if (existing) {
        Object.assign(existing, input, { updatedAt: NOW.toISOString() });
        return;
      }
      resources.push({
        ...input,
        id: `resource-${resources.length + 1}`,
        plugin: 'realseek',
        accountIds: ['account-1'],
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
    },
  } as ProviderContext;
  return { context, calls, recorded, resources };
}

function discoveryHandler(tokens: Array<Record<string, unknown>>) {
  return (url: string): Response => {
    if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
    if (url.endsWith('/api/pricing')) return json(pricing);
    if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
    if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c'] });
    if (url.includes('/api/token/?')) {
      return json({ success: true, data: { total: tokens.length, items: tokens } });
    }
    const keyMatch = url.match(/\/api\/token\/(\d+)\/key$/);
    if (keyMatch) return json({ success: true, data: { key: `sk-reused-${keyMatch[1]}` } });
    throw new Error(`unexpected test URL: ${url}`);
  };
}

test('realseek cleanup: 创建先记录 intent，唯一确认 ID 后记录 created 与不可逆指纹', { timeout: 5000 }, async () => {
  const tokens: Array<Record<string, unknown>> = [];
  let posts = 0;
  const { context, calls, recorded } = makeContext(
    {
      autoCreateTokens: true,
      tokenTemplate: { namePrefix: 'moris', quota: 1, expiresInDays: 30 },
    },
    { accessToken: 'access', userId: '7' },
    [],
    (url, init) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(pricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c'] });
      if (url.includes('/api/token/?')) {
        return json({ success: true, data: { total: tokens.length, items: tokens } });
      }
      if (url.endsWith('/api/token/') && init.method === 'POST') {
        posts += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        tokens.push({ id: 11, name: body.name, group: body.group, status: 1, key: 'sk-masked****' });
        return json({ success: true, message: '' });
      }
      if (url.endsWith('/api/token/11/key')) return json({ success: true, data: { key: 'sk-created-key' } });
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  await realseek.discover(context);

  const intent = recorded.find((item) => item.provenance === 'intent');
  assert.ok(intent);
  assert.equal(intent.externalId, 'intent:moris-group-c');
  assert.equal(intent.scope, SCOPE);
  assert.equal(intent.group, 'group-c');
  assert.equal(intent.credentialKey, 'token:group-c');

  const created = recorded.find((item) => item.provenance === 'created');
  assert.ok(created);
  assert.equal(created.externalId, '11');
  assert.equal(created.name, 'moris-group-c');
  assert.equal(created.scope, SCOPE);
  assert.equal(created.fingerprint, credentialFingerprint('sk-created-key'));
  assert.equal(recorded.some((item) => item.provenance === 'reused'), false);
  assert.equal(JSON.stringify(recorded).includes('sk-created-key'), false);
  assert.equal(posts, 1);
  assert.ok(calls.every((call) => !['PUT', 'DELETE'].includes(call.init.method ?? 'GET')));
});

test('realseek cleanup: 复用既有 token 只记录 reused 引用，显式 token:<group> 可核验时同样记录', { timeout: 5000 }, async () => {
  const discoveredTokens = [{ id: 21, name: 'moris-group-c', group: 'group-c', status: 1, key: 'sk-masked****' }];
  const explicit = makeContext(
    {},
    { accessToken: 'access', userId: '7', 'token:group-c': 'sk-saved-key' },
    [],
    (url) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(pricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c'] });
      if (url.includes('/api/token/?')) return json({ success: true, data: { total: 1, items: discoveredTokens } });
      if (url.endsWith('/api/token/21/key')) return json({ success: true, data: { key: 'sk-saved-key' } });
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  await realseek.discover(explicit.context);
  const explicitReused = explicit.recorded.find((item) => item.provenance === 'reused');
  assert.ok(explicitReused);
  assert.equal(explicitReused.externalId, '21');
  assert.equal(explicitReused.credentialKey, 'token:group-c');
  assert.equal(explicitReused.fingerprint, credentialFingerprint('sk-saved-key'));
  assert.equal(explicit.recorded.some((item) => item.provenance === 'created' || item.provenance === 'intent'), false);

  const inferred = makeContext(
    { options: { managedTokenPrefix: 'moris', modelOverrides: { m: { context: 100_000, output: 1_000, tools: true } } } },
    { accessToken: 'access', userId: '7' },
    [],
    discoveryHandler(discoveredTokens),
  );
  await realseek.discover(inferred.context);
  const inferredReused = inferred.recorded.find((item) => item.provenance === 'reused');
  assert.ok(inferredReused);
  assert.equal(inferredReused.externalId, '21');
  assert.equal(inferredReused.name, 'moris-group-c');
  assert.equal(inferredReused.credentialKey, 'token:group-c');
  assert.equal(JSON.stringify(inferred.recorded).includes('sk-reused-21'), false);
});

test('realseek cleanup: 创建响应丢失时保留 intent，下一次不重复创建也不误记 created', { timeout: 5000 }, async () => {
  const tokens: Array<Record<string, unknown>> = [];
  let posts = 0;
  const { context, recorded } = makeContext(
    {
      autoCreateTokens: true,
      tokenTemplate: { namePrefix: 'moris', quota: 1, expiresInDays: 30 },
    },
    { accessToken: 'access', userId: '7' },
    [],
    (url, init) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(pricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c'] });
      if (url.includes('/api/token/?')) {
        return json({ success: true, data: { total: tokens.length, items: tokens } });
      }
      if (url.endsWith('/api/token/') && init.method === 'POST') {
        posts += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        tokens.push({ id: 31, name: body.name, group: body.group, status: 1, key: 'sk-masked****' });
        throw new Error('socket hang up after upstream accepted the request');
      }
      if (url.endsWith('/api/token/31/key')) return json({ success: true, data: { key: 'sk-lost-response' } });
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  await assert.rejects(() => realseek.discover(context), /socket hang up/);
  assert.deepEqual(recorded.map((item) => item.provenance), ['intent']);

  await realseek.discover(context);
  assert.equal(posts, 1, '待核验意图存在时不得盲目重复创建');
  assert.equal(recorded.some((item) => item.provenance === 'created'), false);
  assert.ok(recorded.some((item) => item.provenance === 'reused' && item.externalId === '31'));
  assert.ok(recorded.some((item) => item.provenance === 'intent' && item.externalId === 'intent:moris-group-c'));
});

test('realseek cleanup: 同名多匹配保留 intent，不猜创建归属', { timeout: 5000 }, async () => {
  const tokens: Array<Record<string, unknown>> = [];
  let posts = 0;
  const { context, recorded } = makeContext(
    {
      autoCreateTokens: true,
      tokenTemplate: { namePrefix: 'moris', quota: 1, expiresInDays: 30 },
    },
    { accessToken: 'access', userId: '7' },
    [],
    (url, init) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(pricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c'] });
      if (url.includes('/api/token/?')) {
        return json({ success: true, data: { total: tokens.length, items: tokens } });
      }
      if (url.endsWith('/api/token/') && init.method === 'POST') {
        posts += 1;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        tokens.push(
          { id: 41, name: body.name, group: body.group, status: 1, key: 'sk-masked****' },
          { id: 42, name: body.name, group: body.group, status: 1, key: 'sk-masked****' },
        );
        return json({ success: true });
      }
      if (url.endsWith('/api/token/41/key')) return json({ success: true, data: { key: 'sk-first-match' } });
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  const result = await realseek.discover(context);
  assert.equal(posts, 1);
  assert.equal(recorded.some((item) => item.provenance === 'created'), false);
  assert.ok(recorded.some((item) => item.provenance === 'intent'));
  assert.match(result.warnings?.join('\n') ?? '', /同名令牌/);
});

test('realseek cleanup: 预览只读列出可信与已保存凭据匹配的 moris 候选，非 moris 不取钥', { timeout: 5000 }, async () => {
  const tokens = [
    { id: 51, name: 'moris-group-c', group: 'group-c', status: 1, key: 'sk-masked****' },
    { id: 52, name: 'personal', group: 'group-c', status: 1, key: 'sk-masked****' },
    { id: 61, name: 'moris-group-d', group: 'group-d', status: 1, key: 'sk-masked****' },
    { id: 71, name: 'moris-group-e', group: 'group-e', status: 1, key: 'sk-masked****' },
    { id: 58, name: 'moris-group-x', group: 'group-x', status: 1, key: 'sk-masked****' },
  ];
  const trusted = managedResource();
  const absent = managedResource({
    id: 'resource-2',
    externalId: '99',
    name: 'moris-group-old',
    group: 'group-old',
    fingerprint: credentialFingerprint('sk-old'),
  });
  const noFingerprintAbsent = managedResource({
    id: 'resource-3',
    externalId: '98',
    name: 'moris-group-older',
    group: 'group-older',
    fingerprint: undefined,
  });
  const otherAccount = managedResource({
    id: 'resource-4',
    externalId: '58',
    name: 'moris-group-x',
    group: 'group-x',
    accountIds: ['account-2'],
    fingerprint: credentialFingerprint('sk-other-account'),
  });
  const { context, calls } = makeContext(
    { options: { apiKeyGroup: 'group-e', modelOverrides: { m: { context: 100_000, output: 1_000, tools: true } } } },
    { accessToken: 'access', userId: '7', 'token:group-c': 'sk-trusted', 'token:group-d': 'sk-group-d', apiKey: 'sk-api' },
    [trusted, absent, noFingerprintAbsent, otherAccount],
    (url, init) => {
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
      if (url.includes('/api/token/?')) {
        return json({ success: true, data: { total: tokens.length, items: tokens } });
      }
      if (url.endsWith('/api/token/51/key')) return json({ success: true, data: { key: 'sk-trusted' } });
      if (url.endsWith('/api/token/52/key')) throw new Error('non-moris token key must not be revealed');
      if (url.endsWith('/api/token/58/key')) throw new Error('other account resource key must not be revealed');
      if (url.endsWith('/api/token/61/key')) return json({ success: true, data: { key: 'sk-group-d' } });
      if (url.endsWith('/api/token/71/key')) return json({ success: true, data: { key: 'sk-api' } });
      if (url.endsWith('/api/token/') && init.method === 'POST') throw new Error('preview must not create tokens');
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  const preview = await realseek.cleanup!.preview(context);
  const byId = new Map(preview.map((item) => [item.resource.externalId, item]));

  assert.equal(byId.get('51')?.verified, true);
  assert.equal(byId.get('51')?.resource.provenance, 'created');
  assert.equal(byId.get('51')?.resource.fingerprint, credentialFingerprint('sk-trusted'));

  assert.equal(byId.get('61')?.verified, true);
  assert.equal(byId.get('61')?.resource.provenance, 'reused');
  assert.equal(byId.get('61')?.resource.credentialKey, 'token:group-d');
  assert.equal(byId.get('61')?.resource.fingerprint, credentialFingerprint('sk-group-d'));

  assert.equal(byId.get('71')?.verified, true);
  assert.equal(byId.get('71')?.resource.credentialKey, 'apiKey');

  assert.equal(byId.get('99')?.verified, false);
  assert.match(byId.get('99')?.reason ?? '', /不存在/);
  assert.equal((byId.get('99') as { absent?: boolean }).absent, true);
  assert.equal(byId.get('98')?.verified, false);
  assert.equal((byId.get('98') as { absent?: boolean }).absent, undefined, '缺少指纹时不得标记 absent');
  assert.equal(byId.has('52'), false, '非 moris 令牌不得成为候选');
  assert.equal(byId.has('58'), false, '其他账号拥有的同 scope 记录不得成为本账号候选');

  assert.equal(calls.some((call) => call.url.endsWith('/api/token/52/key')), false);
  assert.equal(calls.some((call) => call.url.endsWith('/api/token/58/key')), false);
  assert.equal(calls.some((call) => call.url.includes('/api/pricing')), false, '预览不得使用 discover');
  assert.equal(calls.some((call) => call.init.method === 'DELETE'), false);
  assert.equal(calls.some((call) => call.url.endsWith('/api/token/') && call.init.method === 'POST'), false);
  const serialized = JSON.stringify(preview);
  for (const secret of ['sk-trusted', 'sk-group-d', 'sk-api', 'sk-other-account']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('realseek cleanup: 上游身份变更时预览不列旧身份资源，执行拒绝删除', { timeout: 5000 }, async () => {
  const trusted = managedResource();
  const { context, calls } = makeContext(
    {},
    { accessToken: 'access', userId: '7' },
    [trusted],
    (url, init) => {
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 8 } });
      if (url.includes('/api/token/?')) {
        return json({
          success: true,
          data: {
            total: 1,
            items: [{ id: 51, name: 'moris-group-c', group: 'group-c', status: 1, key: 'sk-masked****' }],
          },
        });
      }
      if (url.endsWith('/api/token/51/key')) throw new Error('旧身份资源不得取钥');
      if (init.method === 'DELETE') throw new Error('身份不一致时不得删除');
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  const preview = await realseek.cleanup!.preview(context);
  assert.deepEqual(preview, []);
  assert.equal(calls.some((call) => call.url.endsWith('/api/token/51/key')), false);

  const result = await realseek.cleanup!.execute(context, {
    kind: 'token',
    scope: SCOPE,
    externalId: '51',
    name: 'moris-group-c',
    group: 'group-c',
    fingerprint: credentialFingerprint('sk-trusted'),
    provenance: 'created',
    credentialKey: 'token:group-c',
  });
  assert.equal(result.state, 'failed');
  assert.match(result.message ?? '', /身份|归属/);
  assert.equal(calls.some((call) => call.init.method === 'DELETE'), false);
});

test('realseek cleanup: 有 recordResource 但 /api/user/self 缺实际 ID 时禁止自动创建', { timeout: 5000 }, async () => {
  let posts = 0;
  const { context, recorded } = makeContext(
    {
      autoCreateTokens: true,
      tokenTemplate: { namePrefix: 'moris', quota: 1, expiresInDays: 30 },
    },
    { accessToken: 'access', userId: '7' },
    [],
    (url, init) => {
      if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
      if (url.endsWith('/api/pricing')) return json(pricing);
      if (url.endsWith('/api/user/self')) return json({ success: true, data: { quota: 1 } });
      if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c'] });
      if (url.includes('/api/token/?')) return json({ success: true, data: { total: 0, items: [] } });
      if (url.endsWith('/api/token/') && init.method === 'POST') {
        posts += 1;
        return json({ success: true });
      }
      throw new Error(`unexpected test URL: ${url}`);
    },
  );

  const result = await realseek.discover(context);
  assert.equal(posts, 0, '缺少实际用户 ID 时不得新建令牌');
  assert.equal(recorded.length, 0, '不得产生无归属证据的资源记录');
  assert.match(result.warnings?.join('\n') ?? '', /用户 ID.*自动创建|自动创建.*用户 ID/);
});

test('realseek cleanup: tokenTemplate.namePrefix 非 moris 时不新建，带或不带 recordResource 均拒绝', { timeout: 5000 }, async () => {
  for (const withRecorder of [true, false]) {
    let posts = 0;
    const harness = makeContext(
      {
        autoCreateTokens: true,
        tokenTemplate: { namePrefix: 'custom', quota: 1, expiresInDays: 30 },
      },
      { accessToken: 'access', userId: '7' },
      [],
      (url, init) => {
        if (url.endsWith('/api/status')) return json({ success: true, data: { quota_per_unit: 500_000 } });
        if (url.endsWith('/api/pricing')) return json(pricing);
        if (url.endsWith('/api/user/self')) return json({ success: true, data: { id: 7 } });
        if (url.endsWith('/api/user/self/groups')) return json({ success: true, data: ['group-c'] });
        if (url.includes('/api/token/?')) return json({ success: true, data: { total: 0, items: [] } });
        if (url.endsWith('/api/token/') && init.method === 'POST') {
          posts += 1;
          return json({ success: true });
        }
        throw new Error(`unexpected test URL: ${url}`);
      },
    );
    if (!withRecorder) delete harness.context.recordResource;

    await assert.rejects(() => realseek.discover(harness.context), /moris/);
    assert.equal(posts, 0, `namePrefix 非 moris 时不得新建（recorder=${withRecorder}）`);
    assert.equal(harness.recorded.length, 0);
  }
});

interface ExecuteOptions {
  tokens?: Array<Record<string, unknown>>;
  selfId?: number;
  key?: (id: number) => string | null;
  onDelete?: (
    id: number,
    tokens: Array<Record<string, unknown>>,
  ) => Response | Promise<Response>;
  incomplete?: boolean;
  secrets?: Record<string, string>;
}

function executeHarness(options: ExecuteOptions = {}) {
  const tokens = options.tokens ?? [{ id: 81, name: 'moris-group-c', group: 'group-c', status: 1, key: 'sk-masked****' }];
  const key = options.key ?? (() => 'sk-key');
  const { context, calls } = makeContext(
    {},
    options.secrets ?? { accessToken: 'access', userId: '7' },
    [],
    (url, init) => {
      if (url.endsWith('/api/user/self')) {
        return json({ success: true, data: { id: options.selfId ?? 7 } });
      }
      if (url.includes('/api/token/?')) {
        const page = Number(new URL(url).searchParams.get('p') ?? '1');
        if (options.incomplete) {
          if (page === 1) return json({ success: true, data: { total: 2, items: [tokens[0]] } });
          return json({ success: true, data: { total: 2, items: [] } });
        }
        return json({ success: true, data: { total: tokens.length, items: tokens } });
      }
      const keyMatch = url.match(/\/api\/token\/(\d+)\/key$/);
      if (keyMatch) {
        const value = key(Number(keyMatch[1]));
        assert.ok(value, 'execute must not delete without verifying the key');
        return json({ success: true, data: { key: value } });
      }
      const deleteMatch = url.match(/\/api\/token\/(\d+)$/);
      if (deleteMatch && init.method === 'DELETE') {
        assert.ok(options.onDelete, 'unexpected delete');
        return options.onDelete(Number(deleteMatch[1]), tokens);
      }
      throw new Error(`unexpected test URL: ${url}`);
    },
  );
  return { context, calls, tokens };
}

test('realseek cleanup: 执行成功只按 ID 删除并返回 deleted', { timeout: 5000 }, async () => {
  let deletes = 0;
  const { context, calls } = executeHarness({
    onDelete: () => {
      deletes += 1;
      return json({ success: true, message: '' });
    },
  });
  const result = await realseek.cleanup!.execute(context, resourceInput());
  assert.equal(result.state, 'deleted');
  assert.equal(deletes, 1);
  assert.equal(calls.filter((call) => call.init.method === 'DELETE').length, 1);
  assert.equal(calls.some((call) => call.init.method === 'PUT'), false);
});

test('realseek cleanup: HTTP 200 但 success:false 记为 failed 且不重试、不泄漏上游正文', { timeout: 5000 }, async () => {
  let deletes = 0;
  const { context, calls } = executeHarness({
    onDelete: () => {
      deletes += 1;
      return json({ success: false, message: 'upstream body sk-secret-should-not-leak' });
    },
  });
  const result = await realseek.cleanup!.execute(context, resourceInput());
  assert.equal(result.state, 'failed');
  assert.equal(deletes, 1);
  assert.equal(calls.filter((call) => call.init.method === 'DELETE').length, 1);
  assert.equal(result.message?.includes('sk-secret-should-not-leak'), false);
  assert.equal(result.message?.includes('upstream body'), false);
});

test('realseek cleanup: 删除超时或网络异常返回 unknown，且无隐式重试', { timeout: 5000 }, async () => {
  let deletes = 0;
  const { context, calls } = executeHarness({
    onDelete: () => {
      deletes += 1;
      throw new Error('socket timed out');
    },
  });
  const result = await realseek.cleanup!.execute(context, resourceInput());
  assert.equal(result.state, 'unknown');
  assert.equal(deletes, 1);
  assert.equal(calls.filter((call) => call.init.method === 'DELETE').length, 1);
  assert.equal(result.message?.includes('socket timed out'), false);
});

test('realseek cleanup: 404 不直接当 absent，完整清单仍在则 failed', { timeout: 5000 }, async () => {
  const { context, calls } = executeHarness({
    onDelete: () => json({ success: false, message: 'not found' }, 404),
  });
  const result = await realseek.cleanup!.execute(context, resourceInput());
  assert.equal(result.state, 'failed');
  const listAfter = calls.filter((call) => call.url.includes('/api/token/?')).length;
  assert.equal(listAfter, 2, '404 后必须用完整清单确认，而不是直接 absent');
});

test('realseek cleanup: 404 后完整清单确认不存在才记为 absent', { timeout: 5000 }, async () => {
  const { context, calls } = executeHarness({
    onDelete: (_id, tokens) => {
      tokens.splice(0, tokens.length);
      return json({ success: false, message: 'not found' }, 404);
    },
  });
  const result = await realseek.cleanup!.execute(context, resourceInput());
  assert.equal(result.state, 'absent');
  assert.equal(calls.filter((call) => call.url.includes('/api/token/?')).length, 2);
});

test('realseek cleanup: 完整清单已无该 ID 时直接 absent，不发送删除', { timeout: 5000 }, async () => {
  const { context, calls } = executeHarness({ tokens: [] });
  const result = await realseek.cleanup!.execute(context, resourceInput());
  assert.equal(result.state, 'absent');
  assert.equal(calls.some((call) => call.init.method === 'DELETE'), false);
});

test('realseek cleanup: 清单不完整或读取失败时不删除', { timeout: 5000 }, async () => {
  const { context, calls } = executeHarness({ incomplete: true });
  const result = await realseek.cleanup!.execute(context, resourceInput());
  assert.equal(result.state, 'failed');
  assert.match(result.message ?? '', /完整读取|清单/);
  assert.equal(calls.some((call) => call.init.method === 'DELETE'), false);
});

test('realseek cleanup: intent、非 moris、名称或指纹不一致时拒绝删除', { timeout: 5000 }, async () => {
  const cases: Array<ManagedResourceInput> = [
    resourceInput({ externalId: 'intent:moris-group-c', provenance: 'intent' }),
    resourceInput({ name: 'personal' }),
    resourceInput({ fingerprint: credentialFingerprint('different-key') }),
    resourceInput({ group: 'group-other' }),
  ];
  for (const resource of cases) {
    let deletes = 0;
    const { context } = executeHarness({
      onDelete: () => {
        deletes += 1;
        return json({ success: true });
      },
    });
    const result = await realseek.cleanup!.execute(context, resource);
    assert.equal(result.state, 'failed', JSON.stringify(resource));
    assert.equal(deletes, 0);
  }
});
