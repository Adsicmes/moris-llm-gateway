import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApi } from '../auth';
import type { PluginsResponse, ProviderAccount, ProviderInput, ProvidersResponse } from '../types';
import type { BillingType, TokenTemplate } from '../lib/contracts';
import { describeError } from '../lib/api';
import { prettyJson, formatDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Link, navigate } from '../router';
import { OpenAIProviderAuth } from './OpenAIProviderAuth';
import {
  Button,
  Card,
  Checkbox,
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
  Select,
  Textarea,
  useToast,
} from '../ui';

type Mode = 'new' | 'edit';

interface SecretRow {
  id: number;
  key: string;
  value: string;
  remove: boolean;
}

interface TokenDraft {
  name: string;
  quota: string;
  expires: string;
  unlimited: boolean;
}

const EMPTY_TOKEN: TokenDraft = { name: '', quota: '', expires: '', unlimited: false };

function parseOptions(text: string): { value?: Record<string, unknown>; error?: string } {
  if (!text.trim()) return { value: {} };
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'options 必须是 JSON 对象，例如 {"region":"global"}。' };
    }
    return { value: parsed as Record<string, unknown> };
  } catch (error) {
    return { error: `JSON 解析失败：${error instanceof Error ? error.message : '格式无效'}` };
  }
}

export function ProviderEditPage({ mode, id }: { mode: Mode; id?: string }) {
  const api = useApi();
  const toast = useToast();
  const providers = useAsync(
    (signal) => (mode === 'edit' ? api<ProvidersResponse>('/api/admin/providers', { signal }) : Promise.resolve<ProvidersResponse>({ items: [] })),
    [mode],
  );
  const plugins = useAsync((signal) => api<PluginsResponse>('/api/admin/plugins', { signal }), []);

  const [namespace, setNamespace] = useState('');
  const [name, setName] = useState('');
  const [plugin, setPlugin] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [billingType, setBillingType] = useState<BillingType>('metered');
  const [enabled, setEnabled] = useState(true);
  const [proxyUrl, setProxyUrl] = useState('');
  const [autoCreateTokens, setAutoCreateTokens] = useState(false);
  const [token, setToken] = useState<TokenDraft>(EMPTY_TOKEN);
  const [optionsText, setOptionsText] = useState('{}');
  const [secretRows, setSecretRows] = useState<SecretRow[]>([{ id: 1, key: '', value: '', remove: false }]);
  const nextSecretId = useRef(2);
  const [original, setOriginal] = useState<ProviderAccount | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [initialized, setInitialized] = useState(mode === 'new');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'edit' || initialized) return;
    if (!providers.data) return;
    const found = providers.data.items.find((item) => item.id === id) ?? null;
    if (!found) {
      setNotFound(true);
      setInitialized(true);
      return;
    }
    setOriginal(found);
    setNamespace(found.namespace);
    setName(found.name);
    setPlugin(found.plugin);
    setBaseUrl(found.baseUrl);
    setBillingType(found.billingType);
    setEnabled(found.enabled);
    setProxyUrl(found.proxyUrl ?? '');
    setAutoCreateTokens(found.autoCreateTokens);
    setToken(
      found.tokenTemplate
        ? {
            name: found.tokenTemplate.namePrefix,
            quota: String(found.tokenTemplate.quota),
            expires: String(found.tokenTemplate.expiresInDays),
            unlimited: Boolean(found.tokenTemplate.unlimited),
          }
        : EMPTY_TOKEN,
    );
    setOptionsText(prettyJson(found.options ?? {}));
    setInitialized(true);
  }, [mode, initialized, providers.data, id]);

  const pluginList = plugins.data?.items ?? [];
  const pluginMissing = plugin !== '' && !pluginList.some((item) => item.id === plugin);

  const addSecret = () => {
    setSecretRows((current) => [...current, { id: nextSecretId.current++, key: '', value: '', remove: false }]);
  };

  const updateSecret = (rowId: number, patch: Partial<SecretRow>) => {
    setSecretRows((current) => current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)));
  };

  const removeSecretRow = (rowId: number) => {
    setSecretRows((current) => (current.length === 1 ? [{ id: nextSecretId.current++, key: '', value: '', remove: false }] : current.filter((row) => row.id !== rowId)));
  };

  const validate = (): { input?: ProviderInput } => {
    const nextErrors: Record<string, string> = {};
    if (!namespace.trim()) {
      nextErrors.namespace = '填写命名空间，它决定业务模型 ID 的第一段。';
    } else if (!/^[a-z][a-z0-9-]{0,63}$/.test(namespace.trim())) {
      nextErrors.namespace = '命名空间需以小写字母开头，只含小写字母、数字和连字符，最长 64 个字符。';
    }
    if (!name.trim()) nextErrors.name = '填写一个可辨认的供应商名称。';
    else if (name.trim().length > 100) nextErrors.name = '供应商名称最多 100 个字符。';
    if (!plugin.trim()) nextErrors.plugin = '选择或填写插件 ID。';
    if (!baseUrl.trim()) {
      nextErrors.baseUrl = '填写上游 base URL。';
    } else {
      try {
        const url = new URL(baseUrl.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') nextErrors.baseUrl = 'base URL 必须以 http:// 或 https:// 开头。';
        else if (url.username || url.password) nextErrors.baseUrl = 'base URL 不能包含用户名或密码；凭据请放在密钥中。';
      } catch {
        nextErrors.baseUrl = 'base URL 不是合法地址。';
      }
    }

    if (proxyUrl.trim()) {
      try {
        const url = new URL(proxyUrl.trim());
        if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(url.protocol)) {
          nextErrors.proxyUrl = '代理地址需使用 http、https、socks5 或 socks5h 协议。';
        }
      } catch {
        nextErrors.proxyUrl = '代理地址不是合法 URL；留空表示直连。';
      }
    }

    const options = parseOptions(optionsText);
    if (options.error) nextErrors.options = options.error;

    let template: TokenTemplate | undefined;
    const tokenQuota = token.unlimited && !token.quota.trim() ? '0' : token.quota;
    const tokenExpires = token.expires;
    const quotaNumber = Number(tokenQuota);
    const expiresNumber = Number(tokenExpires);
    const hasTemplate = Boolean(token.name.trim() || token.quota.trim() || token.expires.trim() || token.unlimited);

    if (autoCreateTokens) {
      if (!token.name.trim()) nextErrors['token.name'] = '开启自动创建时必须填写令牌名称前缀。';
      else if (token.name.trim().length > 64) nextErrors['token.name'] = '名称前缀最多 64 个字符。';
      if (!token.unlimited && token.quota.trim() === '') nextErrors['token.quota'] = '填写额度，或勾选「不限额」。';
      if (!Number.isFinite(quotaNumber) || quotaNumber < 0) nextErrors['token.quota'] = '额度必须是不小于 0 的数字。';
      if (token.expires.trim() === '') nextErrors['token.expires'] = '填写有效天数。';
      if (!Number.isInteger(expiresNumber) || expiresNumber < 0 || expiresNumber > 3650) {
        nextErrors['token.expires'] = '有效天数必须是 0 到 3650 的整数；0 表示长期有效。';
      }
    }

    if (autoCreateTokens || (hasTemplate && Number.isFinite(quotaNumber) && Number.isFinite(expiresNumber) && token.name.trim())) {
      template = {
        namePrefix: token.name.trim() || 'moris',
        quota: Number.isFinite(quotaNumber) ? quotaNumber : 0,
        expiresInDays: Number.isFinite(expiresNumber) ? expiresNumber : 0,
        unlimited: token.unlimited || undefined,
      };
    }

    const secrets: Record<string, string> = {};
    for (const row of secretRows) {
      const key = row.key.trim();
      if (!key) {
        if (row.value && !row.remove) nextErrors[`secret.${row.id}`] = '填写该密钥的键名。';
        continue;
      }
      if (row.remove) {
        secrets[key] = '';
      } else if (row.value !== '') {
        secrets[key] = row.value;
      }
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      focusFirstInvalid();
      return {};
    }

    const input: ProviderInput = {
      namespace: namespace.trim(),
      name: name.trim(),
      plugin: plugin.trim(),
      baseUrl: baseUrl.trim(),
      billingType,
      enabled,
      autoCreateTokens,
    };
    if (template) input.tokenTemplate = template;
    if (options.value) input.options = options.value;
    if (Object.keys(secrets).length > 0) input.secrets = secrets;

    const trimmedProxy = proxyUrl.trim();
    if (mode === 'new') {
      if (trimmedProxy) input.proxyUrl = trimmedProxy;
    } else if (trimmedProxy !== (original?.proxyUrl ?? '')) {
      // 列表回显的 proxyUrl 已去掉认证信息。只有值确实变化时才提交；
      // 未改动时完全省略该字段，服务端才能保留原有代理认证。
      input.proxyUrl = trimmedProxy;
    }

    return { input };
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const result = validate();
    if (!result.input) {
      setFormError('请修正标记的字段后再保存。');
      return;
    }
    setBusy(true);
    try {
      if (mode === 'new') {
        await api<{ item: ProviderAccount }>('/api/admin/providers', { method: 'POST', body: result.input });
        toast.push('供应商已创建。下一步可以同步目录。');
      } else {
        const patchInput: Partial<ProviderInput> = { ...result.input };
        delete patchInput.namespace;
        delete patchInput.plugin;
        await api<{ item: ProviderAccount }>(`/api/admin/providers/${encodeURIComponent(id ?? '')}`, {
          method: 'PATCH',
          body: patchInput,
        });
        toast.push('供应商配置已保存。');
      }
      navigate('#/providers');
    } catch (error) {
      setFormError(describeError(error));
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'edit' && notFound) {
    return (
      <div className="page">
        <PageHeader title="找不到这个供应商" description="列表里没有这个 ID，可能已被删除或链接有误。" />
        <Link className="btn btn--primary btn--md" to={{ name: 'providers' }}>
          返回供应商列表
        </Link>
      </div>
    );
  }

  if (mode === 'edit' && providers.error && !initialized) {
    return (
      <div className="page">
        <PageHeader title="编辑供应商" />
        <ErrorState error={providers.error} onRetry={providers.reload} />
      </div>
    );
  }

  if (mode === 'edit' && !initialized) {
    return (
      <div className="page">
        <PageHeader title="编辑供应商" />
        <LoadingBlock label="正在读取供应商配置" />
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title={mode === 'new' ? '新增供应商' : `编辑 ${original?.name ?? ''}`}
        description="上游凭据只留在服务端。已有密钥不会回显；不填写的密钥保持原值。"
        actions={
          <Link className="btn btn--secondary btn--md" to={{ name: 'providers' }}>
            <Icon name="arrow-left" size={16} /> 返回列表
          </Link>
        }
      />

      <form onSubmit={submit} noValidate>
        <div className="form-layout">
          <div className="form-layout__main">
            <Card title="基本信息">
              <FormGrid>
                <Field
                  label="供应商名称"
                  id="provider-name"
                  error={errors.name}
                  hint="显示在后台与额度页，不进入模型 ID。"
                >
                  <Input
                    id="provider-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="例如 DeepSeek 官方"
                    maxLength={100}
                    aria-invalid={Boolean(errors.name)}
                    aria-describedby={errors.name ? 'provider-name-error' : undefined}
                  />
                </Field>

                <Field
                  label="命名空间"
                  id="provider-namespace"
                  error={errors.namespace}
                  hint={mode === 'edit' ? '创建后不可修改；业务模型 ID 的第一段。' : '业务模型 ID 的第一段，例如 deepseek。'}
                >
                  <Input
                    id="provider-namespace"
                    value={namespace}
                    onChange={(event) => setNamespace(event.target.value)}
                    placeholder="deepseek"
                    maxLength={64}
                    disabled={mode === 'edit'}
                    className="mono"
                    aria-invalid={Boolean(errors.namespace)}
                    aria-describedby={errors.namespace ? 'provider-namespace-error' : undefined}
                  />
                </Field>

                <Field label="插件" id="provider-plugin" error={errors.plugin} hint="插件读取供应商目录、价格、余额与协议差异。创建后不可修改。">
                  {pluginList.length > 0 ? (
                    <Select
                      id="provider-plugin"
                      value={plugin}
                      onChange={(event) => setPlugin(event.target.value)}
                      disabled={mode === 'edit'}
                      aria-invalid={Boolean(errors.plugin)}
                    >
                      <option value="">选择已安装插件</option>
                      {pluginMissing && plugin ? <option value={plugin}>{plugin}（列表外）</option> : null}
                      {pluginList.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name} · {item.id}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input
                      id="provider-plugin"
                      value={plugin}
                      onChange={(event) => setPlugin(event.target.value)}
                      placeholder="插件 ID"
                      disabled={mode === 'edit'}
                      className="mono"
                      maxLength={100}
                      aria-invalid={Boolean(errors.plugin)}
                    />
                  )}
                </Field>

                <Field label="计费类型" id="provider-billing" hint="订阅与按量的价格口径不同，供应商真实扣费仍需单独对账。">
                  <Select
                    id="provider-billing"
                    value={billingType}
                    onChange={(event) => setBillingType(event.target.value as BillingType)}
                  >
                    <option value="metered">按量计费</option>
                    <option value="subscription">订阅</option>
                  </Select>
                </Field>

                <Field
                  label="Base URL"
                  id="provider-base-url"
                  error={errors.baseUrl}
                  hint="包含协议与主机，例如 https://api.deepseek.com。"
                  className="field--wide"
                >
                  <Input
                    id="provider-base-url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="https://api.example.com"
                    className="mono"
                    aria-invalid={Boolean(errors.baseUrl)}
                    aria-describedby={errors.baseUrl ? 'provider-base-url-error' : undefined}
                  />
                </Field>

                <Field
                  label="网络代理"
                  id="provider-proxy"
                  error={errors.proxyUrl}
                  hint={
                    mode === 'edit'
                      ? '留空并保存将移除代理；未改动时保持服务端原值。代理中的认证信息不会回传。'
                      : '可选。支持 http、https、socks5、socks5h；留空表示直连。'
                  }
                  className="field--wide"
                >
                  <Input
                    id="provider-proxy"
                    value={proxyUrl}
                    onChange={(event) => setProxyUrl(event.target.value)}
                    placeholder="不填则直连"
                    className="mono"
                    aria-invalid={Boolean(errors.proxyUrl)}
                    aria-describedby={errors.proxyUrl ? 'provider-proxy-error' : undefined}
                  />
                </Field>
              </FormGrid>

              {pluginList.length === 0 && !plugins.error ? (
                <p className="small muted form-note">服务端尚未报告已安装插件；可直接填写插件 ID，或先在服务端安装插件包。</p>
              ) : null}
              {plugins.error ? (
                <p className="small muted form-note">插件列表读取失败：{describeError(plugins.error)}。仍可填写插件 ID。</p>
              ) : null}

              <Checkbox
                label="启用这个供应商"
                description="停用后不再调度新请求；历史请求与账目保留。"
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
            </Card>

            {mode === 'edit' && original?.plugin === 'openai-subscription' ? (
              <OpenAIProviderAuth
                key={original.id}
                providerId={original.id}
                providerName={original.name}
                onAuthorized={providers.reload}
                onSynced={providers.reload}
              />
            ) : null}

            <Card title="上游密钥">
              <InlineNote>
                已保存的密钥不会从接口返回。这里只提交新增或替换的键；把「删除」勾上并保存，会向服务端发送空字符串以删除该键。
              </InlineNote>
              <div className="secret-list">
                {secretRows.map((row) => (
                  <div className="secret-row" key={row.id}>
                    <div className="field">
                      <label htmlFor={`secret-key-${row.id}`}>键名</label>
                      <Input
                        id={`secret-key-${row.id}`}
                        value={row.key}
                        onChange={(event) => updateSecret(row.id, { key: event.target.value })}
                        placeholder="apiKey"
                        className="mono"
                        disabled={row.remove}
                        autoComplete="off"
                        aria-invalid={Boolean(errors[`secret.${row.id}`])}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`secret-value-${row.id}`}>新值</label>
                      <Input
                        id={`secret-value-${row.id}`}
                        value={row.value}
                        onChange={(event) => updateSecret(row.id, { value: event.target.value })}
                        placeholder={row.remove ? '将删除该键' : '留空表示保持不变'}
                        type="password"
                        className="mono"
                        disabled={row.remove}
                        autoComplete="new-password"
                      />
                    </div>
                    <div className="secret-row__actions">
                      <Checkbox
                        label="删除"
                        checked={row.remove}
                        onChange={(event) => updateSecret(row.id, { remove: event.target.checked })}
                      />
                      <Button variant="ghost" size="sm" onClick={() => removeSecretRow(row.id)} aria-label="移除这一行">
                        移除
                      </Button>
                    </div>
                    {errors[`secret.${row.id}`] ? <p className="field__error">{errors[`secret.${row.id}`]}</p> : null}
                  </div>
                ))}
              </div>
              <Button variant="secondary" size="sm" icon="plus" onClick={addSecret}>
                添加密钥
              </Button>
            </Card>

            <Card title="上游令牌模板">
              <Checkbox
                label="允许自动创建上游令牌"
                description="默认关闭。开启后只按以下模板创建，并优先复用本网关管理的既有令牌；不会修改或删除其他令牌。"
                checked={autoCreateTokens}
                onChange={(event) => setAutoCreateTokens(event.target.checked)}
              />
              <FormGrid>
                <Field label="名称前缀" id="token-name" error={errors['token.name']} hint="用于识别本网关创建的令牌。">
                  <Input
                    id="token-name"
                    value={token.name}
                    onChange={(event) => setToken((current) => ({ ...current, name: event.target.value }))}
                    placeholder="moris-gateway"
                    className="mono"
                    maxLength={64}
                    aria-invalid={Boolean(errors['token.name'])}
                  />
                </Field>
                <Field label="额度" id="token-quota" error={errors['token.quota']} hint="上游令牌额度，按插件原始单位填写。">
                  <Input
                    id="token-quota"
                    type="number"
                    min="0"
                    step="1"
                    value={token.quota}
                    onChange={(event) => setToken((current) => ({ ...current, quota: event.target.value }))}
                    placeholder="0"
                    disabled={token.unlimited}
                    aria-invalid={Boolean(errors['token.quota'])}
                  />
                </Field>
                <Field label="有效天数" id="token-expires" error={errors['token.expires']} hint="0 表示长期有效；也可填写 1–3650 天。">
                  <Input
                    id="token-expires"
                    type="number"
                    min="0"
                    max="3650"
                    step="1"
                    value={token.expires}
                    onChange={(event) => setToken((current) => ({ ...current, expires: event.target.value }))}
                    placeholder="30"
                    aria-invalid={Boolean(errors['token.expires'])}
                  />
                </Field>
                <div className="field field--check">
                  <Checkbox
                    label="不限额"
                    description="勾选后额度按 0 提交；是否支持以插件实测为准。"
                    checked={token.unlimited}
                    onChange={(event) => setToken((current) => ({ ...current, unlimited: event.target.checked }))}
                  />
                </div>
              </FormGrid>
              {autoCreateTokens ? (
                <p className="small muted form-note">模板不完整时不会创建令牌，保存后请补齐前缀、额度与有效期。</p>
              ) : (
                <p className="small muted form-note">自动创建关闭时，不完整模板不会提交；完整模板会保留，供以后开启。</p>
              )}
            </Card>

            <Card title="插件选项">
              <Field
                label="options JSON"
                id="provider-options"
                error={errors.options}
                hint="原样提交给插件的对象。留空等同于 {}。"
              >
                <Textarea
                  id="provider-options"
                  value={optionsText}
                  onChange={(event) => setOptionsText(event.target.value)}
                  rows={7}
                  className="mono"
                  spellCheck={false}
                  aria-invalid={Boolean(errors.options)}
                  aria-describedby={errors.options ? 'provider-options-error' : undefined}
                />
              </Field>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const parsed = parseOptions(optionsText);
                  if (parsed.error) {
                    setErrors((current) => ({ ...current, options: parsed.error ?? '' }));
                  } else {
                    setOptionsText(prettyJson(parsed.value ?? {}));
                    setErrors((current) => {
                      const next = { ...current };
                      delete next.options;
                      return next;
                    });
                  }
                }}
              >
                格式化 JSON
              </Button>
            </Card>
          </div>

          <aside className="form-layout__side">
            <Card title="保存前核对">
              <ul className="check-list">
                <li>命名空间与插件创建后不可修改。</li>
                <li>密钥只提交新增或替换项，列表接口不会回传秘密。</li>
                <li>自动创建令牌默认关闭，模板不完整时不会创建。</li>
                <li>OpenAI 订阅供应商保存后，在编辑页完成设备授权。</li>
                <li>停用是软停用，历史账目保留。</li>
              </ul>
            </Card>
            {mode === 'edit' && original ? (
              <Card title="标识">
                <dl className="meta-list">
                  <div>
                    <dt>供应商 ID</dt>
                    <dd className="mono break">{original.id}</dd>
                  </div>
                  <div>
                    <dt>创建时间</dt>
                    <dd>{formatDateTime(original.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>更新时间</dt>
                    <dd>{formatDateTime(original.updatedAt)}</dd>
                  </div>
                </dl>
              </Card>
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
          <Link className="btn btn--secondary btn--md" to={{ name: 'providers' }}>
            取消
          </Link>
          <Button type="submit" variant="primary" loading={busy}>
            {mode === 'new' ? '创建供应商' : '保存修改'}
          </Button>
        </FormActions>
      </form>
    </div>
  );
}
