import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApi } from '../auth';
import type { CatalogModel, ModelParameterOverrides, ModelParameterState } from '../lib/contracts';
import { describeError } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { Button, ErrorState, Field, FormActions, FormGrid, InlineNote, Input, Select, SkeletonRows, focusFirstInvalid } from '../ui';

const fields = [
  ['context', '上下文长度', 'number'], ['input', '输入上限', 'number'], ['output', '最大输出', 'number'],
  ['tools', '工具调用', 'boolean'], ['reasoning', '推理能力', 'boolean'], ['imageInput', '图片输入', 'boolean'],
  ['name', '显示名称', 'text'], ['family', '模型家族', 'text'],
] as const;
type Key = typeof fields[number][0];
type Draft = Record<Key, string>;

function draftOf(overrides: ModelParameterOverrides): Draft {
  return Object.fromEntries(fields.map(([key]) => [key, overrides[key] === undefined ? '' : String(overrides[key])])) as Draft;
}
function automaticValue(model: CatalogModel, key: Key): string {
  if (key === 'context' || key === 'input' || key === 'output') return model.limit[key]?.toLocaleString('zh-CN') ?? '未知';
  if (key === 'name' || key === 'family') return model[key] || '未知';
  if (model.unknownParameters?.includes(key)) return '未知';
  const value = key === 'imageInput' ? model.capabilities.input.includes('image') : model.capabilities[key];
  return value === undefined ? '未知' : value ? '支持' : '不支持';
}

function ParameterForm({
  initial,
  onSaved,
  onDirtyChange,
}: {
  initial: ModelParameterState;
  onSaved: (model: CatalogModel) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const api = useApi();
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState(() => draftOf(initial.overrides));
  const [errors, setErrors] = useState<Partial<Record<Key, string>>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const endpoint = `/api/admin/models/${encodeURIComponent(state.automatic.id)}/parameters`;
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(state.overrides));
  const dirtyChangeRef = useRef(onDirtyChange);
  dirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    dirtyChangeRef.current?.(dirty);
  }, [dirty]);

  useEffect(() => () => dirtyChangeRef.current?.(false), []);

  async function save(overrides: ModelParameterOverrides) {
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api<ModelParameterState>(endpoint, { method: 'PATCH', body: { overrides, revision: state.revision } });
      setState(next); setDraft(draftOf(next.overrides)); setErrors({});
      setNotice(Object.keys(overrides).length ? '参数已保存并生效。' : '已恢复自动参数。');
      onSaved(next.effective);
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const next: ModelParameterOverrides = {};
    const invalid: Partial<Record<Key, string>> = {};
    for (const [key, , type] of fields) {
      if (type === 'number' && event.currentTarget.querySelector<HTMLInputElement>(`#parameter-${key}`)?.validity.badInput) {
        invalid[key] = '请输入有效的正整数，或清空以恢复自动值。';
        continue;
      }
      const value = draft[key].trim();
      if (!value) continue;
      if (type === 'number') {
        const number = Number(value);
        if (!Number.isSafeInteger(number) || number <= 0) invalid[key] = '请输入大于 0 的安全整数。';
        else next[key] = number;
      } else if (type === 'boolean') next[key] = value === 'true';
      else if (value.length > (key === 'name' ? 200 : 100)) invalid[key] = '文字过长，请缩短。';
      else next[key] = value;
    }
    const context = next.context ?? state.automatic.limit.context;
    for (const key of ['input', 'output'] as const) {
      const value = next[key] ?? state.automatic.limit[key];
      if (context != null && value != null && value > context) invalid[key] = '不能超过上下文长度；也可调整上下文。';
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) { focusFirstInvalid(); return; }
    void save(next);
  }
  async function reload() {
    if (dirty && !window.confirm('重新读取会放弃未保存的参数修改。确定继续吗？')) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const next = await api<ModelParameterState>(endpoint);
      setState(next); setDraft(draftOf(next.overrides)); setErrors({}); onSaved(next.effective);
    } catch (cause) { setError(describeError(cause)); }
    finally { setBusy(false); }
  }
  return <form className="detail-stack model-parameter-form" onSubmit={submit} noValidate aria-label="模型参数编辑">
    <div>
      <h3>参数编辑</h3>
      <p className="quiet-note">仅作用于当前供应商、分组和模型。留空或选择“自动”恢复自动值；同步会保留手工覆盖。公开参数是原厂参考，分组实际限制可能不同。</p>
    </div>
    <FormGrid>
      {fields.map(([key, label, type]) => {
        const id = `parameter-${key}`;
        const hint = `自动值：${automaticValue(state.automatic, key)}${state.overrides[key] !== undefined ? ' · 已保存手工覆盖' : ''}`;
        return <Field key={key} id={id} label={label} hint={hint} error={errors[key]}>
          {type === 'boolean' ? <Select id={id} value={draft[key]} disabled={busy} aria-describedby={`${id}-hint`}
            onChange={event => { setDraft({ ...draft, [key]: event.target.value }); setNotice(''); }}>
            <option value="">自动</option><option value="true">支持</option><option value="false">不支持</option>
          </Select> : <Input id={id} type={type} min={type === 'number' ? 1 : undefined} step={type === 'number' ? 1 : undefined}
            value={draft[key]} disabled={busy} placeholder="自动" aria-invalid={!!errors[key]} aria-describedby={`${id}-${errors[key] ? 'error' : 'hint'}`}
            onChange={event => { setDraft({ ...draft, [key]: event.target.value }); setNotice(''); }} />}
        </Field>;
      })}
    </FormGrid>
    <p className="quiet-note break">自动来源：{state.automatic.sources?.models || state.automatic.sources?.catalog || '见下方来源记录'}</p>
    {error ? <div role="alert"><InlineNote tone="warn">{error}</InlineNote></div> : null}
    <div role="status">{notice}</div>
    <FormActions>
      <Button type="button" disabled={busy || (!dirty && !Object.keys(state.overrides).length)} onClick={() => {
        if (dirty && !window.confirm('当前有未保存的修改，恢复全部自动值会清空这些修改。确定继续吗？')) return;
        setDraft(draftOf({})); setErrors({}); setError(''); setNotice('已清空表单中的覆盖值；点击“保存参数”后恢复自动值。');
      }}>恢复全部自动值</Button>
      <Button type="button" disabled={busy} onClick={() => { void reload(); }}>重新读取参数</Button>
      <Button type="submit" variant="primary" loading={busy} disabled={!dirty}>保存参数</Button>
    </FormActions>
    <p className="quiet-note">重新读取会放弃未保存修改。参数覆盖不会恢复上游已删除、无权限或目录已过期的模型。</p>
  </form>;
}

export function ModelParameters({
  modelId,
  onSaved,
  onDirtyChange,
}: {
  modelId: string;
  onSaved: (model: CatalogModel) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const api = useApi();
  const state = useAsync(signal => api<ModelParameterState>(`/api/admin/models/${encodeURIComponent(modelId)}/parameters`, { signal }), [modelId]);
  if (state.error) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!state.data) return <SkeletonRows rows={3} />;
  return <ParameterForm key={modelId} initial={state.data} onSaved={onSaved} onDirtyChange={onDirtyChange} />;
}
