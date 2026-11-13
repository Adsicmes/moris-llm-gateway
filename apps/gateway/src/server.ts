import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import serveStatic from '@fastify/static';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ProviderAccount, Settings } from '../../../packages/contracts/src/index.js';
import { Store, type Bill, type Device } from './store.js';
import { Providers, ProviderRegistry } from './providers.js';
import { Transport } from './network.js';
import { safeEqual, verifyPassword } from './security.js';
import { executeRequest, GatewayError } from './routing.js';
import { sumMoney } from './billing.js';
import type { DeviceAuthorization } from '../../../packages/provider-sdk/src/index.js';

const urlSchema = z.string().url().refine(v => ['http:', 'https:'].includes(new URL(v).protocol) && !new URL(v).username && !new URL(v).password, '需要不含凭据的HTTP(S)地址');
const proxySchema = z.string().refine(v => { try { return v === '' || ['http:', 'https:', 'socks5:', 'socks5h:'].includes(new URL(v).protocol); } catch { return false; } }, '代理URL无效');
const tokenTemplate = z.object({ namePrefix: z.string().min(1).max(64), quota: z.number().finite().nonnegative(), expiresInDays: z.number().int().positive().max(3650), unlimited: z.boolean().optional() });
const accountSchema = z.object({
  namespace: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/), name: z.string().min(1).max(100),
  plugin: z.string().min(1).max(100), baseUrl: urlSchema,
  billingType: z.enum(['subscription', 'metered']), enabled: z.boolean().default(true),
  proxyUrl: proxySchema.optional(), autoCreateTokens: z.boolean().default(false), tokenTemplate: tokenTemplate.optional(),
  options: z.record(z.string(), z.unknown()).default({}), secrets: z.record(z.string(), z.string()).optional(),
}).strict();
const billSchema = z.object({ accountId: z.string(), paidAt: z.iso.datetime({ offset: true }), amountCny: z.number().finite().min(-1e10).max(1e10).refine(x => Math.abs(x * 100 - Math.round(x * 100)) < 0.00001, '人民币金额最多两位小数'), period: z.string().max(100).optional(), method: z.string().max(100).optional(), note: z.string().max(2000).optional() }).strict();
const settingsSchema = z.object({
  catalogRefreshMs: z.number().int().min(1000).max(86_400_000), monitorRefreshMs: z.number().int().min(1000).max(86_400_000),
  catalogTtlMs: z.number().int().min(1000).max(7 * 86_400_000), balanceStaleMs: z.number().int().min(1000).max(86_400_000),
  maxAttempts: z.number().int().min(1).max(10), connectTimeoutMs: z.number().int().min(100).max(120_000),
  firstEventTimeoutMs: z.number().int().min(100).max(3_600_000), idleTimeoutMs: z.number().int().min(100).max(3_600_000), requestTimeoutMs: z.number().int().min(100).max(3_600_000),
  usdCny: z.number().finite().positive().max(10000).nullable(), minEstimateRatio: z.number().min(0.001).max(1),
  timezone: z.literal('Asia/Shanghai'), fallback: z.record(z.string(), z.array(z.string().min(1)).max(20)),
}).strict().partial();

export interface AppOptions {
  store: Store; registry: ProviderRegistry; secureCookie?: boolean; adminDist?: string;
  fetch?: typeof fetch; background?: boolean; logger?: boolean | Record<string, unknown>;
}
export async function createApp(options: AppOptions): Promise<FastifyInstance> {
  const { store } = options;
  const app = Fastify({ bodyLimit: 32 * 1024 * 1024, requestTimeout: 0, trustProxy: ['127.0.0.1', '::1'], logger: options.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }) });
  const transport = new Transport(); const providers = new Providers(store, options.registry, transport, options.fetch);
  const devices = new WeakMap<FastifyRequest, Device>();
  const attempts = new Map<string, { count: number; until: number }>();
  const authorizations = new Map<string, { grant: DeviceAuthorization; owner: string; updatedAt: string; nextPoll: number; busy: boolean }>();
  const startingAuthorization = new Set<string>();
  await app.register(cookie);
  app.addHook('onResponse', async (req, reply) => {
    app.log.info({ requestId: req.id, method: req.method, route: req.routeOptions.url, status: reply.statusCode, elapsedMs: reply.elapsedTime }, '请求完成');
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'same-origin');
    if (_req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    return payload;
  });
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (path.startsWith('/api/admin/') || path === '/api/auth/logout' || path === '/api/auth/session') {
      const session = req.cookies.moris_session ? store.session(req.cookies.moris_session) : undefined;
      if (!session) return reply.code(401).send({ error: { code: 'unauthorized', message: '请先登录后台' } });
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !safeEqual(String(req.headers['x-csrf-token'] ?? ''), session.csrfToken)) return reply.code(403).send({ error: { code: 'csrf', message: '登录校验已失效，请刷新页面' } });
    }
    if (path.startsWith('/v1/') || ['/api/catalog', '/api/quota'].includes(path)) {
      const authorization = req.headers.authorization;
      const key = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
      const device = key ? store.deviceForKey(key) : undefined;
      if (!device) return reply.code(401).send({ error: { code: 'invalid_key', message: '设备密钥无效或已撤销' } });
      devices.set(req, device);
    }
  });
  app.setErrorHandler((error, _req, reply) => {
    if (reply.raw.headersSent) { reply.raw.end(); return; }
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: 'validation', message: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') } });
    if (error instanceof GatewayError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    const status = (error as { statusCode?: number }).statusCode;
    return reply.code(status && status >= 400 && status < 500 ? status : 500).send({ error: { code: 'request_failed', message: '操作未完成，请检查输入和服务器状态' } });
  });
  app.get('/health', async () => { store.db.prepare('SELECT 1').get(); return { status: 'ok', name: 'MorisLLMGateway' }; });
  app.post('/api/auth/login', async (req, reply) => {
    const origin = req.headers.origin;
    if (origin) {
      let same = false; try { same = new URL(origin).host === req.headers.host; } catch { /* 拒绝错误Origin。 */ }
      if (!same) throw new GatewayError('origin', '不允许跨站登录', 403);
    }
    const limit = attempts.get(req.ip);
    if (limit && limit.until > Date.now() && limit.count >= 10) return reply.code(429).header('retry-after', Math.ceil((limit.until - Date.now()) / 1000)).send({ error: { code: 'login_rate_limit', message: '登录尝试过多，请稍后重试' } });
    const { username, password } = z.object({ username: z.string().max(100), password: z.string().max(1024) }).parse(req.body);
    const admin = store.getMeta<{ username: string; passwordHash: string }>('admin');
    const validPassword = admin ? verifyPassword(password, admin.passwordHash) : false;
    if (!admin || !validPassword || !safeEqual(username, admin.username)) {
      if (attempts.size >= 10000) for (const [ip, item] of attempts) if (item.until <= Date.now()) attempts.delete(ip);
      attempts.set(req.ip, { count: limit && limit.until > Date.now() ? limit.count + 1 : 1, until: limit && limit.until > Date.now() ? limit.until : Date.now() + 15 * 60_000 });
      throw new GatewayError('invalid_credentials', '账号或密码不正确', 401);
    }
    attempts.delete(req.ip);
    if (req.cookies.moris_session) store.deleteSession(req.cookies.moris_session);
    const session = store.createSession(username);
    reply.setCookie('moris_session', session.token, { httpOnly: true, sameSite: 'strict', secure: options.secureCookie ?? true, path: '/', maxAge: 12 * 3600 });
    return { username, csrfToken: session.csrfToken };
  });
  app.get('/api/auth/session', async req => store.session(req.cookies.moris_session!));
  app.post('/api/auth/logout', async (req, reply) => { store.deleteSession(req.cookies.moris_session!); reply.clearCookie('moris_session', { path: '/' }); return { ok: true }; });
  app.get('/api/admin/plugins', async () => ({ items: options.registry.list() }));
  app.get('/api/admin/providers', async () => ({ items: store.accounts() }));
  app.post('/api/admin/providers', async req => {
    const data = accountSchema.parse(req.body);
    if (!options.registry.list().some(p => p.id === data.plugin)) throw new GatewayError('plugin_missing', '供应商插件未安装');
    if (store.accounts().some(a => a.namespace === data.namespace)) throw new GatewayError('namespace_exists', '供应商标识已存在', 409);
    const { secrets, proxyUrl, ...fields } = data;
    const account: ProviderAccount = { ...fields, id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), proxyUrl: publicProxy(proxyUrl) };
    store.saveAccount(account, { ...secrets, ...(proxyUrl ? { __proxyUrl: proxyUrl } : {}) });
    return { item: account };
  });
  app.patch('/api/admin/providers/:id', async req => {
    const id = idParam(req); const old = requireAccount(store, id);
    const data = accountSchema.omit({ namespace: true, plugin: true }).partial().parse(req.body);
    const { secrets, proxyUrl, ...fields } = data;
    const account: ProviderAccount = { ...old, ...fields, updatedAt: new Date().toISOString(), ...(proxyUrl !== undefined ? { proxyUrl: publicProxy(proxyUrl) } : {}) };
    store.saveAccount(account, { ...secrets, ...(proxyUrl !== undefined ? { __proxyUrl: proxyUrl } : {}) });
    return { item: account };
  });
  app.delete('/api/admin/providers/:id', async req => { const account = requireAccount(store, idParam(req)); store.saveAccount({ ...account, enabled: false, updatedAt: new Date().toISOString() }); return { ok: true }; });
  app.post('/api/admin/providers/:id/sync', async req => { requireAccount(store, idParam(req)); return providers.manualSync(idParam(req)); });
  app.post('/api/admin/providers/:id/oauth/start', async req => {
    const account = requireAccount(store, idParam(req));
    const auth = options.registry.get(account.plugin).authorization;
    if (!auth) throw new GatewayError('oauth_unsupported', '此供应商插件不支持设备授权');
    if (startingAuthorization.has(account.id) || authorizations.get(account.id)?.busy) throw new GatewayError('oauth_busy', '授权操作正在进行，请稍后重试', 409);
    for (const [id, value] of authorizations) if (Date.parse(value.grant.expiresAt) <= Date.now()) authorizations.delete(id);
    startingAuthorization.add(account.id);
    try {
      const grant = await auth.start(providers.context(account, AbortSignal.timeout(30_000)));
      if (!grant.deviceAuthId || !grant.userCode || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= Date.now() || !Number.isFinite(grant.intervalSeconds) || grant.intervalSeconds <= 0 || !['https:', 'http:'].includes(new URL(grant.verificationUrl).protocol)) throw new Error('Invalid device authorization');
      const intervalSeconds = Math.max(1, grant.intervalSeconds);
      authorizations.set(account.id, { grant: { ...grant, intervalSeconds }, owner: req.cookies.moris_session!, updatedAt: account.updatedAt, nextPoll: Date.now() + intervalSeconds * 1000, busy: false });
      return { verificationUrl: grant.verificationUrl, userCode: grant.userCode, expiresAt: grant.expiresAt, intervalSeconds };
    } catch {
      throw new GatewayError('oauth_start_failed', '无法开始授权，请检查供应商配置、代理和设备登录支持', 502);
    } finally { startingAuthorization.delete(account.id); }
  });
  app.post('/api/admin/providers/:id/oauth/poll', async req => {
    const account = requireAccount(store, idParam(req));
    const value = authorizations.get(account.id);
    if (!value || value.owner !== req.cookies.moris_session) throw new GatewayError('oauth_missing', '请在当前登录会话中重新开始授权', 409);
    if (Date.parse(value.grant.expiresAt) <= Date.now() || value.updatedAt !== account.updatedAt) {
      authorizations.delete(account.id);
      throw new GatewayError('oauth_expired', '授权已过期或供应商配置已改变，请重新开始', 410);
    }
    if (value.busy || Date.now() < value.nextPoll) return { state: 'pending', intervalSeconds: Math.max(1, Math.ceil((value.nextPoll - Date.now()) / 1000)), message: '等待下一次授权查询' };
    const auth = options.registry.get(account.plugin).authorization;
    if (!auth) throw new GatewayError('oauth_unsupported', '供应商授权能力不可用');
    value.busy = true;
    value.nextPoll = Date.now() + value.grant.intervalSeconds * 1000;
    try {
      const result = await auth.poll(providers.context(account, AbortSignal.timeout(30_000)), value.grant);
      if (result.state === 'complete') authorizations.delete(account.id);
      else {
        const interval = Number.isFinite(result.intervalSeconds) && result.intervalSeconds > 0 ? result.intervalSeconds : value.grant.intervalSeconds;
        value.grant.intervalSeconds = interval;
        value.nextPoll = Date.now() + interval * 1000;
      }
      return result;
    } catch {
      authorizations.delete(account.id);
      throw new GatewayError('oauth_poll_failed', '授权查询失败，请重新开始授权；令牌不会返回浏览器', 502);
    } finally { value.busy = false; }
  });
  app.get('/api/admin/models', async () => ({ items: store.models().map(model => ({ ...model, enabled: providers.callable(model), disabledReason: providers.callable(model) ? undefined : model.disabledReason ?? '目录过期或供应商已停用' })) }));
  app.get('/api/admin/quota', async () => ({ items: providers.quotas() }));
  app.get('/api/catalog', async () => providers.catalog());
  app.get('/api/quota', async () => ({ items: providers.quotas() }));
  app.get('/v1/models', async () => ({ object: 'list', data: providers.catalog().models.map(model => ({ id: model.id, object: 'model', owned_by: model.namespace, created: Math.floor(Date.parse(model.syncedAt) / 1000) })) }));
  for (const [path, protocol] of [['chat/completions', 'chat-completions'], ['responses', 'responses'], ['messages', 'messages']] as const) {
    app.post(`/v1/${path}`, async (req, reply) => executeRequest(providers, protocol, req, reply, devices.get(req)!.id));
  }
  app.get('/api/admin/settings', async () => store.settings());
  app.patch('/api/admin/settings', async req => {
    const patch = settingsSchema.parse(req.body); const settings: Settings = { ...store.settings(), ...patch };
    for (const [source, targets] of Object.entries(settings.fallback)) {
      if (!store.model(source) || targets.some(id => !store.model(id) || id === source) || new Set(targets).size !== targets.length) throw new GatewayError('invalid_fallback', '回退列表包含未知、自身或重复模型');
    }
    store.saveSettings(settings); return settings;
  });
  app.get('/api/admin/bills', async () => ({ items: store.bills(), totalCny: roundCny(store.bills().reduce((sum, b) => sum + b.amountCny, 0)) }));
  app.post('/api/admin/bills', async req => {
    const value = billSchema.parse(req.body); requireAccount(store, value.accountId);
    const item: Bill = { ...value, paidAt: new Date(value.paidAt).toISOString(), id: randomUUID(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    store.saveBill(item); return { item };
  });
  app.patch('/api/admin/bills/:id', async req => {
    const old = store.bills().find(b => b.id === idParam(req)); if (!old) throw new GatewayError('not_found', '账单不存在', 404);
    const value = billSchema.partial().parse(req.body); if (value.accountId) requireAccount(store, value.accountId);
    const item: Bill = { ...old, ...value, updatedAt: new Date().toISOString(), paidAt: value.paidAt ? new Date(value.paidAt).toISOString() : old.paidAt };
    store.saveBill(item); return { item };
  });
  app.delete('/api/admin/bills/:id', async req => { if (!store.deleteBill(idParam(req))) throw new GatewayError('not_found', '账单不存在', 404); return { ok: true }; });
  app.get('/api/admin/devices', async () => ({ items: store.devices() }));
  app.post('/api/admin/devices', async req => store.createDevice(z.object({ name: z.string().min(1).max(100) }).parse(req.body).name));
  app.delete('/api/admin/devices/:id', async req => { if (!store.revokeDevice(idParam(req))) throw new GatewayError('not_found', '设备不存在', 404); return { ok: true }; });
  app.get('/api/admin/requests', async req => {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().nonnegative().default(0) }).parse(req.query);
    const all = store.requests();
    return { total: all.length, items: all.slice(query.offset, query.offset + query.limit).map(request => {
      const attempts = store.attempts(request.id);
      return { ...request, attempts: attempts.length, estimatedCost: sumMoney(attempts, 'estimatedCost'), settledCost: sumMoney(attempts, 'settledCost'), equivalentUsd: attempts.every(a => a.equivalentUsd !== null) && attempts.length ? attempts.reduce((sum, a) => sum + a.equivalentUsd!, 0) : null };
    }) };
  });
  app.get('/api/admin/requests/:id', async req => { const request = store.request(idParam(req)); if (!request) throw new GatewayError('not_found', '请求不存在', 404); return { request, attempts: store.attempts(request.id) }; });
  app.get('/api/admin/overview', async () => {
    const china = new Date(Date.now() + 8 * 3_600_000); const start = new Date(`${china.toISOString().slice(0, 10)}T00:00:00+08:00`).toISOString();
    const requests = store.requests(start); const ids = new Set(requests.map(r => r.id)); const attempts = store.attempts().filter(a => ids.has(a.requestId));
    return { accounts: store.accounts().filter(a => a.enabled).length, models: providers.catalog().models.length, requests: requests.length, attempts: attempts.length,
      paidCny: roundCny(store.bills().reduce((sum, b) => sum + b.amountCny, 0)),
      estimatedUsd: attempts.filter(a => !a.settledCost && a.estimatedCost?.currency === 'USD').reduce((sum, a) => sum + a.estimatedCost!.amount, 0),
      settledUsd: attempts.filter(a => a.settledCost?.currency === 'USD').reduce((sum, a) => sum + a.settledCost!.amount, 0),
      equivalentUsd: attempts.reduce((sum, a) => sum + (a.equivalentUsd ?? 0), 0), unknownAttempts: attempts.filter(a => !a.settledCost && !a.estimatedCost).length,
      unknownEquivalentAttempts: attempts.filter(a => a.equivalentUsd === null).length,
      estimatedCost: sumMoney(attempts, 'estimatedCost'), settledCost: sumMoney(attempts, 'settledCost'),
    };
  });
  if (options.adminDist && existsSync(options.adminDist)) {
    await app.register(serveStatic, { root: options.adminDist, prefix: '/', index: 'index.html' });
    app.setNotFoundHandler((req, reply) => req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/v1/') ? reply.sendFile('index.html') : reply.code(404).send({ error: { code: 'not_found', message: '接口不存在' } }));
  }
  if (options.background !== false) providers.start();
  app.addHook('onClose', async () => { await providers.close(); await transport.close(); });
  return app;
}
function idParam(req: FastifyRequest): string { return (req.params as { id: string }).id; }
function requireAccount(store: Store, id: string): ProviderAccount { const account = store.account(id); if (!account) throw new GatewayError('not_found', '供应商不存在', 404); return account; }
function roundCny(value: number): number { return Math.round(value * 100) / 100; }
function publicProxy(value: string | undefined): string | undefined {
  if (!value) return undefined; const url = new URL(value); url.username = ''; url.password = ''; return url.href;
}
