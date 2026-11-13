import type {
  Discovery,
  Money,
  Price,
  PreparedRequest,
  Protocol,
  ProviderContext,
  ProviderModel,
  ProviderMonitor,
  ProviderPlugin,
  Usage,
} from '@moris/provider-sdk';
import { ProviderError } from './runtime.js';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const PRICE_VERSION = 'deepseek-pricing-2026-11-13';
const PRICING_SOURCE = 'https://api-docs.deepseek.com/quick_start/pricing';
const MODELS_SOURCE = 'https://api-docs.deepseek.com/api/list-models';
const BALANCE_SOURCE = 'https://api-docs.deepseek.com/api/get-user-balance';

interface Rates {
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

interface DeepSeekModelFacts {
  name: string;
  family: string;
  context: number;
  output: number;
  input: Array<'text' | 'image'>;
  tools: boolean;
  reasoning: boolean;
  efforts: string[];
  peak: Rates;
  offPeak: Rates;
}

const MODELS: Record<string, DeepSeekModelFacts> = {
  'deepseek-flash': {
    name: 'DeepSeek-V4.1-Flash',
    family: 'deepseek',
    context: 1_048_576,
    output: 393_216,
    input: ['text', 'image'],
    tools: true,
    reasoning: true,
    efforts: ['low', 'high', 'max'],
    peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
    offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  },
  'deepseek-v4-pro': {
    name: 'DeepSeek-V4-Pro',
    family: 'deepseek',
    context: 1_048_576,
    output: 393_216,
    input: ['text'],
    tools: true,
    reasoning: true,
    efforts: ['low', 'high', 'max'],
    peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
    offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
  },
};

function asObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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
  return (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '').replace(/\/v1$/i, '');
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
    throw new ProviderError(
      asString(object?.message) ?? asString(asObject(object?.error)?.message) ?? `上游 ${url} 返回 HTTP ${response.status}`,
      'upstream_http',
      response.status,
    );
  }
  return body;
}

function priceExpression(modelId: string, facts: DeepSeekModelFacts): string {
  return [
    'deepseek-peak-offpeak:v1',
    `model=${modelId}`,
    `cache_hit_peak=${facts.peak.cacheHit}`,
    `cache_miss_peak=${facts.peak.cacheMiss}`,
    `output_peak=${facts.peak.output}`,
    `cache_hit_off_peak=${facts.offPeak.cacheHit}`,
    `cache_miss_off_peak=${facts.offPeak.cacheMiss}`,
    `output_off_peak=${facts.offPeak.output}`,
    'unit=USD_per_1M_tokens',
    'peak=01:00-04:00,06:00-10:00 UTC Mon-Fri',
    'off_peak=all_other_hours_including_weekends',
    'exclude=Chinese_public_holidays',
  ].join('; ');
}

function priceFor(facts: DeepSeekModelFacts, modelId: string): Price {
  return {
    kind: 'complex',
    currency: 'USD',
    expression: priceExpression(modelId, facts),
    source: PRICING_SOURCE,
    version: PRICE_VERSION,
  };
}

/** Peak windows from the official pricing page: 01:00-04:00 and 06:00-10:00 UTC, Mon-Fri. */
export function isDeepSeekPeak(now: Date, isChinesePublicHoliday = false): boolean {
  if (isChinesePublicHoliday) return false;
  const weekday = now.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
}

/**
 * 官方 DeepSeek token 计费函数。`usage.input` 按契约包含缓存 token；
 * cacheWrite 没有独立价格，按 cache miss 计入普通输入。中文法定节假日需要调用方提供。
 */
export function deepSeekCost(
  now: Date,
  modelId: string,
  usage: Usage,
  options: { isChinesePublicHoliday?: boolean } = {},
): Money | null {
  const facts = MODELS[modelId];
  if (!facts) return null;
  const rates = isDeepSeekPeak(now, options.isChinesePublicHoliday) ? facts.peak : facts.offPeak;
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  if (cacheRead > input) return null;
  const normalInput = Math.max(input - cacheRead - cacheWrite, 0);
  const amount =
    (normalInput * rates.cacheMiss + cacheRead * rates.cacheHit + cacheWrite * rates.cacheMiss + output * rates.output) /
    1_000_000;
  return Number.isFinite(amount) && amount >= 0 ? { amount, currency: 'USD' } : null;
}

async function discover(context: ProviderContext): Promise<Discovery> {
  const root = rootUrl(context.account.baseUrl);
  const body = await fetchJson(context, `${root}/models`, {
    headers: { Authorization: `Bearer ${context.secrets.apiKey ?? ''}`, Accept: 'application/json' },
  });
  const data = asArray(asObject(body)?.data)
    .map((item) => asObject(item))
    .filter((item): item is Record<string, unknown> => !!item);
  if (!data.length) {
    return { models: [], complete: false, warnings: ['DeepSeek /models 返回空列表'] };
  }

  const models: ProviderModel[] = [];
  for (const item of data) {
    const id = asString(item.id);
    if (!id) continue;
    const facts = MODELS[id];
    if (!facts) {
      models.push({
        path: id,
        upstreamModel: id,
        name: asString(item.name) ?? id,
        family: 'deepseek',
        protocol: 'chat-completions',
        capabilities: { tools: false, input: ['text'], output: ['text'] },
        limit: { context: null, output: null },
        variants: {},
        price: { kind: 'unknown', currency: 'USD', source: MODELS_SOURCE },
        enabled: false,
        available: true,
        unknownParameters: ['tools'],
        disabledReason: '插件没有该模型的已核实规格与价格',
        sources: { models: MODELS_SOURCE },
      });
      continue;
    }

    const inputModalities = asArray(item.input_modalities).filter(
      (value): value is 'text' | 'image' => value === 'text' || value === 'image',
    );
    const efforts = asArray(asObject(item.effort)?.supported_levels)
      .map((value) => asString(value))
      .filter((value): value is string => !!value);
    const variants: Record<string, Record<string, unknown>> = {};
    for (const effort of efforts.length ? efforts : facts.efforts) {
      variants[effort] = { reasoning_effort: effort };
    }
    variants['non-thinking'] = { thinking: { type: 'disabled' } };
    const contextWindow = asNumber(item.context_window) ?? facts.context;
    const output = asNumber(item.max_output_tokens) ?? facts.output;
    const protocol =
      context.account.options.protocol === 'responses' || context.account.options.protocol === 'messages'
        ? (context.account.options.protocol as Protocol)
        : 'chat-completions';

    models.push({
      path: id,
      upstreamModel: id,
      name: asString(item.name) ?? facts.name,
      family: facts.family,
      protocol,
      capabilities: {
        tools: facts.tools,
        input: inputModalities.length ? inputModalities : facts.input,
        output: ['text'],
        reasoning: facts.reasoning,
      },
      limit: { context: contextWindow, output },
      variants,
      price: priceFor(facts, id),
      enabled: contextWindow != null && output != null,
      ...(contextWindow == null || output == null ? { disabledReason: '官方 /models 未返回完整上下文或输出上限' } : {}),
      sources: {
        models: MODELS_SOURCE,
        pricing: PRICING_SOURCE,
        capabilities: 'https://api-docs.deepseek.com/guides/thinking_mode',
      },
    });
  }

  return { models, complete: true };
}

function stripClientRoutingFields(body: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body };
  for (const key of ['authorization', 'Authorization', 'api_key', 'apiKey', 'base_url', 'baseUrl', 'url']) {
    delete next[key];
  }
  return next;
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
  const root = rootUrl(context.account.baseUrl);
  const path =
    protocol === 'messages' ? '/anthropic/v1/messages' : protocol === 'responses' ? '/responses' : '/chat/completions';
  const headers: Record<string, string> = {
    Authorization: `Bearer ${context.secrets.apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (protocol === 'messages') {
    headers['x-api-key'] = context.secrets.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  }
  return {
    url: `${root}${path}`,
    headers,
    body: { ...stripClientRoutingFields(body), model: model.upstreamModel },
  };
}

async function monitor(context: ProviderContext): Promise<ProviderMonitor> {
  const sampledAt = context.now().toISOString();
  try {
    const body = await fetchJson(context, `${rootUrl(context.account.baseUrl)}/user/balance`, {
      headers: { Authorization: `Bearer ${context.secrets.apiKey ?? ''}`, Accept: 'application/json' },
    });
    const object = asObject(body);
    const infos = asArray(object?.balance_infos)
      .map((item) => asObject(item))
      .filter((item): item is Record<string, unknown> => !!item);
    const balances = infos
      .map((info) => {
        const amount = asNumber(info.total_balance);
        const currency = asString(info.currency);
        if (amount == null || !currency) return null;
        return { currency, amount, unit: 'total_balance' };
      })
      .filter((item): item is { currency: string; amount: number; unit: string } => item != null);
    if (!balances.length) {
      return { state: 'unknown', balances: [], windows: [], sampledAt, message: '余额响应缺少 balance_infos/总余额' };
    }
    const available = object?.is_available === true;
    return {
      state: 'ok',
      balances,
      windows: [],
      sampledAt,
      message: available ? 'DeepSeek 官方余额（含网关外使用）' : 'DeepSeek 返回 is_available=false：余额不足或账号不可用',
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

/**
 * estimate 无法获知“当前时间”和中文法定节假日，因此不做猜测；需要时使用导出的
 * deepSeekCost(now, model, usage, { isChinesePublicHoliday }) 在核心账本中计算。
 */
function estimate(): Money | null {
  return null;
}

export const plugin: ProviderPlugin = {
  id: 'deepseek',
  name: 'DeepSeek 官方',
  discover,
  prepare,
  monitor,
  estimate,
};

export default plugin;
