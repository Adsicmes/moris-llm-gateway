import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../auth';
import type { OAuthPollResponse, OAuthStartResponse, SyncResult } from '../types';
import { describeError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import {
  Badge,
  Button,
  Card,
  CopyButton,
  DataStateBadge,
  Icon,
  InlineNote,
  useToast,
} from '../ui';

type Phase = 'idle' | 'starting' | 'pending' | 'complete' | 'expired' | 'error';

function normalizeInterval(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.max(1, Math.floor(parsed));
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function remainingText(seconds: number): string {
  const safe = Math.max(0, seconds);
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return minutes > 0 ? `${minutes} 分 ${String(rest).padStart(2, '0')} 秒` : `${rest} 秒`;
}

export function OpenAIProviderAuth({
  providerId,
  providerName,
  onAuthorized,
  onSynced,
}: {
  providerId: string;
  providerName: string;
  onAuthorized?: () => void;
  onSynced?: () => void;
}) {
  const api = useApi();
  const toast = useToast();
  const [phase, setPhase] = useState<Phase>('idle');
  const [startInfo, setStartInfo] = useState<OAuthStartResponse | null>(null);
  const [complete, setComplete] = useState<Extract<OAuthPollResponse, { state: 'complete' }> | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expiredAt, setExpiredAt] = useState<string | null>(null);
  const [intervalSeconds, setIntervalSeconds] = useState(5);
  const [now, setNow] = useState(() => Date.now());
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);

  const timerRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const intervalRef = useRef(5);
  const runPollRef = useRef<(generation: number) => void>(() => {});
  const onAuthorizedRef = useRef(onAuthorized);
  const onSyncedRef = useRef(onSynced);
  onAuthorizedRef.current = onAuthorized;
  onSyncedRef.current = onSynced;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const expire = useCallback(
    (at?: string) => {
      generationRef.current += 1;
      clearTimer();
      abortRef.current?.abort();
      abortRef.current = null;
      setExpiredAt(at ?? null);
      setStartInfo(null);
      setMessage(null);
      setPhase('expired');
    },
    [clearTimer],
  );

  const schedule = useCallback(
    (delaySeconds: number, generation: number) => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        runPollRef.current(generation);
      }, Math.max(1, Math.floor(delaySeconds)) * 1000);
    },
    [clearTimer],
  );

  const runPoll = async (generation: number) => {
    if (generation !== generationRef.current) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    try {
      const response = await api<OAuthPollResponse>(
        `/api/admin/providers/${encodeURIComponent(providerId)}/oauth/poll`,
        { method: 'POST', signal: controller.signal },
      );
      if (generation !== generationRef.current) return;

      if (response.state === 'complete') {
        generationRef.current += 1;
        clearTimer();
        abortRef.current = null;
        setStartInfo(null);
        setMessage(null);
        setError(null);
        setComplete(response);
        setPhase('complete');
        setNow(Date.now());
        toast.push('OpenAI 订阅授权完成。');
        onAuthorizedRef.current?.();
        return;
      }

      if (response.state === 'pending') {
        const next = normalizeInterval(response.intervalSeconds, intervalRef.current);
        intervalRef.current = next;
        setIntervalSeconds(next);
        setMessage(response.message?.trim() || null);
        setPhase('pending');
        schedule(next, generation);
        return;
      }

      generationRef.current += 1;
      clearTimer();
      setStartInfo(null);
      setMessage(null);
      setPhase('error');
      setError('授权服务返回了无法识别的状态，请重新开始授权。');
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (generation !== generationRef.current) return;
      clearTimer();
      setStartInfo(null);
      setMessage(null);
      setPhase('error');
      setError(describeError(reason));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };
  runPollRef.current = (generation) => {
    void runPoll(generation);
  };

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      clearTimer();
      abortRef.current?.abort();
    };
  }, [clearTimer]);

  useEffect(() => {
    if (phase !== 'pending') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'pending' || !startInfo) return;
    const expires = Date.parse(startInfo.expiresAt);
    const remaining = expires - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      expire(startInfo.expiresAt);
      return;
    }
    const id = window.setTimeout(() => expire(startInfo.expiresAt), remaining + 100);
    return () => window.clearTimeout(id);
  }, [phase, startInfo, expire]);

  const start = async () => {
    generationRef.current += 1;
    const generation = generationRef.current;
    clearTimer();
    abortRef.current?.abort();
    setPhase('starting');
    setStartInfo(null);
    setComplete(null);
    setMessage(null);
    setError(null);
    setExpiredAt(null);
    setSyncResult(null);

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await api<OAuthStartResponse>(
        `/api/admin/providers/${encodeURIComponent(providerId)}/oauth/start`,
        { method: 'POST', signal: controller.signal },
      );
      if (generation !== generationRef.current) return;

      const verificationUrl = safeHttpUrl(response.verificationUrl);
      const expires = Date.parse(response.expiresAt);
      if (!response.userCode.trim() || !verificationUrl || !Number.isFinite(expires)) {
        throw new Error('授权服务返回的链接、代码或到期时间不完整。');
      }
      if (expires <= Date.now()) {
        setExpiredAt(response.expiresAt);
        setPhase('expired');
        return;
      }

      const next = normalizeInterval(response.intervalSeconds, 5);
      intervalRef.current = next;
      setIntervalSeconds(next);
      setStartInfo({ ...response, verificationUrl });
      setNow(Date.now());
      setPhase('pending');
      schedule(next, generation);
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return;
      if (generation !== generationRef.current) return;
      setPhase('error');
      setError(describeError(reason));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const cancel = () => {
    generationRef.current += 1;
    clearTimer();
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase('idle');
    setStartInfo(null);
    setMessage(null);
    setError(null);
    setExpiredAt(null);
    setComplete(null);
    setSyncResult(null);
  };

  const sync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const result = await api<SyncResult>(`/api/admin/providers/${encodeURIComponent(providerId)}/sync`, {
        method: 'POST',
      });
      setSyncResult(result);
      if (result.ok) {
        toast.push('目录与额度同步完成。');
        onSyncedRef.current?.();
      } else {
        toast.push(result.error ? `同步失败：${result.error}` : '同步失败，已保留上一次快照。', 'bad');
      }
    } catch (reason) {
      toast.push(`同步失败：${describeError(reason)}`, 'bad');
    } finally {
      setSyncing(false);
    }
  };

  const verificationUrl = startInfo ? safeHttpUrl(startInfo.verificationUrl) : null;
  const remainingSeconds = startInfo ? Math.max(0, Math.ceil((Date.parse(startInfo.expiresAt) - now) / 1000)) : 0;

  return (
    <Card title="授权 OpenAI 订阅">
      <div className="oauth-panel">
        <p className="card-lead">
          通过设备授权把 <strong>{providerName}</strong> 的订阅账号连接到服务端。设备授权 ID 与令牌只保存在服务器；浏览器只显示一次性代码、授权链接和到期时间。
        </p>

        {phase === 'idle' ? (
          <>
            <InlineNote>
              点击后才会向 OpenAI 发起设备授权。完成后可同步模型目录与额度；未完成前不会创建上游令牌。
            </InlineNote>
            <div className="oauth-actions">
              <Button variant="primary" onClick={() => void start()}>
                开始设备授权
              </Button>
            </div>
          </>
        ) : null}

        {phase === 'starting' ? (
          <div className="oauth-status" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>正在向服务端申请设备授权…</span>
          </div>
        ) : null}

        {phase === 'pending' && startInfo ? (
          <div className="oauth-session">
            <div className="oauth-status" role="status" aria-live="polite">
              <Badge tone="info">等待授权</Badge>
              <span>{message ?? '请在浏览器完成授权，页面会自动检查状态。'}</span>
            </div>

            <ol className="oauth-steps">
              <li>打开授权页面。</li>
              <li>输入下方一次性代码并确认。</li>
              <li>回到此页面，等待状态变为已授权。</li>
            </ol>

            <div className="oauth-code">
              <code>{startInfo.userCode}</code>
              <CopyButton text={startInfo.userCode} label="复制代码" />
            </div>
            <p className="small muted">代码仅用于本次授权，离开页面后需要重新开始。</p>

            <div className="oauth-actions">
              {verificationUrl ? (
                <a className="btn btn--primary btn--md" href={verificationUrl} target="_blank" rel="noreferrer noopener">
                  打开授权页面 <Icon name="link" size={15} />
                </a>
              ) : (
                <span className="small danger-text">服务端返回的授权链接无效。</span>
              )}
              <Button variant="secondary" onClick={cancel}>
                停止等待
              </Button>
            </div>

            <dl className="meta-list oauth-meta">
              <div>
                <dt>授权到期</dt>
                <dd>{formatDateTime(startInfo.expiresAt)}</dd>
              </div>
              <div>
                <dt>剩余时间</dt>
                <dd>{remainingText(remainingSeconds)}</dd>
              </div>
              <div>
                <dt>检查间隔</dt>
                <dd>每 {intervalSeconds} 秒</dd>
              </div>
              <div>
                <dt>授权地址</dt>
                <dd className="mono break">{startInfo.verificationUrl}</dd>
              </div>
            </dl>
          </div>
        ) : null}

        {phase === 'complete' && complete ? (
          <div className="oauth-session" role="status" aria-live="polite">
            <InlineNote tone="ok">
              授权完成。设备授权令牌已由服务端保存，不会显示在浏览器。
            </InlineNote>
            <dl className="meta-list oauth-meta">
              <div>
                <dt>账户 ID</dt>
                <dd className="mono break">{complete.accountId}</dd>
              </div>
              {complete.planType ? (
                <div>
                  <dt>套餐</dt>
                  <dd>{complete.planType}</dd>
                </div>
              ) : null}
              {complete.email ? (
                <div>
                  <dt>账号邮箱</dt>
                  <dd className="break">{complete.email}</dd>
                </div>
              ) : null}
              {complete.expiresAt ? (
                <div>
                  <dt>授权到期</dt>
                  <dd>{formatDateTime(complete.expiresAt)}</dd>
                </div>
              ) : null}
            </dl>
            <div className="oauth-actions">
              <Button variant="primary" icon="sync" loading={syncing} onClick={() => void sync()}>
                同步模型目录
              </Button>
              <Button variant="secondary" onClick={() => void start()}>
                重新授权
              </Button>
            </div>
            {syncResult ? (
              <div className="oauth-sync">
                <DataStateBadge state={syncResult.state} />
                <span className={syncResult.ok ? 'small muted' : 'small danger-text'}>
                  {syncResult.ok ? '目录与额度已刷新。' : syncResult.error ?? '同步失败，已保留上一次快照。'}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}

        {phase === 'expired' ? (
          <div className="oauth-session" role="alert">
            <InlineNote tone="warn">
              授权会话已过期{expiredAt ? `（原到期时间 ${formatDateTime(expiredAt)}）` : ''}。一次性代码已清除，请重新开始设备授权。
            </InlineNote>
            <div className="oauth-actions">
              <Button variant="primary" onClick={() => void start()}>
                重新开始授权
              </Button>
            </div>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="oauth-session" role="alert">
            <InlineNote tone="bad">{error ?? '授权未完成，请重试。'}</InlineNote>
            <div className="oauth-actions">
              <Button variant="primary" onClick={() => void start()}>
                重试授权
              </Button>
              <Button variant="secondary" onClick={cancel}>
                关闭
              </Button>
            </div>
          </div>
        ) : null}

        <p className="quiet-note">
          轮询严格按服务端给出的间隔进行；离开页面会停止计时器并清除一次性代码。授权过程中不会写入 localStorage。
        </p>
      </div>
    </Card>
  );
}
