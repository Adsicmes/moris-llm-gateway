import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { ApiError, describeError } from '../lib/api';
import { navigate } from '../router';
import { Button, Icon, Input } from '../ui';

export function LoginPage() {
  const { login, bootError, retrySession } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = '登录 · MorisLLMGateway';
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('请输入管理员账号和密码。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      setPassword('');
      if (window.location.hash === '#/login' || !window.location.hash) navigate('#/');
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        setError('账号或密码不正确。');
      } else if (reason instanceof ApiError && reason.status === 429) {
        setError(reason.message || '登录尝试过于频繁，请稍后再试。');
      } else {
        setError(describeError(reason));
      }
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <section className="login__aside" aria-label="网关说明">
        <div className="login__brand">
          <span className="brand__mark" aria-hidden="true">
            <svg viewBox="0 0 32 32" width="34" height="34" fill="none">
              <rect x="0.5" y="0.5" width="31" height="31" rx="8" stroke="currentColor" opacity="0.24" />
              <path d="M8 10h6l4 6 4-6h2M8 22h6l4-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="8" cy="10" r="1.6" fill="currentColor" />
              <circle cx="8" cy="22" r="1.6" fill="currentColor" />
              <circle cx="24" cy="10" r="1.6" fill="currentColor" />
            </svg>
          </span>
          <span>
            <strong>MorisLLMGateway</strong>
            <small>单管理员 · 单实例</small>
          </span>
        </div>

        <div className="login__statement">
          <p className="eyebrow">路由控制台</p>
          <h1>一条请求，<br />一条可追溯的路。</h1>
          <p>
            目录、重试、余额、请求与账单在同一处核对。供应商凭据只留在服务端，设备密钥与后台管理权限分开。
          </p>
        </div>

        <div className="route-sketch" aria-hidden="true">
          <div className="route-sketch__lane">
            <span className="route-sketch__node">设备</span>
            <span className="route-sketch__line" />
            <span className="route-sketch__node route-sketch__node--main">网关</span>
            <span className="route-sketch__line route-sketch__line--split" />
            <span className="route-sketch__stack">
              <span>供应商 A</span>
              <span>供应商 B</span>
              <span>回退目标</span>
            </span>
          </div>
          <div className="route-sketch__labels">
            <span>目录快照</span>
            <span>有限重试</span>
            <span>独立账本</span>
          </div>
        </div>

        <p className="login__foot">仅限管理员密码会话访问。设备密钥不授予后台权限。</p>
      </section>

      <main className="login__panel">
        <div className="login__card">
          <div className="login__mobile-brand">
            <span className="brand__mark" aria-hidden="true">
              <Icon name="activity" size={20} />
            </span>
            <strong>MorisLLMGateway</strong>
          </div>
          <p className="eyebrow">管理员登录</p>
          <h2>进入路由控制台</h2>
          <p className="login__lead">使用管理员账号密码建立浏览器会话。</p>

          {bootError ? (
            <div className="notice notice--bad" role="alert">
              <Icon name="alert" size={18} />
              <div>
                <strong>网关未响应</strong>
                <p>{bootError}</p>
                <Button size="sm" variant="secondary" onClick={() => void retrySession()}>
                  重试连接
                </Button>
              </div>
            </div>
          ) : null}

          <form className="login__form" onSubmit={submit} noValidate>
            <div className="field">
              <label htmlFor="login-username">管理员账号</label>
              <Input
                id="login-username"
                name="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="admin"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="login-password">密码</label>
              <Input
                id="login-password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <Button type="submit" variant="primary" loading={busy} className="login__submit">
              登录控制台
            </Button>
          </form>

          <p className="login__secure">
            <Icon name="shield" size={14} />
            HttpOnly 会话 Cookie，CSRF 仅保存在当前页面内存。
          </p>
        </div>
      </main>
    </div>
  );
}
