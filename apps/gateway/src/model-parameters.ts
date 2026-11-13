import { z } from 'zod';
import type { CatalogModel, ModelParameterOverrides } from '../../../packages/contracts/src/index.js';

const tokens = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const modelParametersSchema = z.object({
  context: tokens.optional(), output: tokens.optional(), input: tokens.optional(),
  tools: z.boolean().optional(), reasoning: z.boolean().optional(), imageInput: z.boolean().optional(),
  name: z.string().trim().min(1).max(200).optional(), family: z.string().trim().min(1).max(100).optional(),
}).strict();

/** 在读取时合并，数据库目录仍保存自动快照；编辑不刷新目录 TTL。 */
export function resolveModelParameters(automatic: CatalogModel, overrides: ModelParameterOverrides): CatalogModel {
  const limit = { ...automatic.limit };
  for (const field of ['context', 'output', 'input'] as const) if (overrides[field] !== undefined) limit[field] = overrides[field]!;
  const capabilities = { ...automatic.capabilities, input: [...automatic.capabilities.input] };
  if (overrides.tools !== undefined) capabilities.tools = overrides.tools;
  if (overrides.reasoning !== undefined) capabilities.reasoning = overrides.reasoning;
  if (overrides.imageInput !== undefined) capabilities.input = overrides.imageInput
    ? Array.from(new Set([...capabilities.input, 'image' as const])) : capabilities.input.filter(value => value !== 'image');
  const unknownParameters = automatic.unknownParameters?.filter(field => overrides[field] === undefined);
  const family = overrides.family ?? automatic.family;
  const reasons: string[] = [];
  if (!Number.isSafeInteger(limit.context) || (limit.context ?? 0) <= 0) reasons.push('上下文长度未知或无效');
  if (!Number.isSafeInteger(limit.output) || (limit.output ?? 0) <= 0) reasons.push('最大输出未知或无效');
  if (unknownParameters?.includes('tools')) reasons.push('工具能力未知');
  if (!family) reasons.push('模型家族未知');
  if (limit.context != null && limit.output != null && limit.output > limit.context) reasons.push('最大输出超过上下文');
  if (limit.input != null && (!Number.isSafeInteger(limit.input) || limit.input <= 0 || (limit.context != null && limit.input > limit.context))) reasons.push('输入上限无效或超过上下文');
  const available = automatic.available ?? automatic.enabled;
  const enabled = available && reasons.length === 0;
  const sources = { ...automatic.sources };
  for (const field of Object.keys(overrides)) sources[`override.${field}`] = '管理员手工覆盖';
  return { ...automatic, name: overrides.name ?? automatic.name, family, capabilities, limit, unknownParameters, sources, enabled,
    disabledReason: !available ? automatic.disabledReason ?? '上游模型不可用' : reasons.length ? reasons.join('；') : undefined };
}
