import type {
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
  TokenTemplate,
  Usage,
} from '@moris/provider-sdk';
import { ProviderError, apiUrl, protocolPath } from './runtime.js';
import { evaluateBillingExpression } from './price-expression.js';

export { evaluateBillingExpression, parseBillingExpression, UnsupportedExpression } from './price-expression.js';

const DEFAULT_BASE_URL = 'https://newapi.example.com';
const DEFAULT_QUOTA_PER_UNIT = 500_000;
const SOURCE_LABEL = 'New API /api/pricing';

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
      headers: managementHeaders(secrets),
    });
    const data = asObject(unwrap(body));
    return asString(data?.key) ?? asString(asObject(body)?.key);
  } catch {
    return null;
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

  if (context.account.autoCreateTokens && tokensComplete) {
    const template = templateFor(context);
    const byName = new Map(tokens.map((token) => [token.name, token]));
    const apiKeyGroup = asString(context.account.options.apiKeyGroup);
    const existingSecretGroups = new Set(
      Object.keys(secrets)
        .filter((name) => name.startsWith('token:'))
        .map((name) => name.slice('token:'.length)),
    );
    if (apiKeyGroup && secrets.apiKey) existingSecretGroups.add(apiKeyGroup);
    const created: string[] = [];
    for (const group of usableGroups) {
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
      await createToken(context, secrets, quotaPerUnit, template, group, name);
      created.push(name);
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
      for (const name of created) {
        const found = tokens.find((token) => token.name === name);
        if (!found) warnings.push(`已创建令牌 ${name}，但重新读取列表未找到`);
      }
    }
  } else if (context.account.autoCreateTokens) {
    warnings.push('令牌分页不完整，已跳过自动创建，避免重复创建令牌');
  }

  for (const [group, token] of tokenByGroup) {
    const secretName = `token:${group}`;
    if (context.secrets[secretName]) continue;
    const key = await revealTokenKey(context, secrets, token);
    if (!key) {
      warnings.push(`分组 ${group} 的令牌 ${token.name} 无法读取完整 key，相关模型不启用`);
      continue;
    }
    if (context.secrets[secretName] !== key) secretsPatch[secretName] = key;
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
      const facts = modelFacts(modelName, group, vendorName, overrideMap, modelsDevCatalog, modelsDevProvider);
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

export const plugin: ProviderPlugin = {
  id: 'realseek',
  name: 'New API 兼容站点',
  discover,
  prepare,
  monitor,
  estimate,
};

export default plugin;
