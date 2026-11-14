import { useState, type FormEvent } from 'react';
import { useApi } from '../auth';
import type { DeviceCreateResponse, DevicesResponse } from '../types';
import { describeError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useAsync } from '../lib/useAsync';
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  focusFirstInvalid,
  Icon,
  InlineNote,
  Input,
  Modal,
  PageHeader,
  SkeletonRows,
  TableFrame,
  useToast,
} from '../ui';

export function DevicesPage() {
  const api = useApi();
  const toast = useToast();
  const devices = useAsync((signal) => api<DevicesResponse>('/api/admin/devices', { signal }), []);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<DeviceCreateResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState(false);

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      setError('填写设备名称，例如「MacBook Pro」或「家里台式机」。');
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<DeviceCreateResponse>('/api/admin/devices', {
        method: 'POST',
        body: { name: name.trim() },
      });
      setCreateOpen(false);
      setName('');
      setIssued(result);
      devices.reload();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!revokeTarget) return;
    setRevoking(true);
    try {
      await api(`/api/admin/devices/${encodeURIComponent(revokeTarget.id)}`, { method: 'DELETE' });
      toast.push(`已撤销 ${revokeTarget.name} 的密钥，历史账目保留。`);
      setRevokeTarget(null);
      devices.reload();
    } catch (reason) {
      toast.push(`撤销失败：${describeError(reason)}`, 'bad');
    } finally {
      setRevoking(false);
    }
  };

  const items = devices.data?.items ?? [];
  const active = items.filter((device) => !device.revokedAt).length;
  const origin = window.location.origin;
  const opencodeSnippet = `{
  "plugins": [
    {
      "package": "@moris/opencode-plugin",
      "options": {
        "baseUrl": "${origin}",
        "apiKey": "<设备密钥>"
      }
    }
  ]
}`;
  const openchamberSnippet = `{
  "baseUrl": "${origin}",
  "apiKey": "<设备密钥>"
}`;

  return (
    <div className="page">
      <PageHeader
        title="设备密钥"
        description="每台设备一把独立网关密钥，可单独撤销。密钥只在创建时显示一次，管理后台不保存明文。"
        actions={
          <>
            <Button icon="refresh" onClick={devices.reload} loading={devices.refreshing}>
              刷新
            </Button>
            <Button variant="primary" icon="plus" onClick={() => { setError(null); setCreateOpen(true); }}>
              创建设备密钥
            </Button>
          </>
        }
      />

      <InlineNote>
        设备密钥可调用 /v1 接口、读取目录与额度，但不授予任何后台管理权限。撤销立即生效；已产生的历史请求与账目保留。
      </InlineNote>

      <Card title="客户端接入">
        <div className="client-config">
          <section>
            <h3>OpenCode v2</h3>
            <p className="small muted">写入全局或项目的 <code>opencode.jsonc</code>。把 <code>&lt;设备密钥&gt;</code> 换成刚创建的密钥。</p>
            <pre className="code-block">{opencodeSnippet}</pre>
            <CopyButton text={opencodeSnippet} label="复制 OpenCode 配置" />
          </section>
          <section>
            <h3>OpenChamber Work Status</h3>
            <p className="small muted">
              保存为扩展服务数据目录下的 <code>config.json</code>（<code>{'{OPENCHAMBER_SERVICE_DATA_DIR}'}/config.json</code>）；也可复用上面的 OpenCode 配置。
            </p>
            <pre className="code-block">{openchamberSnippet}</pre>
            <CopyButton text={openchamberSnippet} label="复制 OpenChamber 配置" />
          </section>
        </div>
        <p className="quiet-note">
          每台设备单独创建密钥；不要把密钥提交到仓库、写进日志或发给其他人。撤销某把密钥只影响对应设备。
        </p>
      </Card>

      <div className="mini-stats">
        <div>
          <span>有效设备</span>
          <strong>{active}</strong>
        </div>
        <div>
          <span>已撤销</span>
          <strong>{items.length - active}</strong>
        </div>
      </div>

      <div className="card">
        <div className="card__body">
          {devices.error ? <ErrorState error={devices.error} onRetry={devices.reload} /> : null}
          {devices.loading && !devices.data ? <SkeletonRows rows={4} /> : null}
          {devices.data && items.length === 0 && !devices.error ? (
            <EmptyState
              title="还没有设备密钥"
              description="先为当前设备创建一把密钥，再把它填入 OpenCode 的网关配置。创建后只显示一次。"
              action={
                <Button variant="primary" icon="plus" onClick={() => { setError(null); setCreateOpen(true); }}>
                  创建第一把密钥
                </Button>
              }
            />
          ) : null}
          {items.length > 0 ? (
            <TableFrame label="设备密钥">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">设备</th>
                    <th scope="col">ID</th>
                    <th scope="col">创建时间</th>
                    <th scope="col">最近使用</th>
                    <th scope="col">状态</th>
                    <th scope="col" className="col-actions">
                      操作
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((device) => {
                    const revoked = Boolean(device.revokedAt);
                    return (
                      <tr key={device.id} className={revoked ? 'row--muted' : undefined}>
                        <td>
                          <strong>{device.name}</strong>
                        </td>
                        <td className="mono small break">{device.id}</td>
                        <td className="nowrap small">{formatDateTime(device.createdAt)}</td>
                        <td className="nowrap small">{device.lastUsedAt ? formatDateTime(device.lastUsedAt) : '从未使用'}</td>
                        <td>
                          <div className="cell-stack">
                            <Badge tone={revoked ? 'neutral' : 'ok'}>{revoked ? '已撤销' : '有效'}</Badge>
                            {revoked ? <span className="small muted">撤销于 {formatDateTime(device.revokedAt)}</span> : null}
                          </div>
                        </td>
                        <td>
                          <Button
                            size="sm"
                            variant="danger"
                            icon="trash"
                            disabled={revoked}
                            onClick={() => setRevokeTarget({ id: device.id, name: device.name })}
                          >
                            撤销
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableFrame>
          ) : null}
        </div>
      </div>

      <Modal
        open={createOpen}
        title="创建设备密钥"
        description="命名用来区分设备；密钥只在本次创建成功后显示一次。"
        onClose={() => {
          setCreateOpen(false);
          setError(null);
        }}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>
              取消
            </Button>
            <Button variant="primary" type="submit" form="device-form" loading={busy}>
              创建密钥
            </Button>
          </>
        }
      >
        <form id="device-form" onSubmit={create} noValidate>
          <Field
            label="设备名称"
            id="device-name"
            error={error ?? undefined}
            hint="例如 MacBook Pro、家里台式机、旅行笔记本。名称不参与鉴权。"
          >
            <Input
              id="device-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="MacBook Pro"
              data-autofocus
              aria-invalid={Boolean(error)}
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={issued !== null}
        title="密钥已创建"
        description="关闭后无法再次查看；如需更换，只能撤销后重新创建。"
        onClose={() => setIssued(null)}
        dismissible={false}
        footer={
          <Button variant="primary" onClick={() => setIssued(null)}>
            我已保存，关闭
          </Button>
        }
      >
        {issued ? (
          <div className="key-reveal">
            <InlineNote tone="warn">
              这是唯一一次显示。不要把密钥写进代码、日志或聊天记录；建议立即填入设备配置，然后关闭对话框。
            </InlineNote>
            <div className="key-reveal__device">
              <Icon name="key" size={18} />
              <span>
                设备：<strong>{issued.item.name}</strong>
              </span>
            </div>
            <code className="key-reveal__value">{issued.key}</code>
            <div className="key-reveal__actions">
              <CopyButton text={issued.key} label="复制密钥" />
              <span className="small muted">关闭后此值会从页面内存清除。</span>
            </div>
            <p className="small muted">
              然后到上方「客户端接入」复制模板，把 <code>&lt;设备密钥&gt;</code> 替换为这把密钥。
            </p>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={revokeTarget !== null}
        title="撤销这把设备密钥？"
        description={
          <>
            <p>
              <strong>{revokeTarget?.name}</strong> 将立即无法调用模型、同步目录或查询额度。
            </p>
            <p className="muted">其他设备不受影响；该设备已产生的历史请求与账目保留。此操作不能恢复同一把密钥。</p>
          </>
        }
        confirmLabel="撤销密钥"
        busy={revoking}
        onConfirm={() => void revoke()}
        onClose={() => setRevokeTarget(null)}
      />
    </div>
  );
}
