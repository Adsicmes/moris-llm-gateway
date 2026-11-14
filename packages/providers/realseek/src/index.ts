import { createHash } from 'node:crypto';
import type {
  Balance,
  Discovery,
  ManagedResource,
  ManagedResourceInput,
  Money,
  Price,
  PreparedRequest,
  Protocol,
  ProviderContext,
  ProviderModel,
  ProviderMonitor,
  ProviderPlugin,
  TokenTemplate,
  Usage,
} from '@moris/provider-sdk';
import { ProviderError, apiUrl, protocolPath } from './runtime.js';
import { evaluateBillingExpression } from './price-expression.js';

export { evaluateBillingExpression, parseBillingExpression, UnsupportedExpression } from './price-expression.js';

const DEFAULT_BASE_URL = 'https://newapi.example.com';
const DEFAULT_QUOTA_PER_UNIT = 500_000;
const SOURCE_LABEL = 'New API /api/pricing';
// 仅按站点明确的厂商名选择原厂目录；不根据模型名前缀猜测或去除别名后缀。
const OFFICIAL_MODELS_DEV: Record<string, string> = {
  OpenAI: 'openai', Anthropic: 'anthropic', DeepSeek: 'deepseek', xAI: 'xai', Google: 'google',
  Moonshot: 'moonshotai', '智谱': 'zhipuai', '阿里巴巴': 'alibaba-cn', MiniMax: 'minimax', '腾讯': 'tencent-tokenhub',
};

type JsonObject = Record<string, unknown>;

interface TokenRecord {
  id: number;
  name: string;
  group: string;
  key?: string;
  status?: number;
}

interface DiscoveredTokens {
  items: TokenRecord[];
  complete: boolean;
  warnings: string[];
}

/** 清理相关对外文案固定，不透传上游响应正文或任何密钥。 */
const CLEANUP_MESSAGE = {
  identity: '无法核验上游账号身份，请检查管理令牌与用户标识后重试。',
  list: '无法完整读取上游令牌清单，请检查管理权限后重试。',
  listBeforeDelete: '无法完整读取上游令牌清单，未执行删除；请稍后重试核验。',
  changed: '上游令牌信息与已记录归属不一致，已停止清理。',
  key: '无法核验上游令牌凭据，已停止清理。',
  rejected: '上游拒绝删除该令牌，未确认清理成功。',
  unknown: '上游删除结果未知，请稍后重新读取令牌清单确认。',
  cancelled: '清理已取消，上游结果未知。',
  deleted: '已删除上游令牌。',
  absent: '上游完整令牌清单已确认该令牌不存在。',
} as const;

interface UpstreamIdentity {
  base: string;
  userId: string;
  scope: string;
  secrets: Record<string, string>;
}

function identityScope(base: string, userId: string): string {
  return `newapi:${base}#user:${userId}`;
}

/** 与 SDK 的 credentialFingerprint 保持同一算法；插件产物不依赖 SDK 运行时。 */
function credentialFingerprint(value: string): string {
  return createHash('sha256').update(value.replace(/^sk-/, '')).digest('hex');
}

/** 仅名称以 moris 开头的令牌才进入清理候选；名称前缀不是创建证明。 */
function isMorisTokenName(name: string): boolean {
  return /^moris(?:[-_.]|$)/i.test(name.trim());
}

function resourceRecorder(context: ProviderContext): ((resource: ManagedResourceInput) => Promise<void>) | null {
  return typeof context.recordResource === 'function' ? context.recordResource.bind(context) : null;
}

function resourceInput(resource: ManagedResource): ManagedResourceInput {
  return {
    kind: resource.kind,
    scope: resource.scope,
    externalId: resource.externalId,
    name: resource.name,
    ...(resource.group ? { group: resource.group } : {}),
    ...(resource.fingerprint ? { fingerprint: resource.fingerprint } : {}),
    provenance: resource.provenance,
    ...(resource.credentialKey ? { credentialKey: resource.credentialKey } : {}),
  };
}

interface ModelOverride {
  context?: number | null;
  output?: number | null;
  input?: Array<'text' | 'image'>;
  tools?: boolean;
  reasoning?: boolean;
  family?: string;
  name?: string;
  protocol?: Protocol;
  variants?: Record<string, Record<string, unknown>>;
  enabled?: boolean;
}

interface ModelsDevProvider {
  models?: Record<string, JsonObject>;
}

interface ModelFacts {
  context: number | null;
  output: number | null;
  inputLimit?: number;
  input: Array<'text' | 'image'>;
  imageInputKnown?: boolean;
  tools: boolean | null;
  reasoning?: boolean;
  family: string;
  name?: string;
  protocol?: Protocol;
  variants: Record<string, Record<string, unknown>>;
  source: string;
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

function unwrap(body: unknown): unknown {
  const object = asObject(body);
  return object && 'data' in object ? object.data : body;
}

function rootUrl(baseUrl: string): string {
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/i, '');
}

function managementHeaders(secrets: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (secrets.accessToken) headers.Authorization = `Bearer ${secrets.accessToken}`;
  if (secrets.userId) headers['New-API-User'] = secrets.userId;
  return headers;
}

async function fetchJson(context: ProviderContext, url: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await context.fetch(url, { ...init, signal: context.signal });
  } catch (error) {
    if (context.signal.aborted) throw new ProviderError('上游请求已取消', 'aborted', 499);
    throw new ProviderError(`请求 ${url} 失败: ${error instanceof Error ? error.message : String(error)}`, 'network');
  }
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ProviderError(`上游 ${url} 返回非 JSON（HTTP ${response.status}）`, 'invalid_response', response.status || 502);
  }
  if (!response.ok) {
    const object = asObject(body);
    const message = asString(object?.message) ?? asString(asObject(object?.error)?.message);
    throw new ProviderError(message ?? `上游 ${url} 返回 HTTP ${response.status}`, 'upstream_http', response.status);
  }
  const object = asObject(body);
  if (object?.success === false) {
    throw new ProviderError(asString(object.message) ?? `上游 ${url} 返回 success=false`, 'upstream_rejected');
  }
  return body;
}

function decodeJwtUserId(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as JsonObject;
    const id = asNumber(payload.id) ?? asNumber(payload.sub);
    if (id != null && Number.isInteger(id) && id > 0) return String(id);
  } catch {
    // 访问令牌不一定是 JWT；只作为可选的 New-API-User 兼容头来源。
  }
  return null;
}

function templateFor(context: ProviderContext): TokenTemplate {
  const template = context.account.tokenTemplate;
  if (!template) {
    throw new ProviderError('autoCreateTokens 已开启，但没有配置完整的 tokenTemplate', 'token_template_missing', 400);
  }
  const quota = asNumber(template.quota);
  const expiresInDays = asNumber(template.expiresInDays);
  const namePrefix = asString(template.namePrefix);
  if (!namePrefix || quota == null || quota < 0 || expiresInDays == null || !Number.isInteger(expiresInDays) || expiresInDays < 0) {
    throw new ProviderError(
      'tokenTemplate 必须包含非空 namePrefix、非负 quota 和整数 expiresInDays',
      'token_template_invalid',
      400,
    );
  }
  if (!isMorisTokenName(namePrefix)) {
    throw new ProviderError(
      'tokenTemplate.namePrefix 必须以 moris 开头；本网关不新建其他前缀的令牌',
      'token_template_invalid',
      400,
    );
  }
  return { ...template, namePrefix, quota, expiresInDays };
}

function sanitizeNamePart(value: string): string {
  return value.replace(/[^\p{L}\p{N}_.-]+/gu, '-').replace(/^-+|-+$/g, '') || 'group';
}

function tokenName(template: TokenTemplate, group: string): string {
  return `${template.namePrefix}-${sanitizeNamePart(group)}`.slice(0, 50);
}

function tokenExpiredTime(template: TokenTemplate, now: Date): number {
  if (template.expiresInDays === 0) return -1;
  return Math.floor(now.getTime() / 1000) + template.expiresInDays * 86_400;
}

async function listTokens(context: ProviderContext, secrets: Record<string, string>): Promise<DiscoveredTokens> {
  const warnings: string[] = [];
  const items: TokenRecord[] = [];
  let page = 1;
  let total: number | null = null;
  let collected = 0;
  let complete = false;

  while (page <= 1000) {
    const url = `${rootUrl(context.account.baseUrl)}/api/token/?p=${page}&size=100`;
    const body = await fetchJson(context, url, { headers: managementHeaders(secrets) });
    const unwrapped = unwrap(body);
    const data = asObject(unwrapped);
    const pageItems = (Array.isArray(unwrapped) ? unwrapped : asArray(data?.items))
      .map((item) => asObject(item))
      .filter((item): item is JsonObject => !!item);
    const pageTotal = asNumber(data?.total);
    const pageSize = asNumber(data?.page_size) ?? 100;
    if (pageTotal != null) total = pageTotal;

    for (const item of pageItems) {
      const id = asNumber(item.id);
      const name = asString(item.name);
      const key = asString(item.key) ?? undefined;
      const group = asString(item.group) ?? 'default';
      if (id == null) continue;
      items.push({ id, name: name ?? `token-${id}`, group, key, status: asNumber(item.status) ?? undefined });
      collected += 1;
    }

    if (total != null && collected >= total) {
      complete = collected === total;
      if (!complete) warnings.push(`令牌分页数量不一致：total=${total}, 实际=${collected}`);
      break;
    }
    if (pageItems.length === 0) {
      complete = total == null ? true : collected >= total;
      if (!complete) warnings.push(`令牌分页在第 ${page} 页提前结束（total=${total}, 实际=${collected}）`);
      break;
    }
    if (total == null && pageItems.length < pageSize) {
      complete = true;
      break;
    }
    page += 1;
  }

  if (page > 1000) {
    complete = false;
    warnings.push('令牌分页超过 1000 页，未继续读取');
  }
  return { items, complete, warnings };
}

async function revealTokenKey(context: ProviderContext, secrets: Record<string, string>, token: TokenRecord): Promise<string | null> {
  if (token.key && !/[*…]/.test(token.key) && token.key.length >= 20) return token.key;
  try {
    const body = await fetchJson(context, `${rootUrl(context.account.baseUrl)}/api/token/${token.id}/key`, {
      method: 'POST',
      headers: managementHeaders(secrets),
    });
    const data = asObject(unwrap(body));
    return asString(data?.key) ?? asString(asObject(body)?.key);
  } catch {
    return null;
  }
}

async function readIdentity(context: ProviderContext): Promise<UpstreamIdentity> {
  const base = rootUrl(context.account.baseUrl);
  const secrets = context.secrets;
  if (!secrets.accessToken) throw new ProviderError(CLEANUP_MESSAGE.identity, 'cleanup_identity', 502);
  let self: JsonObject | null = null;
  try {
    const body = await fetchJson(context, `${base}/api/user/self`, { headers: managementHeaders(secrets) });
    self = asObject(unwrap(body));
  } catch {
    throw new ProviderError(CLEANUP_MESSAGE.identity, 'cleanup_identity', 502);
  }
  const userId = asNumber(self?.id);
  if (userId == null || !Number.isInteger(userId) || userId <= 0) {
    throw new ProviderError(CLEANUP_MESSAGE.identity, 'cleanup_identity', 502);
  }
  return { base, userId: String(userId), scope: identityScope(base, String(userId)), secrets };
}

async function readCompleteTokens(context: ProviderContext, secrets: Record<string, string>): Promise<DiscoveredTokens> {
  try {
    const list = await listTokens(context, secrets);
    if (!list.complete) throw new ProviderError(CLEANUP_MESSAGE.list, 'cleanup_list_incomplete', 502);
    return list;
  } catch (error) {
    if (error instanceof ProviderError && error.code === 'aborted') {
      throw new ProviderError('清理已取消。', 'aborted', 499);
    }
    throw new ProviderError(CLEANUP_MESSAGE.list, 'cleanup_list_unavailable', 502);
  }
}

async function createToken(
  context: ProviderContext,
  secrets: Record<string, string>,
  quotaPerUnit: number,
  template: TokenTemplate,
  group: string,
  name: string,
): Promise<void> {
  const unlimited = template.unlimited === true;
  const payload = {
    name,
    unlimited_quota: unlimited,
    expired_time: tokenExpiredTime(template, context.now()),
    remain_quota: unlimited ? 0 : Math.round(template.quota * quotaPerUnit),
    allow_ips: '',
    model_limits_enabled: false,
    model_limits: '',
    group,
    cross_group_retry: false,
  };
  await fetchJson(context, `${rootUrl(context.account.baseUrl)}/api/token/`, {
    method: 'POST',
    headers: { ...managementHeaders(secrets), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function loadModelsDev(context: ProviderContext): Promise<JsonObject | null> {
  if (context.account.options.modelsDev !== true) return null;
  const url = asString(context.account.options.modelsDevUrl) ?? 'https://models.dev/api.json';
  try {
    const response = await context.fetch(url, { signal: context.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const body = await response.json();
    return asObject(body);
  } catch {
    return null;
  }
}

function modelsDevFacts(
  catalog: JsonObject | null,
  modelName: string,
  providerHint: string | null,
): { facts: Partial<ModelFacts>; source: string } | null {
  if (!catalog) return null;
  const candidates: Array<{ provider: string; model: JsonObject }> = [];
  for (const [provider, rawProvider] of Object.entries(catalog)) {
    const model = asObject(asObject(rawProvider)?.models)?.[modelName];
    const object = asObject(model);
    if (object) candidates.push({ provider, model: object });
  }
  if (candidates.length === 0) return null;
  const chosen = providerHint
    ? candidates.find((candidate) => candidate.provider === providerHint)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!chosen) return null;

  const limit = asObject(chosen.model.limit);
  const modalities = asObject(chosen.model.modalities);
  const inputModalities = asArray(modalities?.input).filter(
    (item): item is 'text' | 'image' => item === 'text' || item === 'image',
  );
  const context = asNumber(limit?.context);
  const output = asNumber(limit?.output);
  const inputLimit = asNumber(limit?.input);
  const toolCall = typeof chosen.model.tool_call === 'boolean' ? chosen.model.tool_call : null;
  const family = asString(chosen.model.family);
  const name = asString(chosen.model.name);
  return {
    source: `models.dev:${chosen.provider}/${modelName}`,
    facts: {
      context,
      output,
      input: inputModalities.length ? inputModalities : undefined,
      imageInputKnown: Array.isArray(modalities?.input),
      tools: toolCall,
      reasoning: typeof chosen.model.reasoning === 'boolean' ? chosen.model.reasoning : undefined,
      family: family ?? undefined,
      name: name ?? undefined,
      variants: {},
      ...(inputLimit != null ? { inputLimit } : {}),
    },
  };
}

function overrideFact(value: unknown, key: keyof ModelOverride): unknown {
  const object = asObject(value);
  return object ? object[key] : undefined;
}

function modelFacts(
  modelName: string,
  group: string,
  vendorName: string | null,
  overrideMap: JsonObject | null,
  modelsDevCatalog: JsonObject | null,
  modelsDevProvider: string | null,
): ModelFacts {
  const override =
    asObject(overrideMap?.[`${group}/${modelName}`]) ?? asObject(overrideMap?.[modelName]) ?? null;
  const dev = modelsDevFacts(modelsDevCatalog, modelName, modelsDevProvider);
  const devFacts = dev?.facts ?? {};

  const context = asNumber(overrideFact(override, 'context')) ?? devFacts.context ?? null;
  const output = asNumber(overrideFact(override, 'output')) ?? devFacts.output ?? null;
  const inputLimit = devFacts.inputLimit ?? null;
  const inputRaw = Array.isArray(overrideFact(override, 'input'))
    ? (overrideFact(override, 'input') as unknown[]).filter(
        (item): item is 'text' | 'image' => item === 'text' || item === 'image',
      )
    : undefined;
  const input = inputRaw?.length ? inputRaw : (devFacts.input ?? ['text']);
  const toolsRaw = overrideFact(override, 'tools');
  const tools = typeof toolsRaw === 'boolean' ? toolsRaw : (devFacts.tools ?? null);
  const reasoningRaw = overrideFact(override, 'reasoning');
  const reasoning =
    typeof reasoningRaw === 'boolean'
      ? reasoningRaw
      : typeof devFacts.reasoning === 'boolean'
        ? devFacts.reasoning
        : undefined;
  const family = asString(overrideFact(override, 'family')) ?? devFacts.family ?? vendorName ?? 'unknown';
  const name = asString(overrideFact(override, 'name')) ?? devFacts.name;
  const variantsRaw = asObject(overrideFact(override, 'variants'));
  const variants =
    variantsRaw != null
      ? Object.fromEntries(
          Object.entries(variantsRaw)
            .map(([key, value]) => [key, asObject(value)])
            .filter((entry): entry is [string, JsonObject] => entry[1] != null),
        )
      : (devFacts.variants ?? {});
  const protocolRaw = overrideFact(override, 'protocol');
  const protocol =
    protocolRaw === 'chat-completions' || protocolRaw === 'responses' || protocolRaw === 'messages'
      ? protocolRaw
      : undefined;

  const sources: string[] = [];
  if (dev) sources.push(dev.source);
  if (override) sources.push('options.modelOverrides');
  return {
    context,
    output,
    ...(inputLimit != null ? { inputLimit } : {}),
    input,
    imageInputKnown: inputRaw !== undefined || devFacts.imageInputKnown === true,
    tools,
    reasoning,
    family,
    name,
    protocol,
    variants,
    source: sources.join(' + '),
  };
}

function protocolFor(endpointTypes: unknown[], override?: Protocol): Protocol | null {
  if (override) return override;
  const set = new Set(endpointTypes.map((item) => String(item)));
  if (set.has('openai')) return 'chat-completions';
  if (set.has('openai-response')) return 'responses';
  if (set.has('anthropic')) return 'messages';
  return null;
}

function round(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function ratioPrice(
  pricing: JsonObject,
  groupRatio: number,
  quotaPerUnit: number,
  source: string,
  version: string | null,
  applyGroupRatio: boolean,
): Price | null {
  const quotaType = asNumber(pricing.quota_type);
  if (quotaType === 1) {
    const modelPrice = asNumber(pricing.model_price);
    if (modelPrice == null) return null;
    return {
      kind: 'request',
      currency: 'USD',
      perRequest: round(modelPrice * (applyGroupRatio ? groupRatio : 1)),
      source,
      ...(version ? { version } : {}),
    };
  }
  if (quotaType !== 0) return { kind: 'unknown', currency: 'USD', source, ...(version ? { version } : {}) };

  const modelRatio = asNumber(pricing.model_ratio);
  if (modelRatio == null) return null;
  const completionRatio = asNumber(pricing.completion_ratio) ?? 1;
  const cacheRatio = asNumber(pricing.cache_ratio) ?? 1;
  const createCacheRatio = asNumber(pricing.create_cache_ratio) ?? 1.25;
  const baseInput = (modelRatio * 1_000_000) / quotaPerUnit;
  const input = baseInput * (applyGroupRatio ? groupRatio : 1);
  return {
    kind: 'token',
    currency: 'USD',
    input: round(input),
    output: round(input * completionRatio),
    cacheRead: round(input * cacheRatio),
    cacheWrite: round(input * createCacheRatio),
    source,
    ...(version ? { version } : {}),
  };
}

function complexPrice(expression: string, groupRatio: number, source: string, version: string | null): Price {
  return {
    kind: 'complex',
    currency: 'USD',
    expression: groupRatio === 1 ? expression : `(${expression}) * ${groupRatio}`,
    source,
    ...(version ? { version } : {}),
  };
}

function tokenCost(price: Price, usage: Usage): Money | null {
  if (price.kind === 'request') {
    return price.perRequest == null ? null : { amount: price.perRequest, currency: price.currency };
  }
  if (price.kind !== 'token') return null;
  if (price.input == null || price.output == null) return null;
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
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

interface CredentialSelection {
  secretName: string;
  value: string;
}

function credentialFor(context: ProviderContext, group: string): CredentialSelection | null {
  const secretName = `token:${group}`;
  const keyed = context.secrets[secretName];
  if (keyed) return { secretName, value: keyed };
  const apiKeyGroup = asString(context.account.options.apiKeyGroup);
  if (apiKeyGroup === group && context.secrets.apiKey) {
    return { secretName: 'apiKey', value: context.secrets.apiKey };
  }
  return null;
}

function managedTokenPrefix(context: ProviderContext): string | null {
  return (
    asString(context.account.options.managedTokenPrefix) ??
    asString(context.account.tokenTemplate?.namePrefix)
  );
}

function chooseTokenForGroup(
  tokens: TokenRecord[],
  group: string,
  prefix: string | null,
  allowUserTokens: boolean,
): TokenRecord | null {
  const enabled = tokens.filter(
    (token) => token.group === group && (token.status === undefined || token.status === 1),
  );
  if (!enabled.length) return null;
  if (prefix) {
    const expected = `${prefix}-${sanitizeNamePart(group)}`.slice(0, 50);
    const exact = enabled.find((token) => token.name === expected);
    if (exact) return exact;
    const managed = enabled.find((token) => token.name.startsWith(`${prefix}-`));
    if (managed) return managed;
  }
  return allowUserTokens ? enabled[0] ?? null : null;
}

async function discover(context: ProviderContext): Promise<Discovery> {
  const warnings: string[] = [];
  const base = rootUrl(context.account.baseUrl);
  const accessToken = context.secrets.accessToken;
  const userId = context.secrets.userId ?? (accessToken ? decodeJwtUserId(accessToken) : null);
  const secretsPatch: Record<string, string> = {};
  if (userId && userId !== context.secrets.userId) secretsPatch.userId = userId;
  const secrets: Record<string, string> = { ...context.secrets, ...(userId ? { userId } : {}) };
  if (!accessToken) {
    return {
      models: [],
      complete: false,
      warnings: [
        '缺少 secrets.accessToken：公开 /api/pricing 不能证明账号分组权限，未生成模型目录。',
        '请用账号访问令牌和 userId 配置 New API 账号；推理密钥可另放 secrets.apiKey。',
      ],
    };
  }

  const statusBody = await fetchJson(context, `${base}/api/status`);
  const status = asObject(unwrap(statusBody)) ?? {};
  const quotaPerUnit =
    asNumber(status.quota_per_unit) ??
    asNumber(context.account.options.quotaPerUnit) ??
    DEFAULT_QUOTA_PER_UNIT;
  if (!(quotaPerUnit > 0)) throw new ProviderError('无法从 /api/status 或 options.quotaPerUnit 确定 quota_per_unit', 'quota_unit_missing');

  const pricingBody = await fetchJson(context, `${base}/api/pricing`, { headers: managementHeaders(secrets) });
  const pricing = asObject(pricingBody) ?? {};
  const pricingItems = asArray(pricing.data).map((item) => asObject(item)).filter((item): item is JsonObject => !!item);
  if (!pricingItems.length) throw new ProviderError('/api/pricing 未返回模型数据', 'pricing_empty');
  const groupRatioMap = asObject(pricing.group_ratio) ?? {};
  const vendors = new Map<number, string>();
  for (const vendor of asArray(pricing.vendors)) {
    const object = asObject(vendor);
    const id = asNumber(object?.id);
    const name = asString(object?.name);
    if (id != null && name) vendors.set(id, name);
  }

  const selfBody = await fetchJson(context, `${base}/api/user/self`, { headers: managementHeaders(secrets) });
  const self = asObject(unwrap(selfBody));
  if (!self) throw new ProviderError('/api/user/self 未返回账号数据', 'account_empty');

  // 归属范围只采用 /api/user/self 返回的实际用户 ID，不单独信任可改的 userId/header/JWT。
  const selfId = asNumber(self.id);
  const recorder = resourceRecorder(context);
  const scope =
    recorder && selfId != null && Number.isInteger(selfId) && selfId > 0
      ? identityScope(base, String(selfId))
      : null;
  if (recorder && !scope) {
    warnings.push('无法从 /api/user/self 核验实际用户 ID，未记录上游令牌归属');
  }
  const pendingIntentNames = new Set(
    scope
      ? (context.managedResources ?? [])
          .filter(
            (resource) =>
              resource.kind === 'token' &&
              resource.scope === scope &&
              resource.provenance === 'intent',
          )
          .map((resource) => resource.name)
      : [],
  );
  const confirmedCreated = new Map<string, TokenRecord>();
  const recordedResourceIds = new Set<string>();

  let groups: string[] = [];
  try {
    const groupBody = await fetchJson(context, `${base}/api/user/self/groups`, { headers: managementHeaders(secrets) });
    groups = parseGroups(groupBody);
  } catch {
    warnings.push('/api/user/self/groups 读取失败，尝试 /api/user_group_map');
  }
  if (!groups.length) {
    const groupBody = await fetchJson(context, `${base}/api/user_group_map`, { headers: managementHeaders(secrets) });
    groups = parseGroups(groupBody);
  }
  if (!groups.length) throw new ProviderError('无法获取账号可用分组，拒绝用公开价格目录代替账号权限', 'groups_unavailable');

  const tokenList = await listTokens(context, secrets);
  warnings.push(...tokenList.warnings);
  let tokens = tokenList.items;
  let tokensComplete = tokenList.complete;

  const usableGroups = Array.from(new Set(groups));
  const allowUserTokens = context.account.options.allowUserTokens === true;
  const managedPrefix = managedTokenPrefix(context);
  const enabledTokenGroups = new Set(
    tokens.filter((token) => token.status === undefined || token.status === 1).map((token) => token.group),
  );
  const secretTokenGroups = Object.keys(secrets)
    .filter((name) => name.startsWith('token:'))
    .map((name) => name.slice('token:'.length));
  const unauthorized = Array.from(new Set([...enabledTokenGroups, ...secretTokenGroups])).filter(
    (group) => !usableGroups.includes(group),
  );
  if (unauthorized.length) {
    warnings.push(`以下 token/secret 所在分组不在账号可用分组内，已忽略且不会授予权限: ${unauthorized.join(', ')}`);
  }

  const tokenByGroup = new Map<string, TokenRecord>();
  for (const group of usableGroups) {
    if (secrets[`token:${group}`]) continue;
    const token = chooseTokenForGroup(tokens, group, managedPrefix, allowUserTokens);
    if (token) tokenByGroup.set(group, token);
  }

  if (context.account.autoCreateTokens && tokensComplete && (!recorder || scope)) {
    const template = templateFor(context);
    const byName = new Map(tokens.map((token) => [token.name, token]));
    const apiKeyGroup = asString(context.account.options.apiKeyGroup);
    const existingSecretGroups = new Set(
      Object.keys(secrets)
        .filter((name) => name.startsWith('token:'))
        .map((name) => name.slice('token:'.length)),
    );
    if (apiKeyGroup && secrets.apiKey) existingSecretGroups.add(apiKeyGroup);
    const created: Array<{ name: string; group: string }> = [];
    for (const group of usableGroups) {
      // 首期仅为具有受支持推理端点的分组创建令牌，不为纯生图／视频分组创建。
      if (!pricingItems.some(item => asArray(item.enable_groups).includes(group) && protocolFor(asArray(item.supported_endpoint_types)))) continue;
      if (tokenByGroup.has(group) || existingSecretGroups.has(group)) continue;
      const name = tokenName(template, group);
      const sameName = byName.get(name);
      if (sameName && sameName.group !== group) {
        warnings.push(`令牌名 ${name} 已被分组 ${sameName.group} 使用，为避免修改用户令牌，跳过分组 ${group}`);
        continue;
      }
      if (sameName) {
        if (sameName.status !== undefined && sameName.status !== 1) {
          warnings.push(`令牌 ${name} 已存在但被禁用，不复用也不创建同名令牌；请人工启用或改名`);
          continue;
        }
        tokenByGroup.set(group, sameName);
        continue;
      }
      if (recorder && scope && pendingIntentNames.has(name)) {
        warnings.push(`令牌 ${name} 存在待核验的创建意图，已跳过自动创建以避免重复；请人工核验上游清单`);
        continue;
      }
      if (recorder && scope) {
        // 先持久记录意图，再创建；响应丢失或清单不完整时只保留意图，不重复创建。
        await recorder({
          kind: 'token',
          scope,
          externalId: `intent:${name}`,
          name,
          group,
          provenance: 'intent',
          credentialKey: `token:${group}`,
        });
      }
      await createToken(context, secrets, quotaPerUnit, template, group, name);
      created.push({ name, group });
    }
    if (created.length) {
      const refreshed = await listTokens(context, secrets);
      warnings.push(...refreshed.warnings);
      tokensComplete = refreshed.complete;
      if (!refreshed.complete) warnings.push('创建令牌后重新读取分页不完整，未确认新建令牌');
      tokens = refreshed.items;
      tokenByGroup.clear();
      for (const group of usableGroups) {
        if (secrets[`token:${group}`]) continue;
        const token = chooseTokenForGroup(tokens, group, managedPrefix, allowUserTokens);
        if (token) tokenByGroup.set(group, token);
      }
      for (const { name, group } of created) {
        const matches = tokens.filter((token) => token.name === name);
        if (!refreshed.complete) {
          warnings.push(`已创建令牌 ${name}，但重新读取分页不完整，保留待核验意图`);
        } else if (matches.length === 1 && matches[0]?.group === group) {
          confirmedCreated.set(name, matches[0]);
        } else if (matches.length > 1) {
          warnings.push(`已创建令牌 ${name}，但上游存在 ${matches.length} 个同名令牌，保留待核验意图`);
        } else if (matches.length === 1) {
          warnings.push(`已创建令牌 ${name}，但上游同名令牌分组不一致，保留待核验意图`);
        } else {
          warnings.push(`已创建令牌 ${name}，但重新读取列表未找到，保留待核验意图`);
        }
      }
    }
  } else if (context.account.autoCreateTokens) {
    if (recorder && !scope) {
      warnings.push('无法从 /api/user/self 核验实际用户 ID，已跳过自动创建，避免产生无归属证据的令牌');
    } else {
      warnings.push('令牌分页不完整，已跳过自动创建，避免重复创建令牌');
    }
  }

  for (const [group, token] of tokenByGroup) {
    const secretName = `token:${group}`;
    if (context.secrets[secretName]) continue;
    const key = await revealTokenKey(context, secrets, token);
    if (recorder && scope && isMorisTokenName(token.name)) {
      const createdToken = confirmedCreated.get(token.name);
      if (createdToken && createdToken.id === token.id) {
        await recorder({
          kind: 'token',
          scope,
          externalId: String(token.id),
          name: token.name,
          group,
          provenance: 'created',
          credentialKey: secretName,
          ...(key ? { fingerprint: credentialFingerprint(key) } : {}),
        });
        confirmedCreated.delete(token.name);
        recordedResourceIds.add(String(token.id));
      } else if (key) {
        // 复用只建立引用，不声明创建归属。
        await recorder({
          kind: 'token',
          scope,
          externalId: String(token.id),
          name: token.name,
          group,
          provenance: 'reused',
          credentialKey: secretName,
          fingerprint: credentialFingerprint(key),
        });
        recordedResourceIds.add(String(token.id));
      }
    }
    if (!key) {
      warnings.push(`分组 ${group} 的令牌 ${token.name} 无法读取完整 key，相关模型不启用`);
      continue;
    }
    if (context.secrets[secretName] !== key) secretsPatch[secretName] = key;
  }

  if (recorder && scope) {
    // 已唯一确认 ID 但未能在凭据循环中处理时，仍记录创建归属（指纹可后续补全）。
    for (const [name, token] of confirmedCreated) {
      if (recordedResourceIds.has(String(token.id))) continue;
      await recorder({
        kind: 'token',
        scope,
        externalId: String(token.id),
        name,
        group: token.group,
        provenance: 'created',
      });
      recordedResourceIds.add(String(token.id));
      confirmedCreated.delete(name);
    }

    if (tokensComplete) {
      const credentials: Array<{ secretName: string; group: string; value: string }> = [];
      for (const [secretName, value] of Object.entries(context.secrets)) {
        if (!secretName.startsWith('token:') || !value) continue;
        credentials.push({ secretName, group: secretName.slice('token:'.length), value });
      }
      const apiKeyGroup = asString(context.account.options.apiKeyGroup);
      if (apiKeyGroup && context.secrets.apiKey) {
        credentials.push({ secretName: 'apiKey', group: apiKeyGroup, value: context.secrets.apiKey });
      }
      const byGroup = new Map<string, Array<{ secretName: string; value: string }>>();
      for (const credential of credentials) {
        const list = byGroup.get(credential.group) ?? [];
        list.push({ secretName: credential.secretName, value: credential.value });
        byGroup.set(credential.group, list);
      }
      for (const token of tokens) {
        if (!isMorisTokenName(token.name)) continue;
        const id = String(token.id);
        if (recordedResourceIds.has(id)) continue;
        const saved = byGroup.get(token.group);
        if (!saved?.length) continue;
        const key = await revealTokenKey(context, secrets, token);
        if (!key) continue;
        const fingerprint = credentialFingerprint(key);
        const match = saved.find((credential) => credentialFingerprint(credential.value) === fingerprint);
        if (!match) continue;
        await recorder({
          kind: 'token',
          scope,
          externalId: id,
          name: token.name,
          group: token.group,
          provenance: 'reused',
          credentialKey: match.secretName,
          fingerprint,
        });
        recordedResourceIds.add(id);
      }
    } else {
      warnings.push('令牌分页不完整，未记录既有令牌的复用引用');
    }
  }
  if (Object.keys(secretsPatch).length) await context.updateSecrets(secretsPatch);
  const effectiveSecrets = { ...secrets, ...secretsPatch };

  const modelsDevCatalog = await loadModelsDev(context);
  const overrideMap = asObject(context.account.options.modelOverrides);
  const modelsDevProvider = asString(context.account.options.modelsDevProvider);
  const version = asString(pricing.pricing_version);
  const pricingSource = `${base}/api/pricing`;

  const usable = new Set(usableGroups);
  const models: ProviderModel[] = [];
  for (const pricingItem of pricingItems) {
    const modelName = asString(pricingItem.model_name);
    if (!modelName) continue;
    const enabledGroups = asArray(pricingItem.enable_groups).map(String);
    const targetGroups = enabledGroups.filter((group) => usable.has(group));
    if (!targetGroups.length) continue;
    const endpointTypes = asArray(pricingItem.supported_endpoint_types);
    const vendorName = vendors.get(asNumber(pricingItem.vendor_id) ?? -1) ?? null;

    for (const group of targetGroups) {
      const officialOnly = context.account.options.modelsDevOfficial === true;
      const officialProvider = vendorName ? OFFICIAL_MODELS_DEV[vendorName] : undefined;
      const facts = modelFacts(modelName, group, vendorName, overrideMap,
        officialOnly && !officialProvider ? null : modelsDevCatalog,
        officialOnly ? officialProvider ?? null : modelsDevProvider);
      const protocol = protocolFor(endpointTypes, facts.protocol);
      if (!protocol) {
        warnings.push(`${modelName} (${group}) 的端点 ${endpointTypes.join(', ') || '未知'} 不属于首期协议，已跳过`);
        continue;
      }
      const groupRatio = asNumber(groupRatioMap[group]);
      const price = groupRatio == null ? null : ratioPrice(pricingItem, groupRatio, quotaPerUnit, pricingSource, version, true);
      const referencePrice =
        groupRatio == null ? null : ratioPrice(pricingItem, groupRatio, quotaPerUnit, pricingSource, version, false);
      let finalPrice: Price;
      let finalReference: Price | undefined;
      if (asString(pricingItem.billing_mode) === 'tiered_expr' && asString(pricingItem.billing_expr)) {
        const expression = asString(pricingItem.billing_expr)!;
        if (groupRatio == null) {
          finalPrice = {
            kind: 'unknown',
            currency: 'USD',
            expression,
            source: pricingSource,
            ...(version ? { version } : {}),
          };
        } else {
          finalPrice = complexPrice(expression, groupRatio, pricingSource, version);
          finalReference = complexPrice(expression, 1, pricingSource, version);
        }
      } else if (price && referencePrice) {
        finalPrice = price;
        finalReference = referencePrice;
      } else {
        finalPrice = {
          kind: 'unknown',
          currency: 'USD',
          source: pricingSource,
          ...(version ? { version } : {}),
        };
      }

      const credential = credentialFor({ ...context, secrets: effectiveSecrets } as ProviderContext, group);
      const reasons: string[] = [];
      if (facts.context == null) reasons.push('上下文长度未知');
      if (facts.output == null) reasons.push('最大输出未知');
      if (facts.tools == null) reasons.push('工具能力未知');
      if (!credential) reasons.push(`分组 ${group} 没有可用推理令牌`);
      const enabled = reasons.length === 0;
      const path = `${group}/${modelName}`;
      if (finalPrice.kind === 'unknown') {
        warnings.push(`${path}: 价格未知，保留调用并让 estimate 返回 null；${groupRatio == null ? `缺少 group_ratio.${group}` : '计价规则未知'}`);
      }

      models.push({
        path,
        upstreamModel: modelName,
        name: facts.name ? `${facts.name} (${group})` : `${modelName} (${group})`,
        family: facts.family,
        protocol,
        capabilities: {
          tools: facts.tools === true,
          input: facts.input,
          output: ['text'],
          ...(facts.reasoning != null ? { reasoning: facts.reasoning } : {}),
        },
        limit: {
          context: facts.context,
          output: facts.output,
          ...(facts.inputLimit != null ? { input: facts.inputLimit } : {}),
        },
        variants: facts.variants,
        price: finalPrice,
        ...(finalReference ? { referencePrice: finalReference } : {}),
        ...(credential ? { credentialKey: credential.secretName } : {}),
        group,
        enabled,
        available: !!credential,
        unknownParameters: [
          ...(facts.tools == null ? ['tools' as const] : []),
          ...(facts.reasoning == null ? ['reasoning' as const] : []),
          ...(!facts.imageInputKnown ? ['imageInput' as const] : []),
        ],
        ...(!enabled ? { disabledReason: reasons.join('；') } : {}),
        sources: {
          pricing: pricingSource,
          groupRatio: `${pricingSource}#group_ratio.${group}`,
          models: facts.source || '账号权限与公开 pricing 交集',
        },
      });
    }
  }

  return {
    models,
    complete: tokensComplete && pricingItems.length > 0,
    warnings: warnings.length ? warnings : undefined,
  };
}


function parseGroups(body: unknown): string[] {
  const source = unwrap(body);
  if (Array.isArray(source)) {
    return Array.from(new Set(source.map((item) => asString(item)).filter((item): item is string => !!item)));
  }
  const object = asObject(source);
  if (object) {
    return Object.keys(object)
      .filter((key) => !['success', 'message', 'code', 'data', 'error'].includes(key.toLowerCase()))
      .map((key) => key.trim())
      .filter(Boolean);
  }
  return [];
}

async function prepare(
  context: ProviderContext,
  model: ProviderModel,
  body: Record<string, unknown>,
  protocol: Protocol,
): Promise<PreparedRequest> {
  if (protocol !== model.protocol) {
    throw new ProviderError(
      `模型 ${model.path} 只支持 ${model.protocol}，请求协议是 ${protocol}`,
      'protocol_mismatch',
      400,
    );
  }
  const secret = model.credentialKey ? context.secrets[model.credentialKey] : context.secrets.apiKey;
  if (!secret) {
    throw new ProviderError(`模型 ${model.path} 没有推理凭据`, 'credential_missing', 401);
  }
  const nextBody: Record<string, unknown> = { ...body, model: model.upstreamModel };
  for (const key of ['authorization', 'Authorization', 'api_key', 'apiKey', 'base_url', 'baseUrl', 'url']) {
    delete nextBody[key];
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (protocol === 'messages') {
    headers['x-api-key'] = secret;
    headers['anthropic-version'] = '2023-06-01';
  }
  return {
    url: apiUrl(context.account.baseUrl || DEFAULT_BASE_URL, protocolPath(protocol)),
    headers,
    body: nextBody,
  };
}

async function monitor(context: ProviderContext): Promise<ProviderMonitor> {
  const sampledAt = context.now().toISOString();
  try {
    const base = rootUrl(context.account.baseUrl);
    const statusBody = await fetchJson(context, `${base}/api/status`);
    const status = asObject(unwrap(statusBody)) ?? {};
    const quotaPerUnit = asNumber(status.quota_per_unit) ?? DEFAULT_QUOTA_PER_UNIT;
    const selfBody = await fetchJson(context, `${base}/api/user/self`, {
      headers: managementHeaders(context.secrets),
    });
    const self = asObject(unwrap(selfBody));
    if (!self) throw new ProviderError('/api/user/self 未返回账号数据', 'account_empty');
    const quota = asNumber(self.quota);
    const usedQuota = asNumber(self.used_quota);
    if (quota == null) {
      return {
        state: 'unknown',
        balances: [],
        windows: [],
        sampledAt,
        message: '/api/user/self 未返回可解释的 quota 字段',
      };
    }
    const balances: Balance[] = [];
    balances.push({
      currency: 'USD',
      amount: round(quota / quotaPerUnit),
      unit: 'account_quota',
    });
    return {
      state: 'ok',
      balances,
      windows: [],
      sampledAt,
      message:
        usedQuota != null
          ? `账号余额含网关外使用；历史已用 ${round(usedQuota / quotaPerUnit)} USD，quota_per_unit=${quotaPerUnit}`
          : `账号余额含网关外使用；quota_per_unit=${quotaPerUnit}`,
    };
  } catch (error) {
    return {
      state: context.signal.aborted ? 'unknown' : 'error',
      balances: [],
      windows: [],
      sampledAt,
      message: context.signal.aborted ? '余额查询已取消' : '余额查询失败，保留上次可用数据；详情见服务端日志',
    };
  }
}

/** 只做有限解析：时间/header/任务用量等无法从 Usage 得到的事实返回 null。 */
function estimate(price: Price, usage: Usage, body: Record<string, unknown>): Money | null {
  if (price.kind === 'complex') {
    if (!price.expression) return null;
    const amount = evaluateBillingExpression(price.expression, usage, body);
    return amount == null ? null : { amount, currency: price.currency };
  }
  return tokenCost(price, usage);
}

interface CleanupCandidate {
  resource: ManagedResourceInput;
  verified: boolean;
  reason?: string;
  /** 仅在身份与完整清单已核验且可信记录带指纹、上游已无该 ID 时为 true。 */
  absent?: boolean;
}

function failedCleanup(message: string = CLEANUP_MESSAGE.changed): { state: 'failed'; message: string } {
  return { state: 'failed', message };
}

/**
 * 只读预览：读取 /api/user/self 与实际用户身份和完整令牌清单。
 * 不创建、不调用 discover、不删除；只对 moris 候选读取 key 并计算不可逆指纹。
 */
async function cleanupPreview(context: ProviderContext): Promise<CleanupCandidate[]> {
  const identity = await readIdentity(context);
  const list = await readCompleteTokens(context, identity.secrets);
  const candidates = new Map<string, CleanupCandidate>();
  const claimed = new Set<string>();

  const trusted = (context.managedResources ?? []).filter(
    (resource) =>
      resource.kind === 'token' &&
      resource.scope === identity.scope &&
      Array.isArray(resource.accountIds) &&
      resource.accountIds.includes(context.account.id) &&
      (resource.provenance === 'created' || resource.provenance === 'adopted'),
  );
  for (const record of trusted) {
    claimed.add(record.externalId);
    const token = list.items.find((item) => String(item.id) === record.externalId);
    if (!token) {
      candidates.set(record.externalId, {
        resource: resourceInput(record),
        verified: false,
        reason: '上游完整令牌清单已确认该令牌不存在；执行时会再次核验。',
        ...(record.fingerprint ? { absent: true } : {}),
      });
      continue;
    }

    let verified = true;
    let reason: string | undefined;
    if (token.name !== record.name) {
      verified = false;
      reason = '上游令牌名称与已记录归属不一致。';
    } else if (!record.group || token.group !== record.group) {
      verified = false;
      reason = '上游令牌分组与已记录归属不一致。';
    } else if (!isMorisTokenName(token.name)) {
      verified = false;
      reason = '仅核验名称以 moris 开头的受管令牌。';
    } else if (!record.fingerprint) {
      verified = false;
      reason = '缺少已记录凭据指纹，无法核验令牌。';
    } else {
      const key = await revealTokenKey(context, identity.secrets, token);
      if (!key || credentialFingerprint(key) !== record.fingerprint) {
        verified = false;
        reason = '无法核验令牌凭据与已记录指纹一致。';
      }
    }
    candidates.set(record.externalId, {
      resource: resourceInput(record),
      verified,
      ...(reason ? { reason } : {}),
    });
  }

  const savedByGroup = new Map<string, Array<{ secretName: string; value: string }>>();
  for (const [secretName, value] of Object.entries(context.secrets)) {
    if (!secretName.startsWith('token:') || !value) continue;
    const group = secretName.slice('token:'.length);
    const saved = savedByGroup.get(group) ?? [];
    saved.push({ secretName, value });
    savedByGroup.set(group, saved);
  }
  const apiKeyGroup = asString(context.account.options.apiKeyGroup);
  if (apiKeyGroup && context.secrets.apiKey) {
    const saved = savedByGroup.get(apiKeyGroup) ?? [];
    saved.push({ secretName: 'apiKey', value: context.secrets.apiKey });
    savedByGroup.set(apiKeyGroup, saved);
  }

  for (const token of list.items) {
    if (!isMorisTokenName(token.name)) continue;
    const id = String(token.id);
    if (claimed.has(id)) continue;
    const saved = savedByGroup.get(token.group);
    if (!saved?.length) continue;
    const key = await revealTokenKey(context, identity.secrets, token);
    if (!key) continue;
    const fingerprint = credentialFingerprint(key);
    const match = saved.find((credential) => credentialFingerprint(credential.value) === fingerprint);
    if (!match) continue;
    candidates.set(id, {
      resource: {
        kind: 'token',
        scope: identity.scope,
        externalId: id,
        name: token.name,
        group: token.group,
        fingerprint,
        provenance: 'reused',
        credentialKey: match.secretName,
      },
      verified: true,
    });
    claimed.add(id);
  }

  return Array.from(candidates.values());
}

async function deleteTokenOnce(
  context: ProviderContext,
  identity: UpstreamIdentity,
  token: TokenRecord,
): Promise<{ state: 'deleted' | 'absent' | 'failed' | 'unknown'; message: string }> {
  let response: Response;
  try {
    response = await context.fetch(`${identity.base}/api/token/${token.id}`, {
      method: 'DELETE',
      headers: managementHeaders(identity.secrets),
      signal: context.signal,
    });
  } catch {
    return { state: 'unknown', message: context.signal.aborted ? CLEANUP_MESSAGE.cancelled : CLEANUP_MESSAGE.unknown };
  }

  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (response.status === 200) {
    const object = asObject(body);
    if (object?.success === true) return { state: 'deleted', message: CLEANUP_MESSAGE.deleted };
    if (object?.success === false) return { state: 'failed', message: CLEANUP_MESSAGE.rejected };
    return { state: 'unknown', message: CLEANUP_MESSAGE.unknown };
  }

  if (response.status === 404) {
    // 404 不能直接视为已不存在；用完整清单确认后才允许记为 absent。
    try {
      const after = await readCompleteTokens(context, identity.secrets);
      if (after.items.some((item) => item.id === token.id)) {
        return { state: 'failed', message: CLEANUP_MESSAGE.rejected };
      }
      return { state: 'absent', message: CLEANUP_MESSAGE.absent };
    } catch {
      return { state: 'unknown', message: CLEANUP_MESSAGE.unknown };
    }
  }

  if (response.status >= 500) return { state: 'unknown', message: CLEANUP_MESSAGE.unknown };
  return { state: 'failed', message: CLEANUP_MESSAGE.rejected };
}

/**
 * 单令牌清理。每次执行都重新核验身份、完整清单、ID、名称、分组与凭据指纹；
 * 不按前缀批量删除，不删除管理 accessToken、账号或订阅。
 */
async function cleanupExecute(
  context: ProviderContext,
  resource: ManagedResourceInput,
): Promise<{ state: 'deleted' | 'absent' | 'failed' | 'unknown'; message?: string }> {
  if (
    resource.kind !== 'token' ||
    resource.provenance === 'intent' ||
    !/^\d+$/.test(resource.externalId) ||
    !resource.name ||
    !resource.group ||
    !resource.fingerprint ||
    !resource.scope
  ) {
    return failedCleanup();
  }

  let identity: UpstreamIdentity;
  try {
    identity = await readIdentity(context);
  } catch {
    return context.signal.aborted
      ? { state: 'unknown', message: CLEANUP_MESSAGE.cancelled }
      : failedCleanup(CLEANUP_MESSAGE.identity);
  }
  if (identity.scope !== resource.scope) return failedCleanup();

  let list: DiscoveredTokens;
  try {
    list = await readCompleteTokens(context, identity.secrets);
  } catch {
    return context.signal.aborted
      ? { state: 'unknown', message: CLEANUP_MESSAGE.cancelled }
      : failedCleanup(CLEANUP_MESSAGE.listBeforeDelete);
  }

  const token = list.items.find((item) => String(item.id) === resource.externalId);
  if (!token) return { state: 'absent', message: CLEANUP_MESSAGE.absent };
  if (token.name !== resource.name || token.group !== resource.group) return failedCleanup();
  if (!isMorisTokenName(token.name)) return failedCleanup();

  const key = await revealTokenKey(context, identity.secrets, token);
  if (!key || credentialFingerprint(key) !== resource.fingerprint) {
    return failedCleanup(CLEANUP_MESSAGE.key);
  }

  return deleteTokenOnce(context, identity, token);
}

export const plugin: ProviderPlugin = {
  id: 'realseek',
  name: 'New API 兼容站点',
  setup: {
    baseUrl: {
      default: null,
      hint: '没有通用默认地址，必须填写你的 New API 站点根地址（例如 https://newapi.example.com，可带或不带 /v1）。',
    },
    billingType: { default: 'metered', hint: '按站点 /api/pricing 的倍率计费；订阅制站点不要用此插件。' },
    secrets: [
      { key: 'accessToken', label: 'accessToken', required: true, description: 'New API 管理接口登录令牌；目录、分组与令牌列表都依赖它。缺少时目录不完整。' },
      { key: 'userId', label: 'userId', description: '可选。New-API-User 请求头；缺省时从 accessToken 的 JWT 读取。' },
      { key: 'apiKey', label: 'apiKey', description: '可选。仅当 options.apiKeyGroup 与当前分组一致时作为推理密钥。' },
      { key: 'token:<group>', label: 'token:<分组>', description: '自动创建或手工填写时按分组保存；插件优先复用名称匹配的 moris 令牌，不修改其他令牌。', placeholder: 'token:default' },
    ],
    options: {
      example: { modelsDev: true, modelsDevOfficial: true },
      hint: '全部可选。用 apiKeyGroup 指定 apiKey 所属分组；allowUserTokens 默认 false，不会改用非本网关创建的令牌。',
      fields: [
        { key: 'apiKeyGroup', description: 'secrets.apiKey 所属分组；只有该分组会使用 apiKey。' },
        { key: 'quotaPerUnit', description: '站点 /api/status 缺少 quota_per_unit 时的兜底单位。' },
        { key: 'allowUserTokens', description: '默认 false；设 true 才允许复用名称不匹配的既有令牌。' },
        { key: 'managedTokenPrefix', description: '识别本网关令牌的名称前缀；默认取令牌模板的 namePrefix。' },
        { key: 'modelOverrides', description: '按 group/model 覆盖上下文、输出、能力、协议与变体；只影响网关展示与校验。' },
        { key: 'modelsDev / modelsDevUrl / modelsDevProvider / modelsDevOfficial', description: '可选的原厂参考价与规格来源；不覆盖站点实际价格。' },
      ],
    },
    tokenTemplate: {
      supported: true,
      hint: '开启后按「名称前缀-分组」创建专用令牌，并优先复用匹配前缀的既有令牌；名称前缀建议保留 moris。不会使用、修改或删除其他令牌。',
    },
    authorization: { supported: false, hint: 'New API 使用管理令牌，不支持设备授权。' },
  },
  cleanup: {
    preview: cleanupPreview,
    execute: cleanupExecute,
  },
  discover,
  prepare,
  monitor,
  estimate,
};

export default plugin;
