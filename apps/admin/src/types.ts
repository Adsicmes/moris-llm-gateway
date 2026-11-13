import type {
  BillingType,
  CatalogModel,
  DataState,
  Money,
  Price,
  ProviderAccount,
  QuotaSummary,
  Settings,
  TokenTemplate,
  Usage,
} from './lib/contracts';

export interface Session {
  username: string;
  csrfToken: string;
}

/** GET /api/admin/overview。金额未知为 null，不能当作 0。 */
export interface Overview {
  accounts: number;
  models: number;
  requests: number;
  attempts: number;
  paidCny: number | null;
  estimatedUsd: number | null;
  settledUsd: number | null;
  equivalentUsd: number | null;
  unknownAttempts: number;
  unknownEquivalentAttempts: number;
  /** 服务端按币种汇总的估算费用；可能同时包含 USD 与 CNY。 */
  estimatedCost: Money[];
  /** 服务端按币种汇总的真实结算费用；可能同时包含 USD 与 CNY。 */
  settledCost: Money[];
}

export interface PluginInfo {
  id: string;
  name: string;
}

export interface ProvidersResponse {
  items: ProviderAccount[];
}

export interface PluginsResponse {
  items: PluginInfo[];
}

export interface ProviderInput {
  namespace: string;
  name: string;
  plugin: string;
  baseUrl: string;
  billingType: BillingType;
  enabled?: boolean;
  proxyUrl?: string;
  autoCreateTokens?: boolean;
  tokenTemplate?: TokenTemplate;
  options?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export interface SyncResult {
  ok: boolean;
  state: DataState;
  error?: string;
}

export interface OAuthStartResponse {
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface OAuthPollPending {
  state: 'pending';
  intervalSeconds?: number;
  message?: string;
}

export interface OAuthPollComplete {
  state: 'complete';
  accountId: string;
  planType?: string;
  email?: string;
  expiresAt?: string;
}

export type OAuthPollResponse = OAuthPollPending | OAuthPollComplete;

export interface ModelsResponse {
  items: CatalogModel[];
}

export interface QuotaResponse {
  items: QuotaSummary[];
}

/** 列表接口的请求记录。费用为原币 Money 数组。 */
export interface RequestSummary {
  id: string;
  modelId: string;
  deviceId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  attempts: number;
  estimatedCost: Money[] | null;
  settledCost: Money[] | null;
  equivalentUsd: number | null;
}

export interface RequestsResponse {
  items: RequestSummary[];
  total: number;
}

/**
 * docs/API.md 没有逐字段定义 attempt；以下字段对应服务端 AttemptRecord。
 * 渲染时只显示实际存在的数据，其余字段放入只读技术详情。
 */
export interface Attempt {
  id?: string;
  requestId?: string;
  accountId?: string;
  modelId?: string;
  number?: number;
  startedAt?: string;
  finishedAt?: string | null;
  status?: string;
  httpStatus?: number;
  upstreamRequestId?: string;
  usage?: Usage | null;
  price?: Price;
  billingType?: BillingType;
  estimatedCost?: Money | null;
  settledCost?: Money | null;
  equivalentUsd?: number | null;
  usdCny?: number | null;
  estimatedCny?: number | null;
  settledCny?: number | null;
  settlementSource?: string;
  pool?: string;
  [key: string]: unknown;
}

/** 详情接口返回的 request 是生成级原始记录，不含聚合费用。 */
export interface RequestDetailRecord {
  id: string;
  modelId: string;
  deviceId: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  [key: string]: unknown;
}

export interface RequestDetailResponse {
  request: RequestDetailRecord;
  attempts: Attempt[];
}

export interface Bill {
  id: string;
  accountId: string;
  paidAt: string;
  amountCny: number;
  period?: string;
  method?: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface BillsResponse {
  items: Bill[];
  totalCny: number;
}

export type BillInput = {
  accountId: string;
  paidAt: string;
  amountCny: number;
  period?: string;
  method?: string;
  note?: string;
};

export interface Device {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export interface DevicesResponse {
  items: Device[];
}

export interface DeviceCreateResponse {
  item: Device;
  key: string;
}

export type { Settings, TokenTemplate, Money, DataState, CatalogModel, ProviderAccount, QuotaSummary, BillingType };
