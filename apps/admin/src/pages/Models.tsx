import { useMemo, useState } from 'react';
import { useApi } from '../auth';
import type { ModelsResponse, Settings } from '../types';
import type { CatalogModel, Price } from '../lib/contracts';
import { formatDateTime, formatMoneyList, formatMs, prettyJson } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import { Link } from '../router';
import { ModelParameters } from './ModelParameters';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Icon,
  InlineNote,
  Input,
  Modal,
  PageHeader,
  Select,
  SkeletonRows,
  TableFrame,
} from '../ui';

function numberText(value: number | null | undefined): string {
  if (value === null || value === undefined) return '未知';
  return new Intl.NumberFormat('zh-CN').format(value);
}

function PriceBlock({ price, title }: { price: Price | undefined; title: string }) {
  if (!price) {
    return (
      <div className="price-block">
        <h4>{title}</h4>
        <p className="muted">未提供</p>
      </div>
    );
  }
  const rows: Array<[string, string]> = [];
  if (price.kind === 'token') {
    rows.push(['输入 / 百万 tokens', price.input === undefined ? '未提供' : formatMoneyList([{ amount: price.input, currency: price.currency }])]);
    rows.push(['输出 / 百万 tokens', price.output === undefined ? '未提供' : formatMoneyList([{ amount: price.output, currency: price.currency }])]);
    rows.push(['缓存读取 / 百万 tokens', price.cacheRead === undefined ? '未提供' : formatMoneyList([{ amount: price.cacheRead, currency: price.currency }])]);
    rows.push(['缓存写入 / 百万 tokens', price.cacheWrite === undefined ? '未提供' : formatMoneyList([{ amount: price.cacheWrite, currency: price.currency }])]);
  } else if (price.kind === 'request') {
    rows.push(['每次请求', price.perRequest === undefined ? '未提供' : formatMoneyList([{ amount: price.perRequest, currency: price.currency }])]);
  } else if (price.kind === 'complex') {
    rows.push(['计价表达式', price.expression ?? '未提供']);
  } else {
    rows.push(['计价', '未知']);
  }
  if (price.source) rows.push(['来源', price.source]);
  if (price.version) rows.push(['版本', price.version]);

  return (
    <div className="price-block">
      <h4>
        {title} <Badge tone={price.kind === 'unknown' ? 'neutral' : 'info'}>{price.kind}</Badge>
      </h4>
      <dl className="meta-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className={value === '未提供' || value === '未知' ? 'muted' : undefined}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function capabilities(model: CatalogModel) {
  const items: string[] = [];
  if (model.capabilities.tools) items.push('工具');
  if (model.capabilities.reasoning) items.push('推理');
  for (const input of model.capabilities.input) items.push(input === 'image' ? '图片输入' : '文本输入');
  for (const output of model.capabilities.output) items.push(output === 'text' ? '文本输出' : output);
  return items;
}

function ModelDetail({
  model,
  onClose,
  onSaved,
  onDirtyChange,
}: {
  model: CatalogModel | null;
  onClose: () => void;
  onSaved: (model: CatalogModel) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  return (
    <Modal
      open={model !== null}
      title={model?.name ?? '模型详情'}
      description={model ? <span className="mono">{model.id}</span> : undefined}
      onClose={onClose}
      size="lg"
    >
      {model ? (
        <div className="detail-stack">
          <div className="tag-row">
            <Badge tone={model.enabled ? 'ok' : 'neutral'}>{model.enabled ? '可调用' : '已停用'}</Badge>
            <Badge tone="info">{model.protocol}</Badge>
            <Badge>{model.billingType === 'subscription' ? '订阅' : '按量'}</Badge>
            {capabilities(model).map((item) => (
              <Badge key={item}>{item}</Badge>
            ))}
          </div>
          {!model.enabled ? (
            <div className="model-repair">
              <InlineNote tone="warn">
                停用原因：{model.disabledReason ?? '目录过期、供应商停用或参数不完整。'}
                <br />
                修复路径：到供应商页保存并同步目录；若是本网关参数覆盖导致，直接在下方「参数编辑」修正并保存。
              </InlineNote>
              <div className="oauth-actions">
                <Link className="btn btn--secondary btn--sm" to={{ name: 'providers' }}>
                  去供应商页同步 / 启用
                </Link>
                <span className="small muted">同步成功后回到本页刷新，停用状态会自动更新。</span>
              </div>
            </div>
          ) : null}

          <ModelParameters key={model.id} modelId={model.id} onSaved={onSaved} onDirtyChange={onDirtyChange} />

          <div className="detail-grid">
            <div>
              <h3>标识</h3>
              <dl className="meta-list">
                <div>
                  <dt>业务模型 ID</dt>
                  <dd className="mono break">{model.id}</dd>
                </div>
                <div>
                  <dt>目录路径</dt>
                  <dd className="mono break">{model.path}</dd>
                </div>
                <div>
                  <dt>上游模型</dt>
                  <dd className="mono break">{model.upstreamModel}</dd>
                </div>
                <div>
                  <dt>家族</dt>
                  <dd>{model.family}</dd>
                </div>
                <div>
                  <dt>分组</dt>
                  <dd>{model.group ?? '未提供'}</dd>
                </div>
                <div>
                  <dt>凭据键</dt>
                  <dd className="mono">{model.credentialKey ?? '未提供'}</dd>
                </div>
                <div>
                  <dt>账户</dt>
                  <dd className="mono break">{model.accountId}</dd>
                </div>
                <div>
                  <dt>目录同步</dt>
                  <dd>{formatDateTime(model.syncedAt)}</dd>
                </div>
              </dl>
            </div>
            <div>
              <h3>限制</h3>
              <dl className="meta-list">
                <div>
                  <dt>上下文</dt>
                  <dd>{numberText(model.limit.context)}</dd>
                </div>
                <div>
                  <dt>最大输出</dt>
                  <dd>{numberText(model.limit.output)}</dd>
                </div>
                <div>
                  <dt>输入上限</dt>
                  <dd>{numberText(model.limit.input)}</dd>
                </div>
              </dl>
            </div>
          </div>

          <div className="price-grid">
            <PriceBlock price={model.price} title="适用价格" />
            <PriceBlock price={model.referencePrice} title="参考价格" />
          </div>
          <p className="quiet-note">价格按目录快照保存；历史请求使用各自的价格版本，不因新价格覆盖旧账。</p>

          <div>
            <h3>来源</h3>
            {model.sources && Object.keys(model.sources).length > 0 ? (
              <dl className="meta-list">
                {Object.entries(model.sources).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd className="mono break">{value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="muted">未提供字段级来源。</p>
            )}
          </div>

          <div>
            <h3>变体</h3>
            {Object.keys(model.variants).length > 0 ? (
              <pre className="code-block">{prettyJson(model.variants)}</pre>
            ) : (
              <p className="muted">没有同步到模型变体。</p>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

export function ModelsPage() {
  const api = useApi();
  const models = useAsync((signal) => api<ModelsResponse>('/api/admin/models', { signal }), []);
  const settings = useAsync((signal) => api<Settings>('/api/admin/settings', { signal }), []);
  const [search, setSearch] = useState('');
  const [account, setAccount] = useState('all');
  const [protocol, setProtocol] = useState('all');
  const [state, setState] = useState('all');
  const [selected, setSelected] = useState<CatalogModel | null>(null);
  const [paramDirty, setParamDirty] = useState(false);

  const openDetail = (model: CatalogModel) => {
    if (selected?.id === model.id) return;
    if (paramDirty && !window.confirm('切换模型会丢失未保存的参数修改。确定切换吗？')) return;
    setParamDirty(false);
    setSelected(model);
  };

  const closeDetail = () => {
    if (paramDirty && !window.confirm('模型参数还有未保存的修改，关闭会丢失。确定关闭吗？')) return;
    setParamDirty(false);
    setSelected(null);
  };

  const items = models.data?.items ?? [];
  const accounts = useMemo(() => {
    const map = new Map<string, { accountId: string; namespace: string; count: number; enabled: number; latest: string }>();
    for (const model of items) {
      const existing = map.get(model.accountId);
      if (existing) {
        existing.count += 1;
        existing.enabled += model.enabled ? 1 : 0;
        if (new Date(model.syncedAt).getTime() > new Date(existing.latest).getTime()) existing.latest = model.syncedAt;
      } else {
        map.set(model.accountId, {
          accountId: model.accountId,
          namespace: model.namespace,
          count: 1,
          enabled: model.enabled ? 1 : 0,
          latest: model.syncedAt,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.namespace.localeCompare(b.namespace));
  }, [items]);

  const protocols = useMemo(() => Array.from(new Set(items.map((item) => item.protocol))).sort(), [items]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return items.filter((model) => {
      if (account !== 'all' && model.accountId !== account) return false;
      if (protocol !== 'all' && model.protocol !== protocol) return false;
      if (state === 'enabled' && !model.enabled) return false;
      if (state === 'disabled' && model.enabled) return false;
      if (!term) return true;
      return [model.id, model.name, model.path, model.upstreamModel, model.family, model.group ?? '']
        .join(' ')
        .toLowerCase()
        .includes(term);
    });
  }, [items, account, protocol, state, search]);

  return (
    <div className="page">
      <PageHeader
        title="模型目录"
        description="目录快照包含停用条目。来源与时间按模型条目展示；账户级状态来自各条 syncedAt 的汇总。"
        actions={
          <Button icon="refresh" onClick={models.reload} loading={models.refreshing}>
            重新读取
          </Button>
        }
      />

      <InlineNote>
        目录同步失败时服务端保留上一次完整快照；缓存超过设置中的目录有效期
        {settings.data ? `（当前 ${formatMs(settings.data.catalogTtlMs)}）` : ''}
        未成功刷新会暂停受影响模型的新请求。点击模型可编辑本网关的参数覆盖。
      </InlineNote>

      {models.error ? <ErrorState error={models.error} onRetry={models.reload} /> : null}
      {models.loading && !models.data ? <SkeletonRows rows={6} /> : null}

      {models.data ? (
        <>
          <section className="source-grid" aria-label="目录来源">
            {accounts.length > 0 ? (
              accounts.map((item) => (
                <article key={item.accountId} className="source-card">
                  <p className="source-card__label">来源</p>
                  <h3 className="mono">{item.namespace}</h3>
                  <p className="source-card__meta">
                    {item.count} 个条目 · {item.enabled} 个可调用
                  </p>
                  <p className="source-card__time">条目最近同步 {formatDateTime(item.latest)}</p>
                  <p className="source-card__id mono">{item.accountId}</p>
                </article>
              ))
            ) : (
              <div className="source-card source-card--empty">
                <p>目录来源会随供应商同步出现。</p>
              </div>
            )}
          </section>

          <Card>
            <div className="filter-bar">
              <Field label="搜索模型" id="model-search">
                <div className="input-with-icon">
                  <Icon name="search" size={16} />
                  <Input
                    id="model-search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="名称、业务 ID、上游 ID、家族"
                  />
                </div>
              </Field>
              <Field label="来源账户" id="model-account">
                <Select id="model-account" value={account} onChange={(event) => setAccount(event.target.value)}>
                  <option value="all">全部来源</option>
                  {accounts.map((item) => (
                    <option key={item.accountId} value={item.accountId}>
                      {item.namespace} · {item.accountId}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="协议" id="model-protocol">
                <Select id="model-protocol" value={protocol} onChange={(event) => setProtocol(event.target.value)}>
                  <option value="all">全部协议</option>
                  {protocols.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="状态" id="model-state">
                <Select id="model-state" value={state} onChange={(event) => setState(event.target.value)}>
                  <option value="all">全部状态</option>
                  <option value="enabled">可调用</option>
                  <option value="disabled">已停用</option>
                </Select>
              </Field>
            </div>

            <div className="result-line">
              <span>
                显示 {filtered.length} / {items.length} 个条目
              </span>
               {items.length === 0 ? null : <span className="muted">点击模型编辑参数，查看价格、来源与变体。</span>}
            </div>

            {items.length === 0 && !models.error ? (
              <EmptyState
                title="目录还是空的"
                description="先在供应商页接入账号并执行一次同步，完整成功的快照才会写入目录。"
                action={
                  <Link className="btn btn--primary btn--md" to={{ name: 'providers' }}>
                    去接入供应商
                  </Link>
                }
              />
            ) : filtered.length === 0 ? (
              <EmptyState title="没有匹配的模型" description="调整搜索词或筛选条件。" />
            ) : (
              <TableFrame label="模型目录">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">模型</th>
                      <th scope="col">来源 / 分组</th>
                      <th scope="col">协议</th>
                      <th scope="col">能力</th>
                      <th scope="col">上下文 / 输出</th>
                      <th scope="col">价格</th>
                      <th scope="col">同步时间</th>
                      <th scope="col">状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((model) => (
                      <tr
                        key={model.id}
                        className="table-row--clickable"
                        onClick={() => openDetail(model)}
                      >
                        <td>
                          <div className="cell-stack">
                            <button
                              type="button"
                              className="link-button"
                              onClick={(event) => {
                                event.stopPropagation();
                                openDetail(model);
                              }}
                            >
                              {model.name}
                            </button>
                            <span className="mono small">{model.id}</span>
                          </div>
                        </td>
                        <td>
                          <div className="cell-stack">
                            <span className="mono small">{model.namespace}</span>
                            <span className="small muted">{model.group ?? '未分组'}</span>
                          </div>
                        </td>
                        <td>
                          <Badge tone="info">{model.protocol}</Badge>
                        </td>
                        <td>
                          <div className="tag-row tag-row--tight">
                            {capabilities(model).map((item) => (
                              <Badge key={item}>{item}</Badge>
                            ))}
                          </div>
                        </td>
                        <td className="num nowrap">
                          {numberText(model.limit.context)} / {numberText(model.limit.output)}
                        </td>
                        <td>
                          <div className="cell-stack">
                            <Badge tone={model.price.kind === 'unknown' ? 'neutral' : 'info'}>{model.price.kind}</Badge>
                            <span className="small muted">
                              {model.price.kind === 'complex'
                                ? model.price.expression ?? '表达式未提供'
                                : model.price.kind === 'unknown'
                                  ? '未知'
                                  : model.price.source ?? '未提供来源'}
                            </span>
                          </div>
                        </td>
                        <td className="nowrap small">{formatDateTime(model.syncedAt)}</td>
                        <td>
                          <div className="cell-stack">
                            <Badge tone={model.enabled ? 'ok' : 'neutral'}>{model.enabled ? '可调用' : '已停用'}</Badge>
                            {model.disabledReason ? <span className="small muted">{model.disabledReason}</span> : null}
                            {!model.enabled ? (
                              <Link
                                className="small text-link"
                                to={{ name: 'providers' }}
                                onClick={(event) => event.stopPropagation()}
                              >
                                去供应商页同步 / 启用
                              </Link>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            )}
          </Card>
        </>
      ) : null}

      <ModelDetail
        model={selected}
        onClose={closeDetail}
        onDirtyChange={setParamDirty}
        onSaved={model => {
          setParamDirty(false);
          setSelected(current => current?.id === model.id ? model : current);
          models.reload();
        }}
      />
    </div>
  );
}
