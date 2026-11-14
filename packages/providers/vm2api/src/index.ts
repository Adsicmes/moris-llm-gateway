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
  QuotaWindow,
  Usage,
} from '@moris/provider-sdk';
import { ProviderError, protocolPath } from './runtime.js';

const MODELS_SOURCE =
  'https://github.com/dofastted/vm2api/blob/d0bfe3068f29a8e3f85a0dffdf3c8d36c39f8b00/src/lib/protocol/models.mjs';
const QUOTA_SOURCE =
  'https://github.com/dofastted/vm2api/blob/d0bfe3068f29a8e3f85a0dffdf3c8d36c39f8b00/src/lib/protocol/key-self.mjs';

type JsonObject = Record<string, unknown>;

interface ModelOverride {
  context?: number | null;
  output?: number | null;
  input?: Array<'text' | 'image'>;
  tools?: boolean;
  reasoning?: boolean;
  family?: string;
  protocol?: Protocol;
  variants?: Record<string, Record<string, unknown>>;
  price?: Price;
  enabled?: boolean;
}

interface Facts {
  context: number | null;
  output: number | null;
  input: Array<'text' | 'image'>;
  tools: boolean | null;
  reasoning?: boolean;
  family: string;
  protocol: Protocol;
  variants: Record<string, Record<string, unknown>>;
  price: Price;
  source: string;
}

interface ModelsDevProvider {
  models?: Record<string, JsonObject>;
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
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '');
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
    const errorObject = asObject(object?.error) ?? object;
    throw new ProviderError(
      asString(errorObject?.message) ?? `上游 ${url} 返回 HTTP ${response.status}`,
      'upstream_http',
      response.status,
    );
  }
  return body;
}

async function loadModelsDev(context: ProviderContext): Promise<JsonObject | null> {
  if (context.account.options.modelsDev !== true) return null;
  const url = asString(context.account.options.modelsDevUrl) ?? 'https://models.dev/api.json';
  try {
    const response = await context.fetch(url, { signal: context.signal, headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    return asObject(await response.json());
  } catch {
    return null;
  }
}

function devFacts(catalog: JsonObject | null, modelId: string, providerHint: string | null): Partial<Facts> | null {
  if (!catalog) return null;
  const candidates: Array<{ provider: string; model: JsonObject }> = [];
  for (const [provider, value] of Object.entries(catalog)) {
    const model = asObject(asObject(value)?.models)?.[modelId];
    const object = asObject(model);
    if (object) candidates.push({ provider, model: object });
  }
  const chosen = providerHint
    ? candidates.find((candidate) => candidate.provider === providerHint)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  if (!chosen) return null;
  const limit = asObject(chosen.model.limit);
  const modalities = asObject(chosen.model.modalities);
  const input = asArray(modalities?.input).filter(
    (value): value is 'text' | 'image' => value === 'text' || value === 'image',
  );
  return {
    context: asNumber(limit?.context),
    output: asNumber(limit?.output),
    input: input.length ? input : undefined,
    tools: typeof chosen.model.tool_call === 'boolean' ? chosen.model.tool_call : null,
    reasoning: typeof chosen.model.reasoning === 'boolean' ? chosen.model.reasoning : undefined,
    family: asString(chosen.model.family) ?? undefined,
    source: `models.dev:${chosen.provider}/${modelId}`,
  } as Partial<Facts>;
}

function overrideFor(context: ProviderContext, modelId: string): ModelOverride | null {
  const map = asObject(context.account.options.modelOverrides);
  return map ? (asObject(map[modelId]) as ModelOverride | null) : null;
}

function protocolFor(item: JsonObject, family: string, override: ModelOverride | null): Protocol {
  if (override?.protocol) return override.protocol;
  const id = asString(item.id) ?? '';
  const ownedBy = asString(item.owned_by) ?? '';
  if (family === 'codex' || /^(codex-|gpt-|o[1-9])/i.test(id) || ownedBy === 'openai') return 'responses';
  if (family.startsWith('claude') || ownedBy === 'anthropic' || /^claude-/i.test(id)) return 'messages';
  return 'chat-completions';
}

function priceFor(context: ProviderContext, item: JsonObject): Price {
  const override = overrideFor(context, asString(item.id) ?? '');
  if (override?.price) return override.price;
  return {
    kind: 'unknown',
    currency: 'USD',
    source: `${MODELS_SOURCE}（vm2api /v1/models 不返回价格；可用 options.priceOverrides 或面板价格目录补全）`,
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

async function discover(context: ProviderContext): Promise<Discovery> {
  if (!context.secrets.apiKey) throw new ProviderError('缺少 secrets.apiKey', 'credential_missing', 401);
  const base = rootUrl(context.account.baseUrl);
  if (!base) throw new ProviderError('vm2api 账号缺少 baseUrl', 'base_url_missing', 400);
  const body = await fetchJson(context, `${base}/v1/models`, {
    headers: { Authorization: `Bearer ${context.secrets.apiKey}`, Accept: 'application/json' },
  });
  const object = asObject(body);
  if (!object || !Array.isArray(object.data)) {
    throw new ProviderError('vm2api /v1/models 未返回 data 数组', 'invalid_catalog');
  }

  const modelsDev = await loadModelsDev(context);
  const providerHint = asString(context.account.options.modelsDevProvider);
  const models: ProviderModel[] = [];
  const warnings: string[] = [];

  for (const raw of object.data) {
    const item = asObject(raw);
    if (!item) continue;
    const id = asString(item.id);
    if (!id) continue;
    const override = overrideFor(context, id);
    const dev = devFacts(modelsDev, id, providerHint);
    const capabilities = asObject(item.capabilities);
    const devInput = dev?.input as Array<'text' | 'image'> | undefined;
    const overrideInput = override?.input;
    const itemInput = asArray(capabilities?.input).filter(
      (value): value is 'text' | 'image' => value === 'text' || value === 'image',
    );
    const input: Array<'text' | 'image'> = overrideInput?.length
      ? overrideInput
      : devInput?.length
        ? devInput
        : itemInput.length
          ? itemInput
          : ['text'];
    const tools =
      typeof override?.tools === 'boolean'
        ? override.tools
        : typeof capabilities?.tools === 'boolean'
          ? capabilities.tools
          : typeof item.supports_tools === 'boolean'
            ? item.supports_tools
            : (dev?.tools ?? null);
    const contextWindow =
      asNumber(override?.context) ?? asNumber(item.context_window) ?? asNumber(item.limit_context) ?? dev?.context ?? null;
    const outputLimit =
      asNumber(override?.output) ?? asNumber(item.max_output_tokens) ?? dev?.output ?? null;
    const family =
      asString(override?.family) ??
      asString(item.family) ??
      (dev?.family as string | undefined) ??
      asString(item.owned_by) ??
      'vm2api';
    const protocol = protocolFor(item, family, override);
    const price = priceFor(context, item);
    const variants = override?.variants ?? {};
    const reasons: string[] = [];
    if (item.enabled === false) reasons.push('vm2api 模型策略已禁用');
    if (contextWindow == null) reasons.push('上下文长度未知');
    if (outputLimit == null) reasons.push('最大输出未知');
    if (tools == null) reasons.push('工具能力未知');
    const enabled = reasons.length === 0;
    if (price.kind === 'unknown') warnings.push(`${id}: 价格未知，保留调用；等价估算返回 null`);

    models.push({
      path: id,
      upstreamModel: id,
      name: asString(item.display_name) ?? id,
      family,
      protocol,
      capabilities: {
        tools: tools === true,
        input,
        output: ['text'],
        ...(typeof override?.reasoning === 'boolean'
          ? { reasoning: override.reasoning }
          : typeof dev?.reasoning === 'boolean'
            ? { reasoning: dev.reasoning }
            : {}),
      },
      limit: { context: contextWindow, output: outputLimit },
      variants,
      price,
      enabled,
      available: item.enabled !== false,
      unknownParameters: tools == null ? ['tools'] : [],
      ...(!enabled ? { disabledReason: reasons.join('；') } : {}),
      sources: {
        models: `${base}/v1/models（按 API key 的 group_type 与 allowed_models 过滤）`,
        modelsDev: dev?.source ?? '',
        overrides: override ? 'options.modelOverrides' : '',
        code: MODELS_SOURCE,
      },
    });
  }

  return { models, complete: true, warnings: warnings.length ? warnings : undefined };
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
  if (!context.secrets.apiKey) throw new ProviderError('缺少 secrets.apiKey', 'credential_missing', 401);
  const next: Record<string, unknown> = { ...body, model: model.upstreamModel };
  for (const key of ['authorization', 'Authorization', 'api_key', 'apiKey', 'base_url', 'baseUrl', 'url']) {
    delete next[key];
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${context.secrets.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (protocol === 'messages') {
    headers['x-api-key'] = context.secrets.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  const base = rootUrl(context.account.baseUrl);
  return { url: `${base}/v1${protocolPath(protocol)}`, headers, body: next };
}

async function monitor(context: ProviderContext): Promise<ProviderMonitor> {
  const sampledAt = context.now().toISOString();
  try {
    const base = rootUrl(context.account.baseUrl);
    const body = await fetchJson(context, `${base}/v1/me/quota`, {
      headers: { Authorization: `Bearer ${context.secrets.apiKey ?? ''}`, Accept: 'application/json' },
    });
    const object = asObject(body);
    if (!object) return { state: 'unknown', balances: [], windows: [], sampledAt, message: '额度响应不是对象' };

    const balances: Balance[] = [];
    const issues: string[] = [];
    const usd = asObject(object.usd);
    const usdLimit = asNumber(usd?.limit);
    const usdUsed = asNumber(usd?.used);
    const usdRemaining = asNumber(usd?.remaining);
    if (usdLimit != null) {
      const remaining = usdRemaining ?? (usdUsed != null ? Math.max(usdLimit - usdUsed, 0) : null);
      if (remaining != null) {
        balances.push({ currency: 'USD', amount: remaining, unit: 'remaining_usd' });
      } else {
        issues.push('USD remaining/used 缺失，未发布余额');
      }
    }

    const windows: QuotaWindow[] = [];
    const quotaPool = asString(context.account.options.quotaPool) ?? 'default';
    const rawWindows = asObject(object.windows) ?? {};
    for (const key of ['5h', '1d', '7d']) {
      const window = asObject(rawWindows[key]);
      if (!window) continue;
      const limit = asNumber(window.limit);
      const used = asNumber(window.used);
      const resetAt = asString(window.reset_at);
      if (limit == null || limit <= 0) continue;
      if (resetAt == null || !Number.isFinite(Date.parse(resetAt))) {
        issues.push(`${key} 窗口 reset_at 缺失/无效，未发布该窗口`);
        continue;
      }
      if (used == null || used < 0) {
        issues.push(`${key} 窗口 used 缺失/无效，未发布该窗口`);
        continue;
      }
      const resetMs = Date.parse(resetAt);
      const durationMs = key === '5h' ? 5 * 3_600_000 : key === '1d' ? 86_400_000 : 604_800_000;
      const startAt = asString(window.window_start) ?? new Date(resetMs - durationMs).toISOString();
      windows.push({
        id: `vm2api-${key}`,
        name: key,
        pool: quotaPool,
        startsAt: startAt,
        resetsAt: new Date(resetMs).toISOString(),
        usedRatio: Math.min(1, Math.max(0, used / limit)),
        sampledAt: asString(object.checked_at) ?? sampledAt,
      });
    }

    const requests = asObject(object.requests);
    const requestLimit = asNumber(requests?.limit);
    const requestUsed = asNumber(requests?.used);
    const requestPart =
      requestLimit != null && requestLimit > 0
        ? requestUsed != null
          ? `请求额度已用 ${requestUsed}/${requestLimit}`
          : `请求额度上限 ${requestLimit}，已用未知`
        : '请求数未设上限';
    if (requestLimit != null && requestLimit > 0 && requestUsed == null) {
      issues.push('请求用量缺失');
    }
    const parts = [
      'vm2api 托管 Key 自报额度，包含该 Key 在网关外的使用',
      usdLimit == null ? 'USD 额度未设上限' : balances.length ? `USD 剩余 ${balances[0]!.amount}` : 'USD 余额不可用',
      requestPart,
      ...issues,
    ];
    const blocked = asObject(object.blocked_by);
    if (blocked) parts.push('当前 Key 被上游额度/策略拒绝；具体原因见服务端日志');
    return {
      state: issues.length ? 'unknown' : 'ok',
      balances,
      windows,
      sampledAt,
      message: parts.join('；'),
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
  return tokenCost(price, usage);
}

export const plugin: ProviderPlugin = {
  id: 'vm2api',
  name: 'vm2api',
  setup: {
    baseUrl: {
      default: null,
      hint: '没有通用默认地址，必须填写你的 vm2api 实例根地址（例如 https://vm2api.example.com）。',
    },
    billingType: { default: 'metered', hint: 'vm2api 不自带价格目录；按量口径记录的参考价只来自可选覆盖。' },
    secrets: [
      { key: 'apiKey', label: 'vm2api Key', required: true, description: 'vm2api 控制台为用户生成的 Key，用于 /v1/models、额度和推理。', placeholder: 'sk-…' },
    ],
    options: {
      example: { modelsDev: true },
      hint: '全部可选。没有价格目录时模型仍可调用，但费用显示未知，不会伪造为 0。',
      fields: [
        { key: 'modelsDev / modelsDevUrl / modelsDevProvider', description: '可选的原厂规格参考来源；只补齐上下文与能力。' },
        { key: 'modelOverrides', description: '按模型 id 覆盖上下文、输出、能力、协议、变体与价格。' },
        { key: 'quotaPool', description: '额度窗口所属池，默认 default。' },
      ],
    },
    tokenTemplate: { supported: false, hint: 'vm2api 插件不创建上游令牌，令牌模板不会生效。' },
    authorization: { supported: false, hint: 'vm2api 使用 API Key，不支持设备授权。' },
  },
  discover,
  prepare,
  monitor,
  estimate,
};

export default plugin;
