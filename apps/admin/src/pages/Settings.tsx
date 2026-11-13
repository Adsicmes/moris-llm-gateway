import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useApi } from '../auth';
import type { Settings } from '../types';
import { describeError } from '../lib/api';
import { formatMs } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import {
  Button,
  Card,
  ErrorState,
  Field,
  FormActions,
  FormGrid,
  focusFirstInvalid,
  Icon,
  InlineNote,
  Input,
  LoadingBlock,
  PageHeader,
  Textarea,
  useToast,
} from '../ui';

interface Draft {
  catalogRefresh: string;
  monitorRefresh: string;
  catalogTtl: string;
  balanceStale: string;
  maxAttempts: string;
  connectTimeout: string;
  firstEventTimeout: string;
  idleTimeout: string;
  requestTimeout: string;
  usdCny: string;
  minEstimateRatio: string;
}

interface FallbackRow {
  id: number;
  modelId: string;
  targets: string;
}

const DURATION_FIELDS: Array<{ key: keyof Draft; setting: keyof Settings; label: string; hint: string; max: number }> = [
  { key: 'catalogRefresh', setting: 'catalogRefreshMs', label: '目录刷新间隔（秒）', hint: '服务端模型目录、分组与价格的默认刷新周期。', max: 86_400 },
  { key: 'monitorRefresh', setting: 'monitorRefreshMs', label: '余额与窗口刷新（秒）', hint: '供应商余额与订阅窗口的默认刷新周期。', max: 86_400 },
  { key: 'catalogTtl', setting: 'catalogTtlMs', label: '目录缓存有效期（秒）', hint: '最后一次完整成功同步起计算；过期后暂停受影响模型的新请求。', max: 604_800 },
  { key: 'balanceStale', setting: 'balanceStaleMs', label: '余额过期阈值（秒）', hint: '超过该时间未更新只标记过期，不因此停止模型调用。', max: 86_400 },
  { key: 'connectTimeout', setting: 'connectTimeoutMs', label: '连接上游超时（秒）', hint: '建立上游连接的期限。', max: 120 },
  { key: 'firstEventTimeout', setting: 'firstEventTimeoutMs', label: '首个事件超时（秒）', hint: '等待上游首个响应事件的期限。', max: 3_600 },
  { key: 'idleTimeout', setting: 'idleTimeoutMs', label: '流式空闲超时（秒）', hint: '流式响应无事件的最大间隔。', max: 3_600 },
  { key: 'requestTimeout', setting: 'requestTimeoutMs', label: '整次生成总期限（秒）', hint: '包含全部重试与回退的整体期限。', max: 3_600 },
];

function draftFromSettings(settings: Settings): Draft {
  return {
    catalogRefresh: String(settings.catalogRefreshMs / 1000),
    monitorRefresh: String(settings.monitorRefreshMs / 1000),
    catalogTtl: String(settings.catalogTtlMs / 1000),
    balanceStale: String(settings.balanceStaleMs / 1000),
    maxAttempts: String(settings.maxAttempts),
    connectTimeout: String(settings.connectTimeoutMs / 1000),
    firstEventTimeout: String(settings.firstEventTimeoutMs / 1000),
    idleTimeout: String(settings.idleTimeoutMs / 1000),
    requestTimeout: String(settings.requestTimeoutMs / 1000),
    usdCny: settings.usdCny === null ? '' : String(settings.usdCny),
    minEstimateRatio: String(settings.minEstimateRatio * 100),
  };
}

function fallbackRowsFromSettings(settings: Settings): FallbackRow[] {
  const entries = Object.entries(settings.fallback);
  if (entries.length === 0) return [{ id: 1, modelId: '', targets: '' }];
  return entries.map(([modelId, targets], index) => ({
    id: index + 1,
    modelId,
    targets: targets.join(', '),
  }));
}

function parseTargets(value: string): string[] {
  return value
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function SettingsPage() {
  const api = useApi();
  const toast = useToast();
  const settingsQuery = useAsync((signal) => api<Settings>('/api/admin/settings', { signal }), []);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState<Draft | null>(null);
  const [fallbackRows, setFallbackRows] = useState<FallbackRow[]>([]);
  const [fallbackBaseline, setFallbackBaseline] = useState<FallbackRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nextRowId = useRef(2);

  useEffect(() => {
    if (!settingsQuery.data) return;
    const nextDraft = draftFromSettings(settingsQuery.data);
    const rows = fallbackRowsFromSettings(settingsQuery.data);
    setSettings(settingsQuery.data);
    setDraft(nextDraft);
    setBaseline(nextDraft);
    setFallbackRows(rows);
    setFallbackBaseline(rows);
    nextRowId.current = Math.max(...rows.map((row) => row.id), 1) + 1;
  }, [settingsQuery.data]);

  const dirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return (
      JSON.stringify(draft) !== JSON.stringify(baseline) ||
      JSON.stringify(fallbackRows.map((row) => [row.modelId.trim(), row.targets.trim()])) !==
        JSON.stringify(fallbackBaseline.map((row) => [row.modelId.trim(), row.targets.trim()]))
    );
  }, [draft, baseline, fallbackRows, fallbackBaseline]);

  const update = (key: keyof Draft, value: string) => {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  };

  const updateFallback = (id: number, patch: Partial<FallbackRow>) => {
    setFallbackRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const addFallback = () => {
    setFallbackRows((current) => [...current, { id: nextRowId.current++, modelId: '', targets: '' }]);
  };

  const removeFallback = (id: number) => {
    setFallbackRows((current) =>
      current.length === 1 ? [{ id: nextRowId.current++, modelId: '', targets: '' }] : current.filter((row) => row.id !== id),
    );
  };

  const reset = () => {
    if (!baseline) return;
    setDraft(baseline);
    setFallbackRows(fallbackBaseline);
    setErrors({});
    setFormError(null);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft || !settings || !baseline) return;
    const nextErrors: Record<string, string> = {};

    const durationMs: Partial<Record<keyof Settings, number>> = {};
    for (const field of DURATION_FIELDS) {
      const raw = draft[field.key];
      const value = Number(raw);
      if (!raw.trim() || !Number.isFinite(value) || value <= 0) {
        nextErrors[field.key] = '填写大于 0 的秒数。';
      } else if (value > field.max) {
        nextErrors[field.key] = `不能超过 ${field.max} 秒（约 ${formatMs(field.max * 1000)}）。`;
      } else {
        durationMs[field.setting] = Math.round(value * 1000);
      }
    }

    const maxAttempts = Number(draft.maxAttempts);
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      nextErrors.maxAttempts = '最大尝试次数必须是 1 到 10 的整数。';
    }

    const usdCnyRaw = draft.usdCny.trim();
    const usdCny = usdCnyRaw === '' ? null : Number(usdCnyRaw);
    if (usdCny !== null && (!Number.isFinite(usdCny) || usdCny <= 0 || usdCny > 10_000)) {
      nextErrors.usdCny = '汇率必须是大于 0 且不超过 10000 的数字；留空表示不配置，不猜测换算。';
    }

    const ratioPercent = Number(draft.minEstimateRatio);
    if (!Number.isFinite(ratioPercent) || ratioPercent < 0.1 || ratioPercent > 100) {
      nextErrors.minEstimateRatio = '最小估算比例必须在 0.1 到 100 之间（对应 0.001–1）。';
    }

    const fallback: Record<string, string[]> = {};
    for (const row of fallbackRows) {
      const modelId = row.modelId.trim();
      const targets = parseTargets(row.targets);
      if (!modelId && targets.length === 0) continue;
      if (!modelId) {
        nextErrors[`fallback.${row.id}`] = '填写需要回退的业务模型 ID。';
        continue;
      }
      if (targets.length === 0) {
        nextErrors[`fallback.${row.id}`] = '至少填写一个有顺序的 fallback 目标。';
        continue;
      }
      if (targets.length > 20) {
        nextErrors[`fallback.${row.id}`] = '一条回退规则最多 20 个目标。';
        continue;
      }
      if (fallback[modelId]) {
        nextErrors[`fallback.${row.id}`] = '同一个模型只能配置一条回退列表。';
        continue;
      }
      fallback[modelId] = targets;
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstInvalid();
      setFormError('请修正标记的字段后再保存。');
      return;
    }
    setFormError(null);

    const patch: Partial<Settings> = {};
    for (const field of DURATION_FIELDS) {
      const value = durationMs[field.setting];
      if (value === undefined) continue;
      if (value !== settings[field.setting]) {
        (patch as Record<string, unknown>)[field.setting] = value;
      }
    }
    if (maxAttempts !== settings.maxAttempts) patch.maxAttempts = maxAttempts;
    if (usdCny !== settings.usdCny) patch.usdCny = usdCny;
    if (ratioPercent / 100 !== settings.minEstimateRatio) patch.minEstimateRatio = ratioPercent / 100;
    if (JSON.stringify(fallback) !== JSON.stringify(settings.fallback)) patch.fallback = fallback;

    if (Object.keys(patch).length === 0) {
      toast.push('没有需要保存的修改。', 'info');
      return;
    }

    setBusy(true);
    try {
      const updated = await api<Settings>('/api/admin/settings', { method: 'PATCH', body: patch });
      const nextDraft = draftFromSettings(updated);
      const nextRows = fallbackRowsFromSettings(updated);
      setSettings(updated);
      setDraft(nextDraft);
      setBaseline(nextDraft);
      setFallbackRows(nextRows);
      setFallbackBaseline(nextRows);
      nextRowId.current = Math.max(...nextRows.map((row) => row.id), 1) + 1;
      toast.push('设置已保存，新配置用于后续请求。');
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  if (settingsQuery.error) {
    return (
      <div className="page">
        <PageHeader title="设置" />
        <ErrorState error={settingsQuery.error} onRetry={settingsQuery.reload} />
      </div>
    );
  }

  if (!draft || !settings) {
    return (
      <div className="page">
        <PageHeader title="设置" />
        <LoadingBlock label="正在读取网关设置" />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="设置"
        description="刷新周期、超时、重试上限、汇率与手动回退。修改只影响后续请求；历史快照与账单不重算。"
        actions={
          <Button icon="refresh" onClick={settingsQuery.reload} loading={settingsQuery.refreshing} disabled={dirty}>
            重新读取
          </Button>
        }
      />

      <form onSubmit={save} noValidate>
        <div className="form-layout">
          <div className="form-layout__main">
            <Card title="刷新与缓存">
              <p className="card-lead">
                目录与余额的刷新是服务端定时任务；余额超过过期阈值只标记过期，不停止调用。缓存超过 24 小时未成功刷新时，受影响模型暂停新请求。
              </p>
              <FormGrid>
                {DURATION_FIELDS.slice(0, 4).map((field) => (
                  <Field
                    key={field.key}
                    label={field.label}
                    id={`setting-${field.key}`}
                    error={errors[field.key]}
                    hint={`${field.hint} 当前约 ${formatMs(settings[field.setting] as number)}。`}
                  >
                    <Input
                      id={`setting-${field.key}`}
                      type="number"
                      min="1"
                      max={field.max}
                      step="1"
                      value={draft[field.key]}
                      onChange={(event) => update(field.key, event.target.value)}
                      className="mono"
                      aria-invalid={Boolean(errors[field.key])}
                    />
                  </Field>
                ))}
              </FormGrid>
            </Card>

            <Card title="超时与重试">
              <InlineNote>
                只有连接失败/超时、429、502/503/504 可触发有限重试。参数错误、上下文超限与认证失败不会盲目换模型；跨供应商或分组回退只按下方手动列表执行。
              </InlineNote>
              <FormGrid>
                <Field label="最大尝试次数" id="setting-max-attempts" error={errors.maxAttempts} hint="每次逻辑模型生成的上游尝试上限，包含首次、同目标重试与跨目标回退。">
                  <Input
                    id="setting-max-attempts"
                    type="number"
                    min="1"
                    max="10"
                    step="1"
                    value={draft.maxAttempts}
                    onChange={(event) => update('maxAttempts', event.target.value)}
                    className="mono"
                    aria-invalid={Boolean(errors.maxAttempts)}
                  />
                </Field>
                {DURATION_FIELDS.slice(4).map((field) => (
                  <Field
                    key={field.key}
                    label={field.label}
                    id={`setting-${field.key}`}
                    error={errors[field.key]}
                    hint={`${field.hint} 当前约 ${formatMs(settings[field.setting] as number)}。`}
                  >
                    <Input
                      id={`setting-${field.key}`}
                      type="number"
                      min="1"
                      max={field.max}
                      step="1"
                      value={draft[field.key]}
                      onChange={(event) => update(field.key, event.target.value)}
                      className="mono"
                      aria-invalid={Boolean(errors[field.key])}
                    />
                  </Field>
                ))}
              </FormGrid>
            </Card>

            <Card title="汇率与估算">
              <FormGrid>
                <Field
                  label="USD → CNY 汇率"
                  id="setting-rate"
                  error={errors.usdCny}
                  hint="1 USD 对应多少 CNY。留空表示未配置，只显示原币，不猜测换算。新汇率只影响后续请求。"
                >
                  <Input
                    id="setting-rate"
                    type="number"
                    min="0"
                    max="10000"
                    step="0.0001"
                    value={draft.usdCny}
                    onChange={(event) => update('usdCny', event.target.value)}
                    placeholder="留空表示不配置"
                    className="mono"
                    aria-invalid={Boolean(errors.usdCny)}
                  />
                </Field>
                <Field
                  label="最小估算比例（%）"
                  id="setting-ratio"
                  error={errors.minEstimateRatio}
                  hint="上游窗口已用比例低于该值时，不输出总额与剩余额度估算。允许 0.1%–100%，默认 5%。"
                >
                  <Input
                    id="setting-ratio"
                    type="number"
                    min="0.1"
                    max="100"
                    step="0.1"
                    value={draft.minEstimateRatio}
                    onChange={(event) => update('minEstimateRatio', event.target.value)}
                    className="mono"
                    aria-invalid={Boolean(errors.minEstimateRatio)}
                  />
                </Field>
              </FormGrid>
              <p className="quiet-note">
                当前统计时区固定为 {settings.timezone}，底层时间戳按 UTC 存储。汇率变化不会重算已有实付人民币账单。
              </p>
            </Card>

            <Card title="手动回退">
              <p className="card-lead">
                默认不跨供应商或分组回退。这里为指定业务模型配置有顺序的目标列表；只有允许重试的错误才会进入回退。
              </p>
              <div className="fallback-list">
                {fallbackRows.map((row, index) => (
                  <div className="fallback-row" key={row.id}>
                    <span className="fallback-row__index" aria-hidden="true">
                      {index + 1}
                    </span>
                    <div className="fallback-row__fields">
                      <Field label="业务模型 ID" id={`fallback-model-${row.id}`}>
                        <Input
                          id={`fallback-model-${row.id}`}
                          value={row.modelId}
                          onChange={(event) => updateFallback(row.id, { modelId: event.target.value })}
                          placeholder="deepseek/deepseek-flash"
                          className="mono"
                        />
                      </Field>
                      <Field
                        label="回退目标（按顺序）"
                        id={`fallback-targets-${row.id}`}
                        error={errors[`fallback.${row.id}`]}
                        hint="用逗号或换行分隔。目标可以是同一模型路径的备用供应商/分组。"
                      >
                        <Textarea
                          id={`fallback-targets-${row.id}`}
                          value={row.targets}
                          onChange={(event) => updateFallback(row.id, { targets: event.target.value })}
                          rows={2}
                          placeholder="openai/gpt-6.1-sol, realseek/group-n/gpt-6.1-terra"
                          className="mono"
                          aria-invalid={Boolean(errors[`fallback.${row.id}`])}
                        />
                      </Field>
                    </div>
                    <Button variant="ghost" size="sm" onClick={() => removeFallback(row.id)} aria-label={`移除第 ${index + 1} 条回退规则`}>
                      移除
                    </Button>
                  </div>
                ))}
              </div>
              <Button variant="secondary" size="sm" icon="plus" onClick={addFallback}>
                添加回退规则
              </Button>
            </Card>
          </div>

          <aside className="form-layout__side">
            <Card title="当前生效">
              <dl className="meta-list">
                <div>
                  <dt>目录刷新</dt>
                  <dd>{formatMs(settings.catalogRefreshMs)}</dd>
                </div>
                <div>
                  <dt>余额刷新</dt>
                  <dd>{formatMs(settings.monitorRefreshMs)}</dd>
                </div>
                <div>
                  <dt>目录有效期</dt>
                  <dd>{formatMs(settings.catalogTtlMs)}</dd>
                </div>
                <div>
                  <dt>最大尝试</dt>
                  <dd>{settings.maxAttempts} 次</dd>
                </div>
                <div>
                  <dt>汇率</dt>
                  <dd>{settings.usdCny === null ? '未配置' : `1 USD = ${settings.usdCny} CNY`}</dd>
                </div>
                <div>
                  <dt>估算比例下限</dt>
                  <dd>{(settings.minEstimateRatio * 100).toFixed(1)}%</dd>
                </div>
                <div>
                  <dt>时区</dt>
                  <dd>{settings.timezone}</dd>
                </div>
              </dl>
            </Card>
            <Card title="保存规则">
              <ul className="check-list">
                <li>只提交发生变化的字段。</li>
                <li>新汇率只对后续请求折算。</li>
                <li>账单实付永不因汇率更新而重算。</li>
                <li>回退顺序即尝试顺序，不能跨出配置列表。</li>
              </ul>
            </Card>
            {dirty ? (
              <div className="dirty-note">
                <Icon name="alert" size={16} />
                有未保存的修改。
              </div>
            ) : null}
          </aside>
        </div>

        {formError ? (
          <div className="notice notice--bad" role="alert">
            <Icon name="alert" size={18} />
            <div>
              <strong>没有保存</strong>
              <p>{formError}</p>
            </div>
          </div>
        ) : null}

        <FormActions>
          <Button variant="secondary" onClick={reset} disabled={!dirty || busy}>
            撤销修改
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>
            保存设置
          </Button>
        </FormActions>
      </form>
    </div>
  );
}
