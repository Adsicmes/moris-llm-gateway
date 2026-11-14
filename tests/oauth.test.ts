import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../apps/gateway/src/server.js';
import { Store } from '../apps/gateway/src/store.js';
import { ProviderRegistry } from '../apps/gateway/src/providers.js';
import type { AuthorizationResult, DeviceAuthorization, ProviderContext } from '../packages/provider-sdk/src/index.js';
import type { ProviderAccount } from '../packages/contracts/src/index.js';

const key = () => randomBytes(32).toString('base64');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeState {
  startCalls: number;
  pollCalls: number;
  grant: DeviceAuthorization;
  startError?: Error;
  pollError?: Error;
  pollResult: AuthorizationResult;
  statusResult: { authorized: boolean; accountId?: string; planType?: string; email?: string; expiresAt?: string };
  onPoll?: (context: ProviderContext) => Promise<void> | void;
}

async function fixture() {
  const store = new Store(':memory:', key());
  store.initializeAdmin('admin', 'a-test-password-only');

  const account: ProviderAccount = {
    id: 'a', namespace: 'fake', name: 'Fake', plugin: 'fake', baseUrl: 'https://fake.test',
    billingType: 'subscription', enabled: true, autoCreateTokens: false, options: {},
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  store.saveAccount(account, { apiKey: 'existing-upstream-key' });

  const state: FakeState = {
    startCalls: 0,
    pollCalls: 0,
    grant: {
      deviceAuthId: 'device-auth-id-must-not-leak',
      userCode: 'ABCD-EFGH',
      verificationUrl: 'https://fake.test/device',
      intervalSeconds: 0.25,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
    pollResult: { state: 'pending', intervalSeconds: 1, message: '等待授权' },
    statusResult: { authorized: false },
  };

  const registry = new ProviderRegistry();
  registry.register({
    id: 'fake', name: 'Fake',
    discover: async () => { throw new Error('测试不触发目录发现'); },
    prepare: async () => { throw new Error('测试不触发推理'); },
    authorization: {
      start: async () => {
        state.startCalls += 1;
        if (state.startError) throw state.startError;
        return { ...state.grant };
      },
      poll: async (context) => {
        state.pollCalls += 1;
        if (state.onPoll) await state.onPoll(context);
        if (state.pollError) throw state.pollError;
        return state.pollResult;
      },
      status: async () => state.statusResult,
    },
  });

  const app: FastifyInstance = await createApp({ store, registry, secureCookie: false, background: false });
  const first = store.createSession('admin');
  const second = store.createSession('admin');
  const headers = (session: { token: string; csrfToken: string }, csrf = true) => ({
    cookie: `moris_session=${session.token}`,
    ...(csrf ? { 'x-csrf-token': session.csrfToken } : {}),
  });

  return {
    app, store, account, state,
    startUrl: '/api/admin/providers/a/oauth/start',
    pollUrl: '/api/admin/providers/a/oauth/poll',
    first: headers(first),
    firstNoCsrf: headers(first, false),
    second: headers(second),
    close: async () => { await app.close(); store.close(); },
  };
}

test('设备密钥不能管理授权，start/poll 必须带 CSRF', async () => {
  const f = await fixture();
  try {
    const device = f.store.createDevice('oauth-test');
    let response = await f.app.inject({
      method: 'POST', url: f.startUrl,
      headers: { authorization: `Bearer ${device.key}` },
    });
    assert.equal(response.statusCode, 401);

    response = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.firstNoCsrf });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'csrf');

    response = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.first });
    assert.equal(response.statusCode, 200);

    response = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.firstNoCsrf });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'csrf');
    assert.equal(f.state.pollCalls, 0);
  } finally {
    await f.close();
  }
});

test('start 只返回展示信息，轮询间隔最少 1 秒', async () => {
  const f = await fixture();
  try {
    const start = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.first });
    assert.equal(start.statusCode, 200);
    const body = start.json() as Record<string, unknown>;
    assert.equal('deviceAuthId' in body, false);
    assert.equal(body.intervalSeconds, 1);
    assert.ok(!start.body.includes(f.state.grant.deviceAuthId));
    assert.ok(!start.body.includes('token'));

    // 立即轮询应命中间隔保护，且不调用插件 poll。
    const poll = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.first });
    assert.equal(poll.statusCode, 200);
    assert.equal(poll.json().state, 'pending');
    assert.equal(poll.json().intervalSeconds, 1);
    assert.equal(f.state.pollCalls, 0);
  } finally {
    await f.close();
  }
});

test('poll 绑定发起授权的登录会话', async () => {
  const f = await fixture();
  try {
    const start = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.first });
    assert.equal(start.statusCode, 200);

    const other = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.second });
    assert.equal(other.statusCode, 409);
    assert.equal(other.json().error.code, 'oauth_missing');
    assert.equal(f.state.pollCalls, 0);

    const own = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.first });
    assert.equal(own.statusCode, 200);
    assert.equal(own.json().state, 'pending');
  } finally {
    await f.close();
  }
});

test('完成后凭据加密入库，轮询响应不含令牌', { timeout: 10_000 }, async () => {
  const f = await fixture();
  const secret = 'refresh-token-super-secret';
  f.state.pollResult = {
    state: 'complete',
    accountId: 'upstream-account-1',
    planType: 'pro',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
  f.state.onPoll = async (context) => {
    await context.updateSecrets({ refreshToken: secret, accessToken: `access-${secret}` });
  };

  try {
    const start = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.first });
    assert.equal(start.statusCode, 200);

    await delay(1050);
    const poll = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.first });
    assert.equal(poll.statusCode, 200);
    assert.equal(poll.json().state, 'complete');
    assert.ok(!poll.body.includes(secret));

    assert.equal(f.store.secrets(f.account.id).refreshToken, secret);
    const row = f.store.db.prepare('SELECT secrets FROM accounts WHERE id=?').get(f.account.id) as { secrets: string };
    assert.ok(!String(row.secrets).includes(secret), '数据库不应保存明文令牌');

    // 完成后授权上下文被消费，再次轮询必须要求重新开始。
    const again = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.first });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'oauth_missing');
  } finally {
    await f.close();
  }
});

test('授权到期或账号修改后拒绝轮询', async () => {
  const f = await fixture();
  try {
    f.state.grant.expiresAt = new Date(Date.now() + 80).toISOString();
    let start = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.first });
    assert.equal(start.statusCode, 200);

    await delay(120);
    let poll = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.first });
    assert.equal(poll.statusCode, 410);
    assert.equal(poll.json().error.code, 'oauth_expired');
    assert.equal(f.state.pollCalls, 0);

    // 账号 updatedAt 变化后同样失效。
    f.state.grant.expiresAt = new Date(Date.now() + 60_000).toISOString();
    start = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.first });
    assert.equal(start.statusCode, 200);

    await delay(5);
    const patch = await f.app.inject({
      method: 'PATCH', url: '/api/admin/providers/a', headers: f.first,
      payload: { name: 'Fake renamed' },
    });
    assert.equal(patch.statusCode, 200);

    poll = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.first });
    assert.equal(poll.statusCode, 410);
    assert.equal(poll.json().error.code, 'oauth_expired');
  } finally {
    await f.close();
  }
});

test('授权状态可刷新回显，且不返回任何令牌', async () => {
  const f = await fixture();
  try {
    f.state.statusResult = {
      authorized: true,
      accountId: 'account-1',
      planType: 'pro',
      email: 'user@example.com',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    assert.equal(
      (await f.app.inject({ url: '/api/admin/providers/a/authorization', headers: { authorization: 'Bearer device' } })).statusCode,
      401,
    );
    const response = await f.app.inject({ url: '/api/admin/providers/a/authorization', headers: f.first });
    assert.equal(response.statusCode, 200);
    const body = response.json() as Record<string, unknown>;
    assert.equal(body.supported, true);
    assert.equal(body.statusKnown, true);
    assert.equal(body.authorized, true);
    assert.equal(body.accountId, 'account-1');
    assert.equal(body.email, 'user@example.com');
    assert.ok(!response.body.includes('existing-upstream-key'));
    assert.ok(!response.body.includes('refreshToken'));
  } finally {
    await f.close();
  }
});

test('授权起点错误按代码给出可执行原因，仍不回显敏感正文', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    f.state.startError = Object.assign(new Error('proxy=http://user:secret@proxy connect ECONNREFUSED'), {
      code: 'network',
      status: 502,
    });
    const response = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.first });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'oauth_start_failed');
    assert.match(response.json().error.message, /代理|host\.docker\.internal/);
    assert.ok(!response.body.includes('secret'));
  } finally {
    await f.close();
  }
});

test('上游授权异常含敏感文本时只返回通用错误', { timeout: 10_000 }, async () => {
  const f = await fixture();
  try {
    f.state.startError = new Error('refresh_token=START-SECRET code=START-CODE');
    let response = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.first });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'oauth_start_failed');
    assert.ok(!response.body.includes('START-SECRET'));
    assert.ok(!response.body.includes('START-CODE'));

    f.state.startError = undefined;
    response = await f.app.inject({ method: 'POST', url: f.startUrl, headers: f.first });
    assert.equal(response.statusCode, 200);

    f.state.pollError = new Error('client_secret=POLL-SECRET upstream_body=POLL-BODY');
    await delay(1050);
    response = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.first });
    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error.code, 'oauth_poll_failed');
    assert.ok(!response.body.includes('POLL-SECRET'));
    assert.ok(!response.body.includes('POLL-BODY'));

    const again = await f.app.inject({ method: 'POST', url: f.pollUrl, headers: f.first });
    assert.equal(again.statusCode, 409);
    assert.equal(again.json().error.code, 'oauth_missing');
  } finally {
    await f.close();
  }
});
