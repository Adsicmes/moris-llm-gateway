import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../auth';
import type {
  DeletionAction,
  DeletionPreview,
  ProviderAccount,
  ProviderDeletion,
  ProviderDeletionResponse,
} from '../types';
import { describeError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { Link } from '../router';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  ErrorState,
  Field,
  InlineNote,
  Icon,
  Input,
  LoadingBlock,
  Modal,
  SkeletonRows,
  TableFrame,
  useToast,
} from '../ui';

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'info';

const DELETION_STATUS: Record<string, { label: string; tone: Tone }> = {
  draining: { label: '排空中', tone: 'info' },
  cleaning: { label: '清理中', tone: 'accent' },
  failed: { label: '失败', tone: 'bad' },
  paused: { label: '等待手动继续', tone: 'warn' },
  completed: { label: '已完成', tone: 'ok' },
  cancelled: { label: '已取消', tone: 'neutral' },
};

const ACTION_STATE: Record<string, { label: string; tone: Tone }> = {
  pending: { label: '待执行', tone: 'neutral' },
  running: { label: '执行中', tone: 'info' },
  deleted: { label: '已删除', tone: 'ok' },
  absent: { label: '上游已不存在', tone: 'ok' },
  skipped: { label: '已跳过', tone: 'neutral' },
  failed: { label: '失败', tone: 'bad' },
  unknown: { label: '结果未知', tone: 'warn' },
};

const DISPOSITION: Record<string, { label: string; tone: Tone }> = {
  ready: { label: '可清理', tone: 'ok' },
  adopt: { label: '需逐项确认', tone: 'warn' },
  blocked: { label: '不可执行', tone: 'bad' },
  shared: { label: '共享引用，跳过', tone: 'info' },
};

export function deletionStatusLabel(status: string | null | undefined): string {
  if (!status) return '未知';
  return DELETION_STATUS[status]?.label ?? status;
}

export function DeletionStatusBadge({ status }: { status: string | null | undefined }) {
  const item = status ? DELETION_STATUS[status] : undefined;
  return <Badge tone={item?.tone ?? 'neutral'}>{item?.label ?? status ?? '未知'}</Badge>;
}

function ActionStateBadge({ state }: { state: string }) {
  const item = ACTION_STATE[state];
  return <Badge tone={item?.tone ?? 'neutral'}>{item?.label ?? state}</Badge>;
}

function dispositionText(action: DeletionAction): string {
  const base = DISPOSITION[action.disposition]?.label ?? action.disposition;
  return action.group ? `${base} · 分组 ${action.group}` : base;
}

function selectable(action: DeletionAction): boolean {
  return action.disposition === 'ready' || action.disposition === 'adopt';
}

function actionDone(state: DeletionAction['state']): boolean {
  return state === 'deleted' || state === 'absent' || state === 'skipped';
}

/* ------------------------------------------------------------------ wizard */

export function ProviderDeletionDialog({
  provider,
  onClose,
  onStarted,
}: {
  provider: Pick<ProviderAccount, 'id' | 'name' | 'namespace'>;
  onClose: () => void;
  onStarted: (task: ProviderDeletion) => void;
}) {
  const api = useApi();
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adoptConfirmed, setAdoptConfirmed] = useState<Set<string>>(new Set());
  const [confirmNamespace, setConfirmNamespace] = useState('');
  const [acknowledgeUncleaned, setAcknowledgeUncleaned] = useState(false);
  const [acknowledgeUnsettled, setAcknowledgeUnsettled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setSubmitError(null);
    setPreview(null);
    setSelected(new Set());
    setAdoptConfirmed(new Set());
    setConfirmNamespace('');
    setAcknowledgeUncleaned(false);
    setAcknowledgeUnsettled(false);
    try {
      const next = await api<DeletionPreview>(
        `/api/admin/providers/${encodeURIComponent(provider.id)}/deletion-preview`,
        { method: 'POST' },
      );
      setPreview(next);
      setSelected(
        new Set(
          next.actions
            .filter((action) => action.disposition === 'ready' && action.defaultSelected)
            .map((action) => action.id),
        ),
      );
    } catch (error) {
      setLoadError(error);
    } finally {
      setLoading(false);
    }
  }, [api, provider.id]);

  useEffect(() => {
    void load();
  }, [load]);

  // 预览重载会替换正在聚焦的按钮；若焦点落回 body，把它送回弹窗内，避免破坏焦点陷阱。
  useEffect(() => {
    if (loading) return;
    if (document.activeElement !== document.body) return;
    const modal = document.querySelector<HTMLElement>('.moris-modal');
    modal?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')?.focus();
  }, [loading, preview, loadError]);

  const toggleSelected = (id: string, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
    if (!checked) {
      setAdoptConfirmed((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  };

  const toggleAdoptConfirmed = (id: string, checked: boolean) => {
    setAdoptConfirmed((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const actions = preview?.actions ?? [];
  const unselected = actions.filter(
    (action) => !selected.has(action.id) && action.disposition !== 'shared',
  );
  const warningUnverified = preview?.warnings.some((warning) => warning.includes('无法核验')) ?? false;
  const requireUncleaned =
    preview !== null && (!preview.cleanupSupported || unselected.length > 0 || warningUnverified);
  const requireUnsettled = (preview?.unsettledAttempts ?? 0) > 0;
  const namespaceMatches = preview !== null && confirmNamespace.trim() === provider.namespace;
  const missingAdoptConfirm = actions.some(
    (action) => action.disposition === 'adopt' && selected.has(action.id) && !adoptConfirmed.has(action.id),
  );
  const canSubmit =
    preview !== null &&
    namespaceMatches &&
    !missingAdoptConfirm &&
    (!requireUncleaned || acknowledgeUncleaned) &&
    (!requireUnsettled || acknowledgeUnsettled);

  const missing: string[] = [];
  if (preview && !namespaceMatches) missing.push(`输入命名空间 ${provider.namespace}`);
  if (missingAdoptConfirm) missing.push('逐项确认纳入的令牌');
  if (requireUncleaned && !acknowledgeUncleaned) missing.push('确认未清理项的风险');
  if (requireUnsettled && !acknowledgeUnsettled) missing.push('确认未结算记录警告');

  const submit = async () => {
    if (!preview || !canSubmit || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await api<ProviderDeletionResponse>(
        `/api/admin/providers/${encodeURIComponent(provider.id)}/deletions`,
        {
          method: 'POST',
          body: {
            revision: preview.revision,
            selectedActionIds: [...selected],
            adoptActionIds: actions
              .filter(
                (action) =>
                  action.disposition === 'adopt' && selected.has(action.id) && adoptConfirmed.has(action.id),
              )
              .map((action) => action.id),
            confirmNamespace: confirmNamespace.trim(),
            acknowledgeUnsettled,
            acknowledgeUncleaned,
          },
        },
      );
      onStarted(result.item);
    } catch (error) {
      setSubmitError(describeError(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      title={`彻底删除 ${provider.name}`}
      description="与停用不同：彻底删除会移除本地配置与凭据，并仅清理预览中由你确认的上游资源。"
      onClose={onClose}
      dismissible={!submitting}
      footer={
        <div className="tag-row" style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          {preview ? (
            <Button variant="secondary" onClick={() => void load()} disabled={submitting || loading}>
              重新读取预览
            </Button>
          ) : null}
          <Button variant="danger" onClick={() => void submit()} loading={submitting} disabled={!canSubmit}>
            开始彻底删除
          </Button>
        </div>
      }
    >
      {loading && !preview ? <LoadingBlock label="正在读取删除预览与上游资源" /> : null}

      {!loading && loadError ? (
        <ErrorState error={loadError} onRetry={() => void load()} />
      ) : null}

      {preview ? (
        <div className="moris-modal-form">
          <InlineNote tone="bad">
            <strong>此操作不可撤销。</strong> 确认后将停止该供应商的新请求并等待已开始的任务自然结束，然后删除本地配置、加密凭据、目录、监控与代理绑定。
            历史请求、attempt、费用和人民币账单保留，并以归档身份显示为已删除。
          </InlineNote>

          <ul className="check-list">
            <li>旧数据库备份仍可能包含已加密的历史凭据；删除不会清理既有备份，也不等于全介质安全擦除。备份可以恢复本地配置，但不能恢复已经撤销的上游资源。</li>
            <li>无法自动证明外部客户端是否共用某个上游令牌；若他人也在使用，清理该资源会影响他们。</li>
            <li>
              {preview.unsettledAttempts > 0
                ? `有 ${preview.unsettledAttempts} 条未结算记录。删除凭据后不会自动做最后一轮对账，金额保持未知，不会变成 0。`
                : '当前没有未结算记录；历史金额不重算，未知值不会变成 0。'}
            </li>
            <li>命名空间会在完成后释放；之后新建同名供应商会使用新的 accountId，旧历史不会归到新账号。</li>
          </ul>

          {preview.warnings.length > 0 ? (
            <InlineNote tone="warn">
              <ul className="check-list">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </InlineNote>
          ) : null}

          {!preview.cleanupSupported ? (
            <InlineNote tone="info">
              当前插件没有声明上游清理能力：本次只删除本地配置与凭据，不会撤销上游账号、令牌或授权。
            </InlineNote>
          ) : null}

          <section aria-labelledby="deletion-actions-title">
            <h3 id="deletion-actions-title" className="form-note--top">
              上游清理项
            </h3>
            {actions.length > 0 ? (
              <TableFrame label="上游清理项">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">选择</th>
                      <th scope="col">清理项</th>
                      <th scope="col">上游对象</th>
                      <th scope="col">说明</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actions.map((action, index) => {
                      const checkboxId = `deletion-action-${index}-select`;
                      const canSelect = selectable(action);
                      const isSelected = selected.has(action.id);
                      return (
                        <tr key={action.id}>
                          <td>
                            {canSelect ? (
                              <Checkbox
                                id={checkboxId}
                                label={action.disposition === 'adopt' ? '纳入并删除' : '选择'}
                                aria-label={`${action.disposition === 'adopt' ? '纳入并删除' : '选择'}清理项 ${action.name} ${action.externalId}`}
                                checked={isSelected}
                                onChange={(event) => toggleSelected(action.id, event.target.checked)}
                              />
                            ) : (
                              <Checkbox
                                id={checkboxId}
                                label={action.disposition === 'shared' ? '跳过' : '不可选'}
                                aria-label={`${action.disposition === 'shared' ? '跳过' : '不可选'}清理项 ${action.name} ${action.externalId}`}
                                checked={false}
                                disabled
                                readOnly
                              />
                            )}
                          </td>
                          <td>
                            <div className="cell-stack">
                              <strong>{action.name}</strong>
                              <span className="small muted">{dispositionText(action)}</span>
                              {action.disposition === 'adopt' && isSelected ? (
                                <Checkbox
                                  label="我确认这个令牌的归属"
                                  aria-label={`我确认这个令牌的归属：${action.name} ${action.externalId}`}
                                  description={`仅在你已核验 ${action.externalId} 由本网关创建或属于本网关时勾选。名称前缀不是创建证明。`}
                                  checked={adoptConfirmed.has(action.id)}
                                  onChange={(event) => toggleAdoptConfirmed(action.id, event.target.checked)}
                                />
                              ) : null}
                              {action.disposition === 'adopt' && isSelected && !adoptConfirmed.has(action.id) ? (
                                <p className="small danger-text">逐项确认后才能提交这个清理项；也可以取消选择，仅删除本地配置。</p>
                              ) : null}
                            </div>
                          </td>
                          <td>
                            <div className="cell-stack">
                              <span className="mono small break">{action.externalId}</span>
                              {action.group ? <span className="small muted">分组 {action.group}</span> : null}
                            </div>
                          </td>
                          <td className="cell-note">
                            {action.reason ? <p className="small muted">{action.reason}</p> : null}
                            {action.references.length > 0 ? (
                              <p className="small muted">
                                本地引用：{action.references.map((reference) => reference.name).join('、')}
                              </p>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableFrame>
            ) : (
              <p className="small muted">没有可选的上游清理项；本次只删除本地配置与凭据。</p>
            )}
          </section>

          {requireUncleaned ? (
            <Checkbox
              label="我了解未清理的上游资源仍然有效"
              description={
                warningUnverified
                  ? '上游清理能力或完整资源清单无法核验，无法确认哪些资源仍然有效。未勾选的清理项、插件不支持的项，以及被阻塞或共享引用跳过的项都不会被撤销。删除本地凭据后无法再自动核验这些资源，需要你自行到上游处理。'
                  : '未勾选的清理项、插件不支持的项，以及被阻塞或共享引用跳过的项都不会被撤销。删除本地凭据后无法再自动核验这些资源，需要你自行到上游处理。'
              }
              checked={acknowledgeUncleaned}
              onChange={(event) => setAcknowledgeUncleaned(event.target.checked)}
            />
          ) : null}

          {requireUnsettled ? (
            <Checkbox
              label="我了解删除后无法继续自动对账"
              description={`有 ${preview.unsettledAttempts} 条未结算记录。删除凭据后不会自动结算，这些金额会保持未知，也不会因为删除而变成 0。`}
              checked={acknowledgeUnsettled}
              onChange={(event) => setAcknowledgeUnsettled(event.target.checked)}
            />
          ) : null}

          <Field
            label={`输入命名空间 ${provider.namespace} 确认`}
            id="deletion-namespace"
            error={
              confirmNamespace.length > 0 && !namespaceMatches
                ? `命名空间不一致，请输入 ${provider.namespace}。`
                : null
            }
            hint="必须逐字一致；输入错误或配置已变化时不会提交，需要重新读取预览。"
          >
            <Input
              id="deletion-namespace"
              value={confirmNamespace}
              onChange={(event) => setConfirmNamespace(event.target.value)}
              placeholder={provider.namespace}
              className="mono"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <p className="small muted">预览有效期至 {formatDateTime(preview.expiresAt)}；配置或引用变化后需要重新预览。</p>

          {missing.length > 0 ? (
            <p className="small muted" role="status">
              提交前还需：{missing.join('；')}。
            </p>
          ) : null}

          {submitError ? (
            <div className="notice notice--bad" role="alert">
              <Icon name="alert" size={18} />
              <div>
                <strong>没有开始删除</strong>
                <p>{submitError}</p>
              </div>
              <Button size="sm" variant="secondary" onClick={() => void load()} disabled={submitting}>
                重新预览
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

/* ------------------------------------------------------------------ tasks */

export function ProviderDeletionsPanel({
  items,
  loading,
  refreshing,
  error,
  onReload,
  onChanged,
  activeAccountIds,
}: {
  items: ProviderDeletion[];
  loading: boolean;
  refreshing: boolean;
  error: unknown;
  onReload: () => void;
  onChanged: () => void;
  activeAccountIds: Set<string>;
}) {
  const api = useApi();
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [retryTarget, setRetryTarget] = useState<ProviderDeletion | null>(null);
  const [cancelTarget, setCancelTarget] = useState<ProviderDeletion | null>(null);

  const retry = async (task: ProviderDeletion) => {
    setBusyId(task.id);
    try {
      await api<ProviderDeletionResponse>(
        `/api/admin/provider-deletions/${encodeURIComponent(task.id)}/retry`,
        { method: 'POST', body: {} },
      );
      toast.push('已继续删除任务；进度会保存在服务端。');
      onReload();
      onChanged();
    } catch (error) {
      toast.push(`重试失败：${describeError(error)}`, 'bad');
    } finally {
      setBusyId(null);
      setRetryTarget(null);
    }
  };

  const cancel = async (task: ProviderDeletion) => {
    setBusyId(task.id);
    try {
      await api<ProviderDeletionResponse>(
        `/api/admin/provider-deletions/${encodeURIComponent(task.id)}/cancel`,
        { method: 'POST', body: {} },
      );
      toast.push('已请求取消删除流程；进行中的上游结果仍需核验。');
      onReload();
      onChanged();
    } catch (error) {
      toast.push(`取消失败：${describeError(error)}`, 'bad');
    } finally {
      setBusyId(null);
      setCancelTarget(null);
    }
  };

  return (
    <Card
      title="彻底删除任务"
      action={
        <Button icon="refresh" onClick={onReload} loading={refreshing} aria-label="刷新彻底删除任务">
          刷新
        </Button>
      }
    >
      <p className="small muted">
        删除任务持久保存在服务端，刷新页面可恢复进度。只有在排空或清理中时才定期读取；失败或暂停时需要手动重试，不会自动重发上游删除。
      </p>

      {error ? <ErrorState error={error} onRetry={onReload} /> : null}
      {loading && items.length === 0 ? <SkeletonRows rows={2} /> : null}

      {!loading && !error && items.length === 0 ? (
        <p className="small muted">
          还没有彻底删除任务。停用保留供应商；彻底删除会先预览，再进入这里的持久任务。
        </p>
      ) : null}

      {items.map((task) => {
        const done = task.actions.filter((action) => actionDone(action.state)).length;
        const retryable = !task.cancelRequested && (task.status === 'failed' || task.status === 'paused');
        const cancellable =
          !task.cancelRequested &&
          (task.status === 'draining' ||
            task.status === 'cleaning' ||
            task.status === 'failed' ||
            task.status === 'paused');
        return (
          <div
            className="secret-guide"
            id={`deletion-task-${task.id}`}
            key={task.id}
            role="group"
            aria-label={`删除任务 ${task.name || task.namespace}`}
            tabIndex={-1}
          >
            <div className="tag-row">
              <h3>{task.name || task.namespace}</h3>
              <DeletionStatusBadge status={task.status} />
              {task.cancelRequested ? <Badge tone="warn">已请求取消</Badge> : null}
            </div>
            <p className="small muted break">
              供应商 ID <span className="mono">{task.accountId}</span> · 命名空间{' '}
              <span className="mono">{task.namespace}</span>
            </p>

            {task.message ? <p className="small">{task.message}</p> : null}

            <dl className="meta-list meta-list--cols">
              <div>
                <dt>创建</dt>
                <dd>{formatDateTime(task.createdAt)}</dd>
              </div>
              <div>
                <dt>更新</dt>
                <dd>{formatDateTime(task.updatedAt)}</dd>
              </div>
              <div>
                <dt>清理项</dt>
                <dd>
                  {task.actions.length > 0 ? `${done}/${task.actions.length} 项已结束` : '无上游清理项'}
                </dd>
              </div>
            </dl>

            {task.actions.length > 0 ? (
              <ul className="check-list">
                {task.actions.map((action) => (
                  <li key={action.id}>
                    <span>{action.name}</span>{' '}
                    <span className="mono small break">{action.externalId}</span>{' '}
                    <ActionStateBadge state={action.state} />{' '}
                    <span className="small muted">
                      {dispositionText(action)}
                      {action.reason ? ` · ${action.reason}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="small muted">该任务不包含上游清理项，只处理本地配置与凭据。</p>
            )}

            {task.status === 'failed' || task.status === 'paused' ? (
              <InlineNote tone="warn">
                任务已停止。可修复该供应商的上游密钥或代理后重试；重试会先重新核验未知结果，不会新建令牌。
              </InlineNote>
            ) : null}

            {task.status === 'cancelled' ? (
              <p className="small muted">取消只停止后续项。供应商保持停用，已删除的上游资源不会恢复，也不会自动重新启用。</p>
            ) : null}

            <div className="tag-row form-note">
              {retryable && activeAccountIds.has(task.accountId) ? (
                <Link
                  className="btn btn--secondary btn--sm"
                  to={{ name: 'provider-edit', id: task.accountId }}
                  aria-label={`修复凭据或代理（${task.name || task.namespace}）`}
                >
                  <Icon name="edit" size={15} /> 修复凭据或代理
                </Link>
              ) : null}
              {retryable ? (
                <Button
                  size="sm"
                  icon="refresh"
                  aria-label={`重试 ${task.name || task.namespace} 的删除任务`}
                  disabled={busyId !== null}
                  loading={busyId === task.id && retryTarget !== null}
                  onClick={() => setRetryTarget(task)}
                >
                  重试
                </Button>
              ) : null}
              {cancellable ? (
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`取消 ${task.name || task.namespace} 的删除流程`}
                  disabled={busyId !== null}
                  loading={busyId === task.id && cancelTarget !== null}
                  onClick={() => setCancelTarget(task)}
                >
                  取消流程
                </Button>
              ) : null}
            </div>
          </div>
        );
      })}

      <ConfirmDialog
        open={retryTarget !== null}
        title="重试这个删除任务？"
        description={
          <>
            <p>
              将重新核验 <strong>{retryTarget?.name}</strong> 的未完成清理项并继续。
            </p>
            <p className="muted">
              不会创建新令牌；结果未知的项会先核对上游是否仍然存在。失败的项会保持失败，不会显示成成功。
            </p>
          </>
        }
        confirmLabel="重试删除任务"
        tone="primary"
        busy={busyId !== null}
        onConfirm={() => {
          if (retryTarget) void retry(retryTarget);
        }}
        onClose={() => setRetryTarget(null)}
      />

      <ConfirmDialog
        open={cancelTarget !== null}
        title="取消删除流程？"
        description={
          <>
            <p>
              将停止 <strong>{cancelTarget?.name}</strong> 的后续清理。已发出的上游删除不会被强行中断，会先记录其结果或未知状态。
            </p>
            <p className="muted">
              供应商保持停用，不会自动重新启用；已经删除的上游资源不会恢复。未决结果需要重新核验。
            </p>
          </>
        }
        confirmLabel="取消删除流程"
        tone="primary"
        busy={busyId !== null}
        onConfirm={() => {
          if (cancelTarget) void cancel(cancelTarget);
        }}
        onClose={() => setCancelTarget(null)}
      />
    </Card>
  );
}
