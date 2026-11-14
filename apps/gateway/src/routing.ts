import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CatalogModel, Protocol, Usage } from '../../../packages/contracts/src/index.js';
import { Providers } from './providers.js';
import type { AttemptRecord, RequestRecord, Store } from './store.js';
import { asCny, asUsd, estimateCost } from './billing.js';
import { inspectEvent, readUsage, SseDecoder, streamError } from './protocol.js';

export class GatewayError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) { super(message); }
}
class UpstreamFailure extends Error {
  constructor(readonly retryable: boolean, readonly status = 502, readonly retryAfterMs = 0) { super('上游请求失败'); }
}
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value); return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}
function hasImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasImage);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['image', 'image_url', 'input_image'].includes(String(record.type)) || Object.values(record).some(hasImage);
}
export function compatible(source: CatalogModel, target: CatalogModel, body: Record<string, unknown>): boolean {
  if (source.protocol !== target.protocol) return false;
  if (Array.isArray(body.tools) && body.tools.length > 0 && !target.capabilities.tools) return false;
  if (hasImage(body) && !target.capabilities.input.includes('image')) return false;
  if ((body.reasoning || body.reasoning_effort || body.thinking) && !target.capabilities.reasoning) return false;
  // 不通过粗略token估算假装准确；回退至少保持原模型能力及限制。
  if ((target.limit.context ?? 0) < (source.limit.context ?? 0) || (target.limit.output ?? 0) < (source.limit.output ?? 0)) return false;
  const output = body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens;
  return typeof output !== 'number' || output <= (target.limit.output ?? 0);
}
async function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
  });
}

export async function executeRequest(providers: Providers, protocol: Protocol, req: FastifyRequest, reply: FastifyReply, deviceId: string): Promise<void> {
  const store = providers.store; const settings = store.settings();
  const body = req.body as Record<string, unknown>;
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.model !== 'string') throw new GatewayError('invalid_request', '请求需要model字段');
  const selected = store.model(body.model);
  if (!selected) throw new GatewayError('model_not_found', '模型不存在，请刷新目录并重新选择', 404);
  if (selected.protocol !== protocol) throw new GatewayError('protocol_mismatch', '模型协议与调用入口不匹配');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw new GatewayError('invalid_request', 'stream必须为布尔值');
  const targets = [selected, ...(settings.fallback[selected.id] ?? []).map(id => store.model(id)).filter((m): m is CatalogModel => !!m)];
  const eligible = targets.filter(model => providers.callable(model) && compatible(selected, model, body));
  if (!eligible.length) throw new GatewayError('model_unavailable', '模型目录已过期、模型已停用或能力不兼容，请刷新目录并重新选择', 503);
  const request: RequestRecord = { id: randomUUID(), modelId: selected.id, deviceId, startedAt: new Date().toISOString(), finishedAt: null, status: 'running' };
  store.saveRequest(request);
  const disconnected = new AbortController(); const deadline = AbortSignal.timeout(settings.requestTimeoutMs);
  const signal = AbortSignal.any([disconnected.signal, deadline]);
  const close = () => { if (!reply.raw.writableFinished) disconnected.abort(new Error('客户端取消')); };
  reply.raw.on('close', close);
  let emitted = false; let success = false;
  let finalStatus = 502; let targetIndex = 0;
  const started = Date.now();
  const write = async (text: string) => {
    if (signal.aborted) throw signal.reason;
    if (!reply.raw.write(text)) await once(reply.raw, 'drain', { signal });
  };
  try {
    for (let number = 1; number <= settings.maxAttempts; number++) {
      if (signal.aborted) break;
      const model = eligible[targetIndex]!;
      // 每次发出前复核当前目录及停用状态；不主动打断已发送的请求。
      const current = store.model(model.id);
      if (!current || !providers.callable(current)) { targetIndex++; if (targetIndex >= eligible.length) break; number--; continue; }
      const account = store.account(model.accountId)!; const plugin = providers.registry.get(account.plugin);
      const releaseAccount = providers.acquire(account.id);
      const attempt: AttemptRecord = {
        id: randomUUID(), requestId: request.id, accountId: account.id, modelId: model.id, number,
        startedAt: new Date().toISOString(), finishedAt: null, status: 'running', usage: null, price: model.price,
        estimatedCost: null, settledCost: null, equivalentUsd: null, usdCny: settings.usdCny, estimatedCny: null, settledCny: null,
        billingType: account.billingType, pool: typeof account.options.quotaPool === 'string' ? account.options.quotaPool : 'default',
      };
      const attemptAbort = new AbortController(); const attemptSignal = AbortSignal.any([signal, attemptAbort.signal]);
      let response: Response | undefined; let usage: Usage | null = null; let complete = false;
      let failure: UpstreamFailure | undefined;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let sent = false;
      const arm = (ms: number) => { if (timeout) clearTimeout(timeout); timeout = setTimeout(() => attemptAbort.abort(new Error('上游响应超时')), ms); };
      try {
        const context = providers.context(account, attemptSignal);
        const outgoing: Record<string, unknown> = { ...body, model: model.upstreamModel };
        if (protocol === 'chat-completions' && body.stream) outgoing.stream_options = { ...(typeof body.stream_options === 'object' ? body.stream_options : {}), include_usage: true };
        // prepare不计作推理attempt；如需刷新授权，插件通过同一受控transport执行。
        arm(settings.firstEventTimeoutMs);
        const prepared = await plugin.prepare(context, model, outgoing, protocol);
        const url = new URL(prepared.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new GatewayError('invalid_upstream', '供应商请求地址无效', 502);
        store.saveAttempt(attempt); sent = true;
        response = await context.fetch(url, { method: 'POST', headers: { ...prepared.headers, 'content-type': 'application/json' }, body: JSON.stringify(prepared.body), signal: attemptSignal });
        attempt.httpStatus = response.status;
        attempt.upstreamRequestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? undefined;
        if (!response.ok) {
          // 不保存上游错误正文（可能含提示词或密钥）；有usage时仍记账。
          const errorBody = await boundedJson(response, 1024 * 1024).catch(() => null);
          usage = readUsage(protocol, errorBody);
          throw new UpstreamFailure([429, 502, 503, 504].includes(response.status), response.status, retryAfter(response.headers.get('retry-after')));
        }
        if (body.stream) {
          if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new UpstreamFailure(false);
          const reader = response.body.getReader(); const decoder = new SseDecoder();
          let prelude = ''; let terminal = false;
          const consume = async (frames: ReturnType<SseDecoder['push']>) => {
            for (const frame of frames) {
              arm(settings.idleTimeoutMs);
              const fact = inspectEvent(protocol, frame.data, usage); usage = fact.usage;
              if (fact.upstreamRequestId && !attempt.upstreamRequestId) attempt.upstreamRequestId = fact.upstreamRequestId;
              if (fact.error) throw new UpstreamFailure(false);
              if (!emitted) {
                prelude += frame.raw;
                if (prelude.length > 256 * 1024) throw new UpstreamFailure(false);
                if (fact.effective || fact.terminal) {
                  emitted = true;
                  reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no', 'x-moris-request-id': request.id });
                  await write(prelude); prelude = '';
                }
              } else await write(frame.raw);
              if (fact.terminal) { terminal = true; break; }
            }
          };
          try {
            while (!terminal) {
              const next = await reader.read();
              if (next.done) { await consume(decoder.push(new Uint8Array(), true)); break; }
              await consume(decoder.push(next.value));
            }
            if (!terminal) throw new UpstreamFailure(true);
          } finally { await reader.cancel().catch(() => undefined); }
          complete = true; success = true;
          reply.raw.end();
        } else {
          const result = prepared.responseFormat === 'sse' && protocol === 'responses'
            ? await aggregateResponse(response, arm, settings.idleTimeoutMs, value => { usage = value; })
            : await boundedJson(response, 32 * 1024 * 1024);
          const record = result as Record<string, unknown>;
          usage = readUsage(protocol, result);
          if (record.error || record.status === 'failed' || record.status === 'incomplete') throw new UpstreamFailure(false);
          if (!attempt.upstreamRequestId && typeof record.id === 'string') attempt.upstreamRequestId = record.id;
          complete = true; success = true;
          reply.header('x-moris-request-id', request.id).send(result);
        }
      } catch (error) {
        if (error instanceof GatewayError) failure = new UpstreamFailure(false, error.status);
        else if (error instanceof UpstreamFailure) failure = error;
        else failure = new UpstreamFailure(!signal.aborted && (attemptAbort.signal.aborted || error instanceof TypeError));
        finalStatus = failure.status;
      } finally {
        try {
        if (timeout) clearTimeout(timeout);
        attemptAbort.abort();
        if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
        if (sent) {
          attempt.usage = usage; attempt.finishedAt = new Date().toISOString();
          attempt.status = complete ? 'succeeded' : disconnected.signal.aborted ? 'cancelled' : emitted ? 'interrupted' : 'failed';
          let cost = estimateCost(model.price, usage);
          if (plugin.estimate && usage) {
            try { cost = plugin.estimate(model.price, usage, body); } catch { cost = null; }
          }
          if (cost && (!Number.isFinite(cost.amount) || cost.amount < 0 || !['USD', 'CNY'].includes(cost.currency))) cost = null;
          attempt.estimatedCost = account.billingType === 'subscription' ? { amount: 0, currency: 'USD' } : usage || model.price.kind === 'request' ? cost : null;
          attempt.estimatedCny = asCny(attempt.estimatedCost, settings.usdCny);
          const reference = model.referencePrice ?? model.price;
          let equivalent = estimateCost(reference, usage);
          if (plugin.estimate && usage) {
            try { equivalent = plugin.estimate(reference, usage, body); } catch { equivalent = null; }
          }
          if (equivalent && (!Number.isFinite(equivalent.amount) || equivalent.amount < 0 || !['USD', 'CNY'].includes(equivalent.currency))) equivalent = null;
          attempt.equivalentUsd = asUsd(equivalent, settings.usdCny);
          store.saveAttempt(attempt);
        }
        } finally { releaseAccount(); }
      }
      if (success || emitted || signal.aborted || !failure?.retryable || number >= settings.maxAttempts) break;
      if (targetIndex + 1 < eligible.length) targetIndex++;
      const delay = Math.max(Math.min(250 * 2 ** (number - 1), 2000), failure.retryAfterMs);
      if (Date.now() - started + delay >= settings.requestTimeoutMs) break;
      await pause(delay, signal);
    }
  } catch { /* 信号终止由统一结束路径处理，不追加重试。 */ }
  finally {
    request.finishedAt = new Date().toISOString();
    request.status = success ? 'succeeded' : disconnected.signal.aborted ? 'cancelled' : emitted ? 'interrupted' : 'failed';
    store.saveRequest(request); reply.raw.off('close', close);
  }
  if (success || disconnected.signal.aborted) return;
  if (emitted) {
    if (!reply.raw.destroyed) reply.raw.end(streamError(protocol, 'upstream_interrupted'));
    return;
  }
  reply.code(deadline.aborted ? 504 : finalStatus === 401 || finalStatus === 403 ? 502 : finalStatus).header('x-moris-request-id', request.id).send({ error: { code: deadline.aborted ? 'request_timeout' : 'upstream_failed', message: '上游调用未完成，自动尝试已停止；可在后台查看请求记录' } });
}

async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.body) throw new Error('上游响应为空');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.length; if (size > maxBytes) throw new Error('上游响应超过限制');
      chunks.push(result.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally { await reader.cancel().catch(() => undefined); }
}

async function aggregateResponse(response: Response, arm: (ms: number) => void, idleMs: number, onUsage: (usage: Usage | null) => void): Promise<Record<string, unknown>> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new UpstreamFailure(false);
  const reader = response.body.getReader(); const decoder = new SseDecoder();
  let size = 0; let usage: Usage | null = null;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > 32 * 1024 * 1024) throw new UpstreamFailure(false);
      for (const frame of decoder.push(chunk.value)) {
        arm(idleMs);
        const fact = inspectEvent('responses', frame.data, usage);
        usage = fact.usage; onUsage(usage);
        if (fact.error) throw new UpstreamFailure(false);
        if (fact.terminal && frame.data) {
          const payload = JSON.parse(frame.data) as { response?: Record<string, unknown> };
          if (!payload.response || typeof payload.response !== 'object') throw new UpstreamFailure(false);
          return payload.response;
        }
      }
    }
    throw new UpstreamFailure(true);
  } finally { await reader.cancel().catch(() => undefined); }
}
