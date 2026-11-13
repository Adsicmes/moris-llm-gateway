/**
 * 有限、显式的 New API tiered_expr 求值器。
 *
 * 只实现 New API `pkg/billingexpr/expr.md` 中记录的变量、函数和运算；
 * 不做 eval，也不把不认识的表达式“猜”成简单单价。遇到时间、header、
 * 任务用量、图像/音频 token 等当前 Usage 契约无法提供的事实，返回 null。
 */
import type { Usage } from '@moris/provider-sdk';

type Value = number | string | boolean | undefined;

export type ExprNode =
  | { type: 'num'; value: number }
  | { type: 'str'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'var'; name: string }
  | { type: 'call'; name: string; args: ExprNode[] }
  | { type: 'unary'; op: '!' | '-'; arg: ExprNode }
  | { type: 'binary'; op: string; left: ExprNode; right: ExprNode }
  | { type: 'ternary'; cond: ExprNode; then: ExprNode; otherwise: ExprNode };

export class UnsupportedExpression extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedExpression';
  }
}

interface Token {
  kind: 'num' | 'str' | 'ident' | 'op' | 'eof';
  text: string;
  value?: number;
}

const TWO_CHAR_OPS = new Set(['<=', '>=', '==', '!=', '&&', '||']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '%', '?', ':', '(', ')', ',', '!', '<', '>']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      let text = '';
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\' && i + 1 < source.length) {
          const next = source[i + 1]!;
          text += next === 'n' ? '\n' : next;
          i += 2;
          continue;
        }
        text += source[i]!;
        i += 1;
      }
      if (i >= source.length) throw new UnsupportedExpression('字符串未闭合');
      i += 1;
      tokens.push({ kind: 'str', text });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] ?? ''))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)/.exec(source.slice(i));
      if (!match) throw new UnsupportedExpression('数字格式无效');
      tokens.push({ kind: 'num', text: match[0], value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
      if (!match) throw new UnsupportedExpression('标识符格式无效');
      tokens.push({ kind: 'ident', text: match[0] });
      i += match[0].length;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) {
      tokens.push({ kind: 'op', text: two });
      i += 2;
      continue;
    }
    if (ONE_CHAR_OPS.has(ch)) {
      tokens.push({ kind: 'op', text: ch });
      i += 1;
      continue;
    }
    throw new UnsupportedExpression(`不支持的字符 ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof', text: '' });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): ExprNode {
    const node = this.parseTernary();
    if (this.peek().kind !== 'eof') throw new UnsupportedExpression(`多余内容 ${this.peek().text}`);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private take(): Token {
    return this.tokens[this.index++]!;
  }

  private matchOp(...ops: string[]): boolean {
    const token = this.peek();
    if (token.kind === 'op' && ops.includes(token.text)) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectOp(op: string): void {
    if (!this.matchOp(op)) throw new UnsupportedExpression(`缺少 ${op}`);
  }

  private parseTernary(): ExprNode {
    const cond = this.parseOr();
    if (!this.matchOp('?')) return cond;
    const then = this.parseTernary();
    this.expectOp(':');
    const otherwise = this.parseTernary();
    return { type: 'ternary', cond, then, otherwise };
  }

  private parseOr(): ExprNode {
    let left = this.parseAnd();
    while (this.matchOp('||')) left = { type: 'binary', op: '||', left, right: this.parseAnd() };
    return left;
  }

  private parseAnd(): ExprNode {
    let left = this.parseEquality();
    while (this.matchOp('&&')) left = { type: 'binary', op: '&&', left, right: this.parseEquality() };
    return left;
  }

  private parseEquality(): ExprNode {
    let left = this.parseComparison();
    while (this.matchOp('==', '!=')) {
      const op = this.tokens[this.index - 1]!.text;
      left = { type: 'binary', op, left, right: this.parseComparison() };
    }
    return left;
  }

  private parseComparison(): ExprNode {
    let left = this.parseAdd();
    while (this.matchOp('<', '<=', '>', '>=')) {
      const op = this.tokens[this.index - 1]!.text;
      left = { type: 'binary', op, left, right: this.parseAdd() };
    }
    return left;
  }

  private parseAdd(): ExprNode {
    let left = this.parseMul();
    while (this.matchOp('+', '-')) {
      const op = this.tokens[this.index - 1]!.text;
      left = { type: 'binary', op, left, right: this.parseMul() };
    }
    return left;
  }

  private parseMul(): ExprNode {
    let left = this.parseUnary();
    while (this.matchOp('*', '/', '%')) {
      const op = this.tokens[this.index - 1]!.text;
      left = { type: 'binary', op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): ExprNode {
    if (this.matchOp('!')) return { type: 'unary', op: '!', arg: this.parseUnary() };
    if (this.matchOp('-')) return { type: 'unary', op: '-', arg: this.parseUnary() };
    return this.parsePrimary();
  }

  private parsePrimary(): ExprNode {
    const token = this.take();
    if (token.kind === 'num') return { type: 'num', value: token.value! };
    if (token.kind === 'str') return { type: 'str', value: token.text };
    if (token.kind === 'ident') {
      if (token.text === 'true') return { type: 'bool', value: true };
      if (token.text === 'false') return { type: 'bool', value: false };
      if (this.matchOp('(')) {
        const args: ExprNode[] = [];
        if (!this.matchOp(')')) {
          do {
            args.push(this.parseTernary());
          } while (this.matchOp(','));
          this.expectOp(')');
        }
        return { type: 'call', name: token.text, args };
      }
      return { type: 'var', name: token.text };
    }
    if (token.kind === 'op' && token.text === '(') {
      const node = this.parseTernary();
      this.expectOp(')');
      return node;
    }
    throw new UnsupportedExpression(`无法解析 ${JSON.stringify(token.text)}`);
  }
}

const KNOWN_FUNCTIONS = new Set([
  'tier',
  'fixed',
  'param',
  'max',
  'min',
  'abs',
  'ceil',
  'floor',
  'hour',
  'minute',
  'weekday',
  'month',
  'day',
  'header',
  'has',
  'u',
]);

const TIME_OR_REQUEST_FUNCTIONS = new Set(['hour', 'minute', 'weekday', 'month', 'day', 'header', 'u']);
const SUPPORTED_VARS = new Set(['p', 'c', 'cr', 'cc', 'cc1h', 'cc12h', 'len', 'image_count']);
const UNAVAILABLE_VARS = new Set(['img', 'img_cr', 'img_o', 'ai', 'ao']);

interface Inspection {
  vars: Set<string>;
  functions: Set<string>;
}

function inspect(node: ExprNode, state: Inspection): void {
  switch (node.type) {
    case 'var':
      state.vars.add(node.name);
      return;
    case 'call':
      state.functions.add(node.name);
      for (const arg of node.args) inspect(arg, state);
      return;
    case 'unary':
      inspect(node.arg, state);
      return;
    case 'binary':
      inspect(node.left, state);
      inspect(node.right, state);
      return;
    case 'ternary':
      inspect(node.cond, state);
      inspect(node.then, state);
      inspect(node.otherwise, state);
      return;
    default:
  }
}

function readPath(body: Record<string, unknown>, path: string): unknown {
  let current: unknown = body;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function asNumber(value: Value): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UnsupportedExpression('需要有限数值');
  }
  return value;
}

interface Runtime {
  vars: Record<string, number>;
  body: Record<string, unknown>;
}

function evaluate(node: ExprNode, runtime: Runtime): Value {
  switch (node.type) {
    case 'num':
    case 'str':
    case 'bool':
      return node.value;
    case 'var': {
      if (node.name === 'image_count') {
        const n = Number(runtime.body.n);
        return Number.isFinite(n) && n > 0 ? n : 1;
      }
      if (UNAVAILABLE_VARS.has(node.name)) throw new UnsupportedExpression(`缺少 ${node.name} 的明细`);
      if (!SUPPORTED_VARS.has(node.name)) throw new UnsupportedExpression(`不支持的变量 ${node.name}`);
      const value = runtime.vars[node.name];
      if (value == null) throw new UnsupportedExpression(`缺少变量 ${node.name}`);
      return value;
    }
    case 'unary': {
      const arg = evaluate(node.arg, runtime);
      if (node.op === '!') return !arg;
      return -asNumber(arg);
    }
    case 'binary': {
      if (node.op === '&&') return Boolean(evaluate(node.left, runtime)) && Boolean(evaluate(node.right, runtime));
      if (node.op === '||') return Boolean(evaluate(node.left, runtime)) || Boolean(evaluate(node.right, runtime));
      const left = evaluate(node.left, runtime);
      const right = evaluate(node.right, runtime);
      switch (node.op) {
        case '==':
          return left === right;
        case '!=':
          return left !== right;
        case '<':
          return asNumber(left) < asNumber(right);
        case '<=':
          return asNumber(left) <= asNumber(right);
        case '>':
          return asNumber(left) > asNumber(right);
        case '>=':
          return asNumber(left) >= asNumber(right);
        case '+':
          return asNumber(left) + asNumber(right);
        case '-':
          return asNumber(left) - asNumber(right);
        case '*':
          return asNumber(left) * asNumber(right);
        case '/': {
          const divisor = asNumber(right);
          if (divisor === 0) throw new UnsupportedExpression('除以零');
          return asNumber(left) / divisor;
        }
        case '%': {
          const divisor = asNumber(right);
          if (divisor === 0) throw new UnsupportedExpression('除以零');
          return asNumber(left) % divisor;
        }
        default:
          throw new UnsupportedExpression(`不支持的运算符 ${node.op}`);
      }
    }
    case 'ternary':
      return evaluate(node.cond, runtime) ? evaluate(node.then, runtime) : evaluate(node.otherwise, runtime);
    case 'call': {
      if (!KNOWN_FUNCTIONS.has(node.name)) throw new UnsupportedExpression(`不支持的函数 ${node.name}`);
      if (TIME_OR_REQUEST_FUNCTIONS.has(node.name)) {
        throw new UnsupportedExpression(`${node.name}() 需要当前请求时间/头部，estimate 契约未提供`);
      }
      if (node.name === 'tier') {
        if (node.args.length !== 2) throw new UnsupportedExpression('tier 需要两个参数');
        const name = evaluate(node.args[0]!, runtime);
        if (typeof name !== 'string') throw new UnsupportedExpression('tier 名称必须是字符串');
        return evaluate(node.args[1]!, runtime);
      }
      if (node.name === 'fixed') {
        if (node.args.length !== 1) throw new UnsupportedExpression('fixed 需要一个参数');
        return asNumber(evaluate(node.args[0]!, runtime)) * 1_000_000;
      }
      if (node.name === 'param') {
        if (node.args.length !== 1 || node.args[0]!.type !== 'str') {
          throw new UnsupportedExpression('param 只支持字符串字面量');
        }
        const value = readPath(runtime.body, node.args[0]!.value);
        if (value == null) return undefined;
        if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
        throw new UnsupportedExpression('param 返回了非标量');
      }
      const values = node.args.map((arg) => asNumber(evaluate(arg, runtime)));
      switch (node.name) {
        case 'max':
          if (values.length === 0) throw new UnsupportedExpression('max 需要参数');
          return Math.max(...values);
        case 'min':
          if (values.length === 0) throw new UnsupportedExpression('min 需要参数');
          return Math.min(...values);
        case 'abs':
          return Math.abs(asNumber(values[0]));
        case 'ceil':
          return Math.ceil(asNumber(values[0]));
        case 'floor':
          return Math.floor(asNumber(values[0]));
        default:
          throw new UnsupportedExpression(`不支持的函数 ${node.name}`);
      }
    }
  }
}

export function parseBillingExpression(expression: string): ExprNode {
  return new Parser(tokenize(expression)).parse();
}

/**
 * 计算 New API 表达式对应的 USD 金额。表达式系数按上游约定是 $/1M token，
 * fixed(n) 在上游内部放大 1e6，因此统一除以 1e6 得到美元。
 * 无法可靠计算时返回 null，绝不退化成猜测的单价。
 */
export function evaluateBillingExpression(
  expression: string,
  usage: Usage,
  body: Record<string, unknown> = {},
): number | null {
  try {
    const ast = parseBillingExpression(expression);
    const state: Inspection = { vars: new Set(), functions: new Set() };
    inspect(ast, state);
    for (const fn of state.functions) {
      if (TIME_OR_REQUEST_FUNCTIONS.has(fn)) return null;
    }
    for (const name of state.vars) {
      if (UNAVAILABLE_VARS.has(name)) return null;
      if (!SUPPORTED_VARS.has(name)) return null;
    }

    const usesCacheRead = state.vars.has('cr');
    const usesCacheWrite = state.vars.has('cc') || state.vars.has('cc1h') || state.vars.has('cc12h');
    if ((state.vars.has('cc1h') || state.vars.has('cc12h')) && usage.cacheWrite > 0) return null;

    const input = Number(usage.input) || 0;
    const output = Number(usage.output) || 0;
    const cacheRead = Number(usage.cacheRead) || 0;
    const cacheWrite = Number(usage.cacheWrite) || 0;
    const p = Math.max(input - (usesCacheRead ? cacheRead : 0) - (usesCacheWrite ? cacheWrite : 0), 0);

    const value = evaluate(ast, {
      body,
      vars: {
        p,
        c: output,
        cr: cacheRead,
        cc: cacheWrite,
        cc1h: state.vars.has('cc1h') ? 0 : cacheWrite,
        cc12h: state.vars.has('cc12h') ? 0 : cacheWrite,
        len: input,
      },
    });
    const amount = asNumber(value) / 1_000_000;
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  } catch {
    return null;
  }
}
