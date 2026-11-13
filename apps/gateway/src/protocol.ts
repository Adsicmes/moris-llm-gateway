import type { Protocol, Usage } from '../../../packages/contracts/src/index.js';

type Json = Record<string, unknown>;
const object = (v: unknown): Json => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Json : {};
const count = (v: unknown): number | undefined => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;

export function readUsage(protocol: Protocol, payload: unknown, previous: Usage | null = null): Usage | null {
  const root = object(payload);
  const response = object(root.response); const message = object(root.message);
  const usage = object(root.usage ?? response.usage ?? message.usage);
  if (!Object.keys(usage).length) return previous;
  if (protocol === 'messages') {
    const read = count(usage.cache_read_input_tokens) ?? previous?.cacheRead ?? 0;
    const write = count(usage.cache_creation_input_tokens) ?? previous?.cacheWrite ?? 0;
    const rawInput = count(usage.input_tokens);
    const input = rawInput === undefined ? previous?.input : rawInput + read + write;
    const output = count(usage.output_tokens) ?? previous?.output;
    return input === undefined || output === undefined ? previous : { input, output, cacheRead: read, cacheWrite: write };
  }
  const input = count(usage.prompt_tokens ?? usage.input_tokens);
  const output = count(usage.completion_tokens ?? usage.output_tokens);
  if (input === undefined || output === undefined) return previous;
  const details = object(usage.prompt_tokens_details ?? usage.input_tokens_details);
  const read = count(details.cached_tokens ?? usage.prompt_cache_hit_tokens) ?? 0;
  return read > input ? null : { input, output, cacheRead: read, cacheWrite: count(details.cache_write_tokens) ?? 0 };
}
export interface StreamFact { effective: boolean; terminal: boolean; error: boolean; usage: Usage | null; upstreamRequestId?: string }
export function inspectEvent(protocol: Protocol, data: string | undefined, previous: Usage | null): StreamFact {
  const base: StreamFact = { effective: false, terminal: false, error: false, usage: previous };
  if (!data) return base;
  if (data === '[DONE]') return { ...base, terminal: protocol === 'chat-completions' };
  let root: Json;
  try { root = object(JSON.parse(data)); } catch { throw new Error('上游流事件不是有效JSON'); }
  const response = object(root.response); const message = object(root.message);
  const id = root.id ?? response.id ?? message.id;
  base.upstreamRequestId = typeof id === 'string' ? id : undefined;
  base.usage = readUsage(protocol, root, previous);
  if (root.error || root.type === 'error' || root.type === 'response.failed' || root.type === 'response.incomplete') return { ...base, error: true };
  if (protocol === 'chat-completions') {
    const choices = Array.isArray(root.choices) ? root.choices : [];
    base.effective = choices.some(choice => {
      const delta = object(object(choice).delta);
      return !!delta.content || !!delta.reasoning_content || !!delta.reasoning || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) || !!delta.function_call;
    });
  } else if (protocol === 'responses') {
    const type = String(root.type ?? '');
    const item = object(root.item);
    base.effective = /(?:output_text|reasoning.*|function_call_arguments)\.delta$/.test(type) && !!root.delta || type === 'response.output_item.added' && ['function_call', 'custom_tool_call'].includes(String(item.type));
    base.terminal = type === 'response.completed';
  } else {
    const delta = object(root.delta); const block = object(root.content_block);
    base.effective = root.type === 'content_block_delta' && (!!delta.text || !!delta.thinking || !!delta.partial_json) || root.type === 'content_block_start' && (block.type === 'tool_use' || !!block.text || !!block.thinking);
    base.terminal = root.type === 'message_stop';
  }
  return base;
}
export interface SseFrame { raw: string; data?: string }
export class SseDecoder {
  private buffer = '';
  private decoder = new TextDecoder();
  push(bytes: Uint8Array, final = false): SseFrame[] {
    this.buffer += this.decoder.decode(bytes, { stream: !final });
    if (this.buffer.length > 4 * 1024 * 1024) throw new Error('上游流单个事件超出限制');
    const frames: SseFrame[] = [];
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const end = match.index + match[0].length;
      const raw = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end);
      const data = raw.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      frames.push({ raw, data: data || undefined });
    }
    if (final && this.buffer.trim()) throw new Error('上游流事件未完整结束');
    return frames;
  }
}
export function streamError(protocol: Protocol, code: string): string {
  const message = '上游流中断，请检查请求记录后手动重试';
  if (protocol === 'messages') return `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: code, message } })}\n\n`;
  if (protocol === 'responses') return `event: error\ndata: ${JSON.stringify({ type: 'error', code, message })}\n\n`;
  return `data: ${JSON.stringify({ error: { code, message } })}\n\n`;
}
