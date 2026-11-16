import type {
  AuthorizationStatus,
  Balance,
  Discovery,
  Money,
  Price,
  PreparedRequest,
  Protocol,
  ProviderContext,
  ProviderModel,
  ProviderMonitor,
  ProviderPlugin,
  QuotaWindow,
  Usage,
} from '@moris/provider-sdk';
import { ProviderError } from './runtime.js';

const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ORIGINATOR = 'codex_cli_rs';
const MODELS_SOURCE =
  'https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/endpoint/models.rs（/models?client_version=）';
const LATEST_CLIENT_VERSION_URL = 'https://registry.npmjs.org/@openai/codex/latest';
/** 上游只返回 minimal_client_version 不高于 client_version 的模型，内置版本必须是一个真实发布过的新版本。 */
const FALLBACK_CLIENT_VERSION = '0.169.0';
const CLIENT_VERSION_TTL_MS = 6 * 3600_000;
let clientVersionCache: { version: string; at: number } | null = null;
const USAGE_SOURCE =
  'https://github.com/openai/codex/blob/main/codex-rs/backend-client/src/client/rate_limit_resets.rs（/wham/usage）';
const AUTH_SOURCE =
  'https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs（CLIENT_ID 与 refresh_token JSON 请求）';

type JsonObject = Record<string, unknown>;

interface IdClaims {
  accountId: string | null;
  planType: string | null;
  email: string | null;
  expiresAt: string | null;
}

function asObject(value: unknown): JsonObject | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function rootUrl(baseUrl: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function decodeJwt(token: string | undefined): JsonObject | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    return asObject(JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

/** Codex `token_data.rs` 从 id_token 的 `https://api.openai.com/auth` 读取这些 claim。 */
function claimsFromJwt(token: string | undefined): IdClaims {
  const payload = decodeJwt(token);
  const auth = asObject(payload?.['https://api.openai.com/auth']);
  const profile = asObject(payload?.['https://api.openai.com/profile']);
  const exp = asNumber(payload?.exp);
  return {
    accountId: asString(auth?.chatgpt_account_id),
    planType: asString(auth?.chatgpt_plan_type),
    email: asString(payload?.email) ?? asString(profile?.email),
    expiresAt: exp != null ? new Date(exp * 1000).toISOString() : null,
  };
}

function tokenExpiresAt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function authHeaders(accessToken: string, accountId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'chatgpt-account-id': accountId,
    originator: ORIGINATOR,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

async function postToken(
  context: ProviderContext,
  tokenUrl: string,
  clientId: string,
  refreshToken: string,
): Promise<JsonObject> {
  let response: Response;
  try {
    response = await context.fetch(tokenUrl, {
      method: 'POST',
      signal: context.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        refresh_reason: 'proactive_expiry',
      }),
    });
  } catch (error) {
    if (context.signal.aborted) throw new ProviderError('刷新请求已取消', 'aborted', 499);
    throw new ProviderError(`刷新访问令牌失败: ${error instanceof Error ? error.message : String(error)}`, 'network');
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ProviderError(`OAuth token 端点返回非 JSON（HTTP ${response.status}）`, 'invalid_response', response.status);
  }
  const object = asObject(body);
  if (!response.ok || object?.error) {
    const code = asString(object?.error);
    const description = asString(object?.error_description);
    throw new ProviderError(
      `OAuth 刷新被拒绝（HTTP ${response.status}${code ? `, ${code}` : ''}）${description ? `: ${description}` : ''}`,
      'oauth_refresh_rejected',
      response.status || 401,
    );
  }
  if (!object) throw new ProviderError('OAuth token 端点返回空响应', 'invalid_response', response.status);
  return object;
}

interface TokenState {
  accessToken: string;
  refreshToken: string;
  accountId: string;
  idToken?: string;
  planType?: string;
  expiresAt?: string;
}

export interface DeviceAuthorizationStart {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: string;
  clientId: string;
}

export interface DeviceAuthorizationPending {
  state: 'pending';
  intervalSeconds: number;
  message: string;
}

export interface DeviceAuthorizationComplete {
  state: 'complete';
  accountId: string;
  planType?: string;
  email?: string;
  expiresAt: string;
}

export type DeviceAuthorizationPoll = DeviceAuthorizationPending | DeviceAuthorizationComplete;

interface DevicePollInput {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds?: number;
}

function oauthIssuer(context: ProviderContext): string {
  return (asString(context.account.options.issuer) ?? 'https://auth.openai.com').replace(/\/+$/, '');
}

async function devicePost(
  context: ProviderContext,
  url: string,
  body: Record<string, unknown>,
  contentType: 'application/json' | 'application/x-www-form-urlencoded' = 'application/json',
): Promise<{ status: number; body: JsonObject | null }> {
  const encoded =
    contentType === 'application/x-www-form-urlencoded'
      ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString()
      : JSON.stringify(body);
  let response: Response;
  try {
    response = await context.fetch(url, {
      method: 'POST',
      signal: context.signal,
      headers: { 'Content-Type': contentType, Accept: 'application/json' },
      body: encoded,
    });
  } catch (error) {
    if (context.signal.aborted) throw new ProviderError('OAuth device flow 请求已取消', 'aborted', 499);
    throw new ProviderError(
      `OAuth device flow 请求失败: ${error instanceof Error ? error.message : String(error)}`,
      'network',
    );
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    throw new ProviderError(
      `OAuth device flow 返回非 JSON（HTTP ${response.status}）`,
      'invalid_response',
      response.status || 502,
    );
  }
  return { status: response.status, body: asObject(parsed) };
}

/**
 * Codex device authorization start（`codex-rs/login/src/device_code_auth.rs`）：
 * POST {issuer}/api/accounts/deviceauth/usercode {client_id}，返回 device_auth_id、
 * user_code、interval；用户打开 {issuer}/codex/device 输入一次性代码。
 * 该流程不依赖 localhost 回调，适合 Linux 远程服务器。
 */
export async function startDeviceAuthorization(context: ProviderContext): Promise<DeviceAuthorizationStart> {
  const issuer = oauthIssuer(context);
  const clientId = asString(context.account.options.clientId) ?? DEFAULT_CLIENT_ID;
  const response = await devicePost(context, `${issuer}/api/accounts/deviceauth/usercode`, { client_id: clientId });
  if (response.status === 404) {
    throw new ProviderError(
      '该 OAuth issuer 未启用 device code 登录；请确认 issuer 或改用浏览器 PKCE 登录辅助程序。',
      'device_flow_unavailable',
      404,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ProviderError(
      `device code 请求失败（HTTP ${response.status}）`,
      'device_flow_failed',
      response.status || 502,
    );
  }
  const deviceAuthId = asString(response.body?.device_auth_id);
  const userCode = asString(response.body?.user_code) ?? asString(response.body?.usercode);
  const intervalRaw = response.body?.interval;
  const interval = asNumber(intervalRaw) ?? (typeof intervalRaw === 'string' ? Number(intervalRaw) : NaN);
  if (!deviceAuthId || !userCode) {
    throw new ProviderError('device code 响应缺少 device_auth_id/user_code', 'invalid_response', 502);
  }
  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${issuer}/codex/device`,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 5,
    expiresAt: new Date(context.now().getTime() + 15 * 60_000).toISOString(),
    clientId,
  };
}

/**
 * 单次轮询 device auth；403/404 按 Codex 源码视为 pending，不在这里 sleep。
 * 管理员 API 应按 intervalSeconds 调度，超时时间由调用方控制。
 * 成功拿到 authorization_code 后立即用表单换 token，并写入 ctx.updateSecrets。
 */
export async function pollDeviceAuthorization(
  context: ProviderContext,
  input: DevicePollInput | string,
  userCode?: string,
  intervalSeconds?: number,
): Promise<DeviceAuthorizationPoll> {
  const grant: DevicePollInput =
    typeof input === 'string' ? { deviceAuthId: input, userCode: userCode ?? '', intervalSeconds } : input;
  const issuer = oauthIssuer(context);
  const clientId = asString(context.account.options.clientId) ?? DEFAULT_CLIENT_ID;
  if (!grant.deviceAuthId || !grant.userCode) {
    throw new ProviderError('pollDeviceAuthorization 需要 deviceAuthId 和 userCode', 'invalid_request', 400);
  }
  const poll = await devicePost(context, `${issuer}/api/accounts/deviceauth/token`, {
    device_auth_id: grant.deviceAuthId,
    user_code: grant.userCode,
  });
  if (poll.status === 403 || poll.status === 404) {
    return {
      state: 'pending',
      intervalSeconds: grant.intervalSeconds && grant.intervalSeconds > 0 ? grant.intervalSeconds : 5,
      message: '用户尚未完成 device authorization，继续轮询',
    };
  }
  if (poll.status < 200 || poll.status >= 300) {
    throw new ProviderError(
      `device authorization 轮询失败（HTTP ${poll.status}）`,
      'device_flow_failed',
      poll.status || 502,
    );
  }
  const authorizationCode = asString(poll.body?.authorization_code);
  const codeVerifier = asString(poll.body?.code_verifier);
  if (!authorizationCode || !codeVerifier) {
    throw new ProviderError(
      'device authorization 成功响应缺少 authorization_code/code_verifier',
      'invalid_response',
      502,
    );
  }

  const tokenResponse = await devicePost(
    context,
    `${issuer}/oauth/token`,
    {
      grant_type: 'authorization_code',
      client_id: clientId,
      code: authorizationCode,
      redirect_uri: `${issuer}/deviceauth/callback`,
      code_verifier: codeVerifier,
    },
    'application/x-www-form-urlencoded',
  );
  if (tokenResponse.status < 200 || tokenResponse.status >= 300 || tokenResponse.body?.error) {
    throw new ProviderError(
      `device authorization 换 token 被拒绝（HTTP ${tokenResponse.status}${asString(tokenResponse.body?.error) ? `, ${asString(tokenResponse.body?.error)}` : ''}）`,
      'oauth_exchange_rejected',
      tokenResponse.status || 401,
    );
  }
  const accessToken = asString(tokenResponse.body?.access_token);
  const refreshToken = asString(tokenResponse.body?.refresh_token);
  const idToken = asString(tokenResponse.body?.id_token);
  if (!accessToken || !refreshToken) {
    throw new ProviderError('device authorization 换 token 响应缺少 access_token/refresh_token', 'invalid_response', 502);
  }
  const idClaims = claimsFromJwt(idToken ?? undefined);
  const accessClaims = claimsFromJwt(accessToken);
  const accountId = idClaims.accountId ?? accessClaims.accountId;
  if (!accountId) {
    throw new ProviderError('device authorization 令牌缺少 chatgpt_account_id', 'account_id_missing', 401);
  }
  const planType = idClaims.planType ?? accessClaims.planType ?? undefined;
  const email = idClaims.email ?? accessClaims.email ?? undefined;
  const expiresAt = accessClaims.expiresAt ?? idClaims.expiresAt ?? new Date(context.now().getTime() + 3600_000).toISOString();
  const patch: Record<string, string> = {
    accessToken,
    refreshToken,
    accountId,
    expiresAt,
  };
  if (idToken) patch.idToken = idToken;
  if (planType) patch.planType = planType;
  await context.updateSecrets(patch);
  return { state: 'complete', accountId, planType, email, expiresAt };
}


async function ensureTokens(context: ProviderContext): Promise<TokenState> {
  let accessToken = asString(context.secrets.accessToken) ?? '';
  let refreshToken = asString(context.secrets.refreshToken) ?? '';
  let idToken = asString(context.secrets.idToken) ?? undefined;
  let accountId = asString(context.secrets.accountId) ?? '';
  let planType = asString(context.secrets.planType) ?? undefined;

  const idClaims = claimsFromJwt(idToken);
  const accessClaims = claimsFromJwt(accessToken);
  let claims: IdClaims = {
    accountId: idClaims.accountId ?? accessClaims.accountId,
    planType: idClaims.planType ?? accessClaims.planType,
    email: idClaims.email ?? accessClaims.email,
    expiresAt: accessClaims.expiresAt ?? idClaims.expiresAt,
  };
  if (!accountId) accountId = claims.accountId ?? '';
  if (!planType) planType = claims.planType ?? undefined;

  const expiresAtMs =
    tokenExpiresAt(asString(context.secrets.expiresAt) ?? undefined) ?? tokenExpiresAt(claims.expiresAt ?? undefined);
  const needsRefresh = !accessToken || (expiresAtMs != null && expiresAtMs <= context.now().getTime() + 5 * 60_000);

  if (needsRefresh) {
    if (!refreshToken) {
      throw new ProviderError(
        'OpenAI 订阅需要专用 OAuth 授权服务提供 accessToken/refreshToken；本插件只实现 refresh token 刷新，不伪造登录成功。',
        'oauth_login_required',
        401,
      );
    }
    const tokenUrl = asString(context.account.options.tokenUrl) ?? `${oauthIssuer(context)}/oauth/token`;
    const clientId = asString(context.account.options.clientId) ?? DEFAULT_CLIENT_ID;
    const refreshed = await postToken(context, tokenUrl, clientId, refreshToken);
    const nextAccessToken = asString(refreshed.access_token);
    if (!nextAccessToken) throw new ProviderError('OAuth 刷新响应缺少 access_token', 'invalid_response', 502);
    const nextRefreshToken = asString(refreshed.refresh_token) ?? refreshToken;
    const nextIdToken = asString(refreshed.id_token) ?? idToken;
    const nextIdClaims = claimsFromJwt(nextIdToken);
    const nextAccessClaims = claimsFromJwt(nextAccessToken);
    const nextClaims: IdClaims = {
      accountId: nextIdClaims.accountId ?? nextAccessClaims.accountId,
      planType: nextIdClaims.planType ?? nextAccessClaims.planType,
      email: nextIdClaims.email ?? nextAccessClaims.email,
      expiresAt: nextAccessClaims.expiresAt ?? nextIdClaims.expiresAt,
    };
    const nextAccountId = nextClaims.accountId ?? accountId;
    if (!nextAccountId) {
      throw new ProviderError(
        'OAuth 令牌缺少 chatgpt_account_id；请在专用 OAuth 服务中一并保存 accountId。',
        'account_id_missing',
        401,
      );
    }
    const patch: Record<string, string> = {
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      accountId: nextAccountId,
      expiresAt: nextClaims.expiresAt ?? new Date(context.now().getTime() + 3600_000).toISOString(),
    };
    if (nextIdToken) patch.idToken = nextIdToken;
    if (nextClaims.planType) patch.planType = nextClaims.planType;
    await context.updateSecrets(patch);
    accessToken = nextAccessToken;
    refreshToken = nextRefreshToken;
    idToken = nextIdToken;
    accountId = nextAccountId;
    planType = nextClaims.planType ?? planType;
    claims = nextClaims;
  }

  if (!accountId) {
    throw new ProviderError(
      'OAuth 令牌缺少 chatgpt_account_id；OpenAI 订阅请求需要该请求头。',
      'account_id_missing',
      401,
    );
  }
  return { accessToken, refreshToken, accountId, idToken, planType, expiresAt: claims.expiresAt ?? undefined };
}

async function fetchJson(
  context: ProviderContext,
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await context.fetch(url, { signal: context.signal, headers });
  } catch (error) {
    if (context.signal.aborted) throw new ProviderError('上游请求已取消', 'aborted', 499);
    throw new ProviderError(`请求 ${url} 失败: ${error instanceof Error ? error.message : String(error)}`, 'network');
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ProviderError(`上游 ${url} 返回非 JSON（HTTP ${response.status}）`, 'invalid_response', response.status);
  }
  if (!response.ok) {
    const object = asObject(body);
    const error = asObject(object?.error);
    throw new ProviderError(
      asString(error?.message) ?? asString(object?.message) ?? `上游 ${url} 返回 HTTP ${response.status}`,
      'upstream_http',
      response.status,
    );
  }
  return body;
}

async function loadModelsDev(context: ProviderContext): Promise<JsonObject | null> {
  if (context.account.options.modelsDev === false) return null;
  const url = asString(context.account.options.modelsDevUrl) ?? 'https://models.dev/api.json';
  try {
    const response = await context.fetch(url, { signal: context.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return asObject(await response.json());
  } catch {
    return null;
  }
}

function modelsDevModel(
  catalog: JsonObject | null,
  modelId: string,
): JsonObject | null {
  if (!catalog) return null;
  const providerId = asString(catalog.__providerHint) ?? 'openai';
  const provider = asObject(catalog[providerId]);
  const model = asObject(provider?.models)?.[modelId];
  return asObject(model) ?? null;
}

function referencePriceFromModelsDev(model: JsonObject | null): Price | undefined {
  const cost = asObject(model?.cost);
  if (!cost) return undefined;
  const input = asNumber(cost.input);
  const output = asNumber(cost.output);
  const cacheRead = asNumber(cost.cache_read) ?? undefined;
  const cacheWrite = asNumber(cost.cache_write) ?? undefined;
  if (input == null || output == null) return undefined;
  const hasTiers = asArray(cost.tiers).length > 0 || cost.context_over_200k != null;
  if (hasTiers) {
    return {
      kind: 'complex',
      currency: 'USD',
      expression: `models.dev:${JSON.stringify(cost)}`,
      source: 'https://models.dev/api.json',
    };
  }
  return {
    kind: 'token',
    currency: 'USD',
    input,
    output,
    ...(cacheRead != null ? { cacheRead } : {}),
    ...(cacheWrite != null ? { cacheWrite } : {}),
    source: 'https://models.dev/api.json',
  };
}

function usageNumbers(usage: Usage): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  const input = Number(usage.input);
  const output = Number(usage.output);
  const cacheRead = Number(usage.cacheRead);
  const cacheWrite = Number(usage.cacheWrite);
  if (![input, output, cacheRead, cacheWrite].every((value) => Number.isFinite(value) && value >= 0)) return null;
  if (cacheRead + cacheWrite > input) return null;
  return { input, output, cacheRead, cacheWrite };
}

function estimateModelsDevReference(cost: JsonObject, usage: Usage): number | null {
  const numbers = usageNumbers(usage);
  if (!numbers) return null;
  // Usage.input 契约已包含缓存 token；上下文阶梯阈值直接使用 input，不能再加缓存。
  const prompt = numbers.input;
  let band = cost;
  for (const rawTier of asArray(cost.tiers)) {
    const tier = asObject(rawTier);
    const threshold = asNumber(asObject(tier?.tier)?.size);
    if (tier && threshold != null && prompt > threshold) band = tier;
  }
  const input = asNumber(band.input);
  const output = asNumber(band.output);
  if (input == null || output == null) return null;
  const cacheReadPrice = asNumber(band.cache_read);
  const cacheWritePrice = asNumber(band.cache_write);
  const { cacheRead, cacheWrite } = numbers;
  if (cacheRead > 0 && cacheReadPrice == null) return null;
  if (cacheWrite > 0 && cacheWritePrice == null) return null;
  const normalInput = Math.max(numbers.input - cacheRead - cacheWrite, 0);
  const amount =
    (normalInput * input +
      cacheRead * (cacheReadPrice ?? 0) +
      cacheWrite * (cacheWritePrice ?? 0) +
      numbers.output * output) /
    1_000_000;
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function tokenCost(price: Price, usage: Usage): Money | null {
  if (price.kind === 'request') {
    return price.perRequest == null ? null : { amount: price.perRequest, currency: price.currency };
  }
  if (price.kind === 'complex' && price.expression?.startsWith('models.dev:')) {
    try {
      const cost = asObject(JSON.parse(price.expression.slice('models.dev:'.length)));
      if (!cost) return null;
      const amount = estimateModelsDevReference(cost, usage);
      return amount == null ? null : { amount, currency: price.currency };
    } catch {
      return null;
    }
  }
  if (price.kind !== 'token') return null;
  if (price.input == null || price.output == null) return null;
  const numbers = usageNumbers(usage);
  if (!numbers) return null;
  const { input, output, cacheRead, cacheWrite } = numbers;
  if (cacheRead > 0 && price.cacheRead == null) return null;
  if (cacheWrite > 0 && price.cacheWrite == null) return null;
  const normalInput = Math.max(input - cacheRead - cacheWrite, 0);
  const amount =
    (normalInput * price.input +
      cacheRead * (price.cacheRead ?? 0) +
      cacheWrite * (price.cacheWrite ?? 0) +
      output * price.output) /
    1_000_000;
  return Number.isFinite(amount) && amount >= 0 ? { amount, currency: price.currency } : null;
}

function subscriptionPrice(): Price {
  return {
    kind: 'token',
    currency: 'USD',
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    source: 'OpenAI ChatGPT 订阅：客户端 cost=0；API 等价参考价见 referencePrice',
  };
}

/** 取一次 /models 目录；client_version 同时写进 UA，行为与 Codex CLI 一致。 */
async function fetchModelCatalog(
  context: ProviderContext,
  tokens: TokenState,
  clientVersion: string,
): Promise<JsonObject[]> {
  const base = rootUrl(context.account.baseUrl);
  const body = await fetchJson(context, `${base}/models?client_version=${encodeURIComponent(clientVersion)}`, {
    ...authHeaders(tokens.accessToken, tokens.accountId),
    'user-agent': `${ORIGINATOR}/${clientVersion}`,
  });
  return asArray(asObject(body)?.models)
    .map((item) => asObject(item))
    .filter((item): item is JsonObject => !!item);
}

/**
 * 官方 Codex CLI 的最新发布版本，用来在空目录时纠正过低的 client_version。
 * 取不到时返回 null，由调用方保留内置版本并给出可诊断的错误。
 */
async function latestClientVersion(context: ProviderContext): Promise<string | null> {
  if (clientVersionCache && context.now().getTime() - clientVersionCache.at < CLIENT_VERSION_TTL_MS) {
    return clientVersionCache.version;
  }
  const url = asString(context.account.options.clientVersionUrl) ?? LATEST_CLIENT_VERSION_URL;
  try {
    const response = await context.fetch(url, { signal: context.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const version = asString(asObject(await response.json())?.version);
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return null;
    clientVersionCache = { version, at: context.now().getTime() };
    return version;
  } catch {
    return null;
  }
}

async function discover(context: ProviderContext): Promise<Discovery> {
  const tokens = await ensureTokens(context);
  const override = asString(context.account.options.clientVersion);
  let clientVersion = override ?? FALLBACK_CLIENT_VERSION;
  let modelsRaw = await fetchModelCatalog(context, tokens, clientVersion);
  // 空目录先按真实的 Codex CLI 最新版本重试一次：上游按 minimal_client_version 逐模型过滤，
  // 版本过低时 HTTP 200 但返回 {"models":[]}，不能当成“账号没有模型”。
  if (!modelsRaw.length && !override) {
    const latest = await latestClientVersion(context);
    if (latest && latest !== clientVersion) {
      clientVersion = latest;
      modelsRaw = await fetchModelCatalog(context, tokens, clientVersion);
    }
  }
  if (!modelsRaw.length) {
    throw new ProviderError(
      `OpenAI 订阅 /models 返回空目录（client_version=${clientVersion}）：上游按每个模型的 minimal_client_version 过滤，客户端版本过低或该账号无可用模型都会得到空列表。可在供应商选项 clientVersion 中指定版本后重试。`,
      'catalog_empty',
    );
  }

  const modelsDev = await loadModelsDev(context);
  if (modelsDev) modelsDev.__providerHint = asString(context.account.options.modelsDevProvider) ?? 'openai';
  const models: ProviderModel[] = [];
  for (const raw of modelsRaw) {
    const id = asString(raw.slug);
    if (!id) continue;
    if (raw.supported_in_api === false) continue;
    const visibility = asString(raw.visibility);
    if (visibility && visibility !== 'list') continue;
    const dev = modelsDevModel(modelsDev, id);
    const devLimit = asObject(dev?.limit);
    const devModalities = asObject(dev?.modalities);
    const input = asArray(devModalities?.input).filter(
      (value): value is 'text' | 'image' => value === 'text' || value === 'image',
    );
    const levels = asArray(raw.supported_reasoning_levels)
      .map((level) => asString(asObject(level)?.effort))
      .filter((level): level is string => !!level);
    const variants: Record<string, Record<string, unknown>> = {};
    for (const level of levels) variants[level] = { reasoning: { effort: level } };
    // Codex 的 context_window 是这条订阅路线的**输入**预算（gpt-6.1-* 500k、其余 272k）；
    // OpenAI 的口径是 total = 最大输入 + 最大输出（6.1 Sol：922k + 128k = 1.05M），
    // 所以总窗口 = context_window + max_output_tokens，gpt-6.1 得 628k、其余 400k。
    // models.dev 的 limit.input/context 是 API 口径（922k/1.05M），不能拿来当订阅预算。
    const inputLimit = asNumber(raw.context_window);
    const outputLimit = asNumber(raw.max_output_tokens) ?? asNumber(devLimit?.output);
    const contextWindow =
      inputLimit != null && outputLimit != null
        ? inputLimit + outputLimit
        : (inputLimit ?? asNumber(devLimit?.context));
    const tools =
      typeof raw.supports_parallel_tool_calls === 'boolean'
        ? raw.supports_parallel_tool_calls
        : raw.tool_mode != null
          ? true
          : typeof dev?.tool_call === 'boolean'
            ? dev.tool_call
            : null;
    const family =
      asString(dev?.family) ??
      (id.startsWith('codex-') ? 'codex' : 'gpt');
    const referencePrice =
      referencePriceFromModelsDev(dev) ??
      ({
        kind: 'unknown',
        currency: 'USD',
        source: 'models.dev 未提供该模型的 API 参考价；不要把订阅 price=0 当作免费 API 等价',
      } satisfies Price);
    const reasons: string[] = [];
    if (contextWindow == null) reasons.push('上下文长度未知');
    if (outputLimit == null) reasons.push('最大输出未知');
    if (tools == null) reasons.push('工具能力未知');
    const enabled = reasons.length === 0;

    models.push({
      path: id,
      upstreamModel: id,
      name: asString(raw.display_name) ?? id,
      family,
      protocol: 'responses',
      capabilities: {
        tools: tools === true,
        input: input.length ? input : ['text'],
        output: ['text'],
        reasoning: levels.length > 0 || dev?.reasoning === true,
      },
      limit: { context: contextWindow, output: outputLimit, ...(inputLimit != null ? { input: inputLimit } : {}) },
      variants,
      price: subscriptionPrice(),
      ...(referencePrice ? { referencePrice } : {}),
      enabled,
      available: true,
      unknownParameters: tools == null ? ['tools'] : [],
      ...(!enabled ? { disabledReason: reasons.join('；') } : {}),
      sources: {
        models: MODELS_SOURCE,
        auth: AUTH_SOURCE,
        referencePrice: referencePrice.kind === 'unknown' ? '' : 'https://models.dev/api.json',
      },
    });
  }

  return {
    models,
    complete: true,
    warnings: [
      'OpenAI 订阅只生成 Responses 协议模型；OAuth 登录必须由专用授权服务完成，本插件只使用已有 accessToken/refreshToken 刷新。',
    ],
  };
}

async function prepare(
  context: ProviderContext,
  model: ProviderModel,
  body: Record<string, unknown>,
  protocol: Protocol,
): Promise<PreparedRequest> {
  if (protocol !== 'responses' || model.protocol !== 'responses') {
    throw new ProviderError('OpenAI 订阅模型只支持 Responses 协议', 'protocol_mismatch', 400);
  }
  const tokens = await ensureTokens(context);
  const next: Record<string, unknown> = { ...body, model: model.upstreamModel };
  for (const key of [
    'authorization',
    'Authorization',
    'api_key',
    'apiKey',
    'base_url',
    'baseUrl',
    'url',
    'max_output_tokens',
    'max_tokens',
    'max_completion_tokens',
  ]) {
    delete next[key];
  }
  // Codex Responses 请求固定 store:false、stream:true（codex-rs/core/src/client.rs）。
  // ChatGPT Codex 后端按流式响应；非流式客户端由核心按 responseFormat='sse' 聚合 response.completed.response。
  next.store = false;
  next.stream = true;
  return {
    url: `${rootUrl(context.account.baseUrl)}/responses`,
    headers: authHeaders(tokens.accessToken, tokens.accountId),
    body: next,
    responseFormat: 'sse',
  };
}

function windowFromPayload(
  payload: JsonObject | null,
  id: string,
  name: string,
  pool: string,
  sampledAt: string,
): QuotaWindow | null {
  if (!payload) return null;
  const usedPercent = asNumber(payload.used_percent);
  const seconds = asNumber(payload.limit_window_seconds);
  const reset = asNumber(payload.reset_at);
  if (usedPercent == null || seconds == null || seconds <= 0 || reset == null) return null;
  const resetMs = reset * 1000;
  return {
    id,
    name,
    pool,
    startsAt: new Date(resetMs - seconds * 1000).toISOString(),
    resetsAt: new Date(resetMs).toISOString(),
    usedRatio: Math.min(1, Math.max(0, usedPercent / 100)),
    sampledAt,
  };
}

async function monitor(context: ProviderContext): Promise<ProviderMonitor> {
  const sampledAt = context.now().toISOString();
  try {
    const tokens = await ensureTokens(context);
    const base = rootUrl(context.account.baseUrl);
    const origin = new URL(base).origin;
    const usageUrl = `${origin}/backend-api/wham/usage`;
    const body = await fetchJson(context, usageUrl, authHeaders(tokens.accessToken, tokens.accountId));
    const object = asObject(body);
    if (!object) return { state: 'unknown', balances: [], windows: [], sampledAt, message: 'usage 响应不是对象' };

    const planType = asString(object.plan_type) ?? tokens.planType ?? 'unknown';
    const windows: QuotaWindow[] = [];
    const rateLimit = asObject(object.rate_limit);
    const primary = windowFromPayload(asObject(rateLimit?.primary_window), 'primary', 'primary', 'default', sampledAt);
    const secondary = windowFromPayload(asObject(rateLimit?.secondary_window), 'secondary', 'secondary', 'default', sampledAt);
    if (primary) windows.push(primary);
    if (secondary) windows.push(secondary);
    for (const raw of asArray(object.additional_rate_limits)) {
      const additional = asObject(raw);
      const details = asObject(additional?.rate_limit);
      const limitName = asString(additional?.limit_name) ?? asString(additional?.metered_feature) ?? 'additional';
      const pool = `openai:additional:${limitName}`;
      const window =
        windowFromPayload(asObject(details?.primary_window), `additional:${limitName}`, limitName, pool, sampledAt) ??
        windowFromPayload(asObject(details?.secondary_window), `additional:${limitName}:secondary`, `${limitName} secondary`, pool, sampledAt);
      if (window) windows.push(window);
    }

    const balances: Balance[] = [];
    const credits = asObject(object.credits);
    const creditBalance = asNumber(credits?.balance);
    if (credits?.has_credits === true && creditBalance != null) {
      balances.push({ currency: 'credits', amount: creditBalance, unit: 'balance' });
    }

    const planOption = asObject(context.account.options.planPrice);
    const planAmount = asNumber(planOption?.amount);
    const planCurrency = asString(planOption?.currency);
    const planPrice =
      planAmount != null && planCurrency
        ? { amount: planAmount, currency: planCurrency, source: 'account.options.planPrice' }
        : undefined;

    return {
      state: 'ok',
      balances,
      windows,
      sampledAt,
      message: [
        `OpenAI 订阅窗口来自 /wham/usage；plan_type=${planType}`,
        credits?.unlimited === true ? 'credits unlimited' : '',
        '窗口百分比包含网关外使用',
      ]
        .filter(Boolean)
        .join('；'),
      ...(planPrice ? { planPrice } : {}),
    };
  } catch (error) {
    return {
      state: context.signal.aborted ? 'unknown' : 'error',
      balances: [],
      windows: [],
      sampledAt,
      message: context.signal.aborted ? '额度查询已取消' : '额度查询失败，保留上次可用数据；详情见服务端日志',
    };
  }
}

function estimate(price: Price, usage: Usage): Money | null {
  if (price.kind === 'complex' && price.expression?.startsWith('models.dev:')) {
    try {
      const cost = asObject(JSON.parse(price.expression.slice('models.dev:'.length)));
      if (!cost) return null;
      const amount = estimateModelsDevReference(cost, usage);
      return amount == null ? null : { amount, currency: price.currency };
    } catch {
      return null;
    }
  }
  return tokenCost(price, usage);
}

async function status(context: ProviderContext): Promise<AuthorizationStatus> {
  const accessToken = asString(context.secrets.accessToken) ?? undefined;
  const refreshToken = asString(context.secrets.refreshToken) ?? undefined;
  const idClaims = claimsFromJwt(asString(context.secrets.idToken) ?? undefined);
  const accessClaims = claimsFromJwt(accessToken);
  const accountId =
    asString(context.secrets.accountId) ?? idClaims.accountId ?? accessClaims.accountId ?? undefined;
  const planType =
    asString(context.secrets.planType) ?? idClaims.planType ?? accessClaims.planType ?? undefined;
  const email = idClaims.email ?? accessClaims.email ?? undefined;
  const expiresAt =
    asString(context.secrets.expiresAt) ?? accessClaims.expiresAt ?? idClaims.expiresAt ?? undefined;
  // refreshToken + accountId 才能持续刷新；只存 accessToken 不算完成授权。
  return {
    authorized: Boolean(refreshToken && accountId),
    ...(accountId ? { accountId } : {}),
    ...(planType ? { planType } : {}),
    ...(email ? { email } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export const plugin: ProviderPlugin = {
  id: 'openai-subscription',
  name: 'OpenAI 订阅（ChatGPT OAuth）',
  setup: {
    baseUrl: {
      default: DEFAULT_BASE_URL,
      hint: 'ChatGPT Codex 后端地址，通常保持默认；需要走自建反代时才修改。代理请填在「网络代理」，不要写进 Base URL。',
    },
    billingType: { default: 'subscription', hint: '订阅账号按订阅窗口计量，不按 token 现金扣费；API 等价价值仅作参考。' },
    secrets: [
      { key: 'refreshToken', label: 'refreshToken', required: true, description: '设备授权成功后自动写入，用于刷新访问令牌；手工粘贴时必需。' },
      { key: 'accountId', label: 'accountId', required: true, description: 'ChatGPT 账户 ID；授权后自动写入，也可从 id_token 的 chatgpt_account_id 读取。' },
      { key: 'accessToken', label: 'accessToken', description: '设备授权成功后由服务端自动写入；一般不要手工填写。' },
      { key: 'expiresAt', label: 'expiresAt', description: '访问令牌到期时间；授权或刷新时自动维护。' },
      { key: 'planType', label: 'planType', description: '订阅套餐标识；授权后自动写入，仅用于展示。' },
      { key: 'idToken', label: 'idToken', description: '可选。设备授权返回时自动保存，用于读取账户与套餐信息。' },
    ],
    options: {
      example: { issuer: 'https://auth.openai.com' },
      hint: '一般留空。只有使用自建授权/反代服务时才需要覆盖 issuer、tokenUrl 或 clientId。',
      fields: [
        { key: 'issuer', description: '设备授权与刷新令牌的 issuer，默认 https://auth.openai.com。' },
        { key: 'tokenUrl', description: '自定义刷新令牌地址；默认 issuer + /oauth/token。' },
        { key: 'clientId', description: 'OAuth 客户端 ID；默认与 Codex CLI 一致。' },
        { key: 'clientVersion', description: '/models 请求的 client_version，默认跟随 Codex CLI 最新发布版本（内置 0.169.0，空目录时自动按 npm 上的最新版本重试一次）；上游按每个模型的 minimal_client_version 过滤，版本过低会返回空目录。' },
        { key: 'clientVersionUrl', description: '可选，读取 Codex CLI 最新版本的地址，默认 https://registry.npmjs.org/@openai/codex/latest。' },
        { key: 'modelsDev / modelsDevUrl / modelsDevProvider', description: '可选的原厂参考价来源；只影响参考价，不影响订阅 price=0。' },
        { key: 'planPrice', description: '可选 {amount,currency}，用于余额页展示套餐标价。' },
      ],
    },
    tokenTemplate: { supported: false, hint: 'OpenAI 订阅不创建上游 API 令牌；凭据来自设备授权，模板不会生效。' },
    authorization: { supported: true, hint: '保存供应商后，在本页完成设备授权；授权请求也走这里的网络代理。' },
  },
  discover,
  prepare,
  monitor,
  estimate,
  authorization: {
    start: startDeviceAuthorization,
    poll: pollDeviceAuthorization,
    status,
  },
};

export default plugin;
