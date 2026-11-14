import type { BillingType, Money, Price, Protocol, ProviderAccount, ProviderModel, ProviderMonitor, Usage } from '../../contracts/src/index.js';
import type { ManagedResource, ManagedResourceInput } from '../../contracts/src/index.js';
import { createHash } from 'node:crypto';
export type * from '../../contracts/src/index.js';
/** 插件声明的配置字段说明；只包含非秘密的展示元数据。 */
export interface ProviderSecretField {
  key: string;
  label: string;
  required?: boolean;
  description: string;
  placeholder?: string;
}
export interface ProviderSetup {
  /** 推荐 Base URL；null 表示没有通用默认地址，必须由管理员填写。 */
  baseUrl?: { default: string | null; hint: string };
  /** 推荐计费类型与计费口径说明。 */
  billingType?: { default: BillingType; hint: string };
  secrets?: ProviderSecretField[];
  options?: {
    example?: Record<string, unknown>;
    hint: string;
    fields?: Array<{ key: string; description: string }>;
  };
  /** 上游令牌模板是否受插件支持，以及填写规则。 */
  tokenTemplate?: { supported: boolean; hint: string };
  authorization?: { supported: boolean; hint: string };
}
export interface AuthorizationStatus {
  authorized: boolean;
  accountId?: string;
  planType?: string;
  email?: string;
  expiresAt?: string;
}
export interface ProviderContext {
  account: ProviderAccount;
  secrets: Record<string, string>;
  /** 已配置代理，且不自动重试。 */
  fetch: typeof globalThis.fetch;
  signal: AbortSignal;
  now: () => Date;
  updateSecrets: (patch: Record<string, string>) => Promise<void>;
  /** 可选，以兼容旧插件及独立测试上下文；仅记录非秘密资源证据。 */
  managedResources?: ManagedResource[];
  recordResource?: (resource: ManagedResourceInput) => Promise<void>;
}
export interface Discovery {
  models: ProviderModel[];
  /** 只有完整且权限明确的目录才能替换旧快照。 */
  complete: boolean;
  warnings?: string[];
}
export interface PreparedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** 上游仅支持SSE时，核心可为非流式Responses调用聚合完成事件。 */
  responseFormat?: 'sse';
}
export interface Settlement {
  upstreamRequestId: string;
  money: Money;
  source: string;
}
export interface ProviderPlugin {
  id: string;
  name: string;
  /** 后台表单的插件专属默认值与字段说明。 */
  setup?: ProviderSetup;
  cleanup?: {
    preview(context: ProviderContext): Promise<Array<{ resource: ManagedResourceInput; verified: boolean; absent?: boolean; reason?: string }>>;
    execute(context: ProviderContext, resource: ManagedResourceInput): Promise<{ state: 'deleted' | 'absent' | 'failed' | 'unknown'; message?: string }>;
  };
  discover(context: ProviderContext): Promise<Discovery>;
  prepare(context: ProviderContext, model: ProviderModel, body: Record<string, unknown>, protocol: Protocol): Promise<PreparedRequest>;
  monitor?(context: ProviderContext): Promise<ProviderMonitor>;
  /** 仅精确关联的请求可用于真实结算。 */
  reconcile?(context: ProviderContext, since: string): Promise<Settlement[]>;
  estimate?(price: Price, usage: Usage, body: Record<string, unknown>): Money | null;
  authorization?: {
    start(context: ProviderContext): Promise<DeviceAuthorization>;
    poll(context: ProviderContext, grant: DeviceAuthorization): Promise<AuthorizationResult>;
    /** 只读取已保存的非秘密授权状态，用于刷新后的状态回显。 */
    status?(context: ProviderContext): Promise<AuthorizationStatus>;
  };
}
/** New API 令牌前缀 sk- 可能由平台展示层添加；摘要不可用于推理。 */
export function credentialFingerprint(value: string): string {
  return createHash('sha256').update(value.replace(/^sk-/, '')).digest('hex');
}
export interface DeviceAuthorization {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: string;
}
export type AuthorizationResult =
  | { state: 'pending'; intervalSeconds: number; message: string }
  | { state: 'complete'; accountId: string; planType?: string; email?: string; expiresAt: string };
export class ProviderError extends Error {
  constructor(message: string, public readonly code = 'provider_error', public readonly status = 502) {
    super(message); this.name = 'ProviderError';
  }
}
export async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new ProviderError(`上游接口返回HTTP ${response.status}`, 'upstream_http', response.status);
  return response.json();
}
export function protocolPath(protocol: Protocol): string {
  return protocol === 'responses' ? '/responses' : protocol === 'messages' ? '/messages' : '/chat/completions';
}
export function apiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base.endsWith('/v1') ? base : `${base}/v1`}${path}`;
}
