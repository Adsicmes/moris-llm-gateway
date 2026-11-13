export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
}

interface ErrorBody {
  error?: { code?: unknown; message?: unknown };
}

function errorMessage(status: number, body: unknown): string {
  const parsed = body as ErrorBody | null;
  const message = parsed?.error?.message;
  if (typeof message === 'string' && message.trim()) return message;
  if (status === 401) return '登录状态已失效，请重新登录。';
  if (status === 403) return '权限或 CSRF 校验失败。';
  if (status === 404) return '请求的资源不存在。';
  if (status >= 500) return '网关服务返回了服务器错误。';
  return `请求失败（HTTP ${status}）。`;
}

/** 所有管理 API 的唯一出口；Cookie 由浏览器携带，CSRF 只保存在内存。 */
export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (method !== 'GET' && options.csrfToken) headers.set('X-CSRF-Token', options.csrfToken);

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', '无法连接网关服务，请确认后端已启动后重试。');
  }

  const contentType = response.headers.get('content-type') ?? '';
  let payload: unknown = null;
  if (response.status !== 204) {
    if (contentType.includes('application/json')) {
      payload = await response.json().catch(() => null);
    } else {
      const text = await response.text().catch(() => '');
      payload = text ? { raw: text } : null;
    }
  }

  if (!response.ok) {
    const body = payload as ErrorBody | null;
    const code = typeof body?.error?.code === 'string' ? body.error.code : `http_${response.status}`;
    throw new ApiError(response.status, code, errorMessage(response.status, payload));
  }

  return payload as T;
}

export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return `权限或 CSRF 校验失败：${error.message}`;
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return '发生未知错误。';
}
