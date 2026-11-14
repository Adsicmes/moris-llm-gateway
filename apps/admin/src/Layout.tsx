import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './auth';
import { Link, navigate, type Route } from './router';
import { Button, Icon, IconButton, type IconName } from './ui';

interface NavItem {
  route: Route;
  label: string;
  icon: IconName;
  match: (route: Route) => boolean;
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: '运行',
    items: [
      { route: { name: 'overview' }, label: '概览', icon: 'overview', match: (route) => route.name === 'overview' },
      { route: { name: 'requests' }, label: '请求记录', icon: 'activity', match: (route) => route.name === 'requests' || route.name === 'request-detail' },
    ],
  },
  {
    label: '路由目录',
    items: [
      { route: { name: 'models' }, label: '模型目录', icon: 'cube', match: (route) => route.name === 'models' },
      { route: { name: 'quota' }, label: '余额与额度', icon: 'chart', match: (route) => route.name === 'quota' },
      { route: { name: 'proxies' }, label: '代理配置', icon: 'server', match: (route) => route.name === 'proxies' },
      {
        route: { name: 'providers' },
        label: '供应商',
        icon: 'server',
        match: (route) => route.name === 'providers' || route.name === 'provider-new' || route.name === 'provider-edit',
      },
    ],
  },
  {
    label: '账务',
    items: [{ route: { name: 'bills' }, label: '人民币账单', icon: 'receipt', match: (route) => route.name === 'bills' }],
  },
  {
    label: '访问',
    items: [{ route: { name: 'devices' }, label: '设备密钥', icon: 'key', match: (route) => route.name === 'devices' }],
  },
  {
    label: '系统',
    items: [{ route: { name: 'settings' }, label: '设置', icon: 'sliders', match: (route) => route.name === 'settings' }],
  },
];

function BrandMark() {
  return (
    <span className="brand__mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="30" height="30" fill="none">
        <rect x="0.5" y="0.5" width="31" height="31" rx="8" stroke="currentColor" opacity="0.24" />
        <path d="M8 10h6l4 6 4-6h2M8 22h6l4-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="8" cy="10" r="1.6" fill="currentColor" />
        <circle cx="8" cy="22" r="1.6" fill="currentColor" />
        <circle cx="24" cy="10" r="1.6" fill="currentColor" />
      </svg>
    </span>
  );
}

function Sidebar({ route, onNavigate }: { route: Route; onNavigate: () => void }) {
  const { session, logout } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);

  return (
    <aside className="sidebar" aria-label="主导航">
      <div className="brand">
        <BrandMark />
        <span className="brand__text">
          <strong>MorisLLMGateway</strong>
          <small>路由控制台</small>
        </span>
      </div>

      <nav className="nav">
        {NAV_GROUPS.map((group) => (
          <div className="nav__group" key={group.label}>
            <p className="nav__label">{group.label}</p>
            {group.items.map((item) => {
              const active = item.match(route);
              return (
                <Link
                  key={item.label}
                  to={item.route}
                  className={`nav__item${active ? ' is-active' : ''}`}
                  aria-current={active ? 'page' : undefined}
                  onClick={onNavigate}
                >
                  <Icon name={item.icon} size={18} />
                  <span>{item.label}</span>
                  {active ? <span className="nav__rail" aria-hidden="true" /> : null}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="sidebar__foot">
        <div className="session">
          <Icon name="shield" size={16} />
          <span>
            <small>管理员会话</small>
            <strong>{session?.username ?? '—'}</strong>
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          icon="logout"
          loading={loggingOut}
          onClick={async () => {
            setLoggingOut(true);
            await logout();
          }}
        >
          退出登录
        </Button>
      </div>
    </aside>
  );
}

export function Layout({ route, children }: { route: Route; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  useEffect(() => {
    setMenuOpen(false);
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    const main = document.getElementById('main');
    main?.focus({ preventScroll: true });
  }, [route]);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        跳到主要内容
      </a>

      <div id="mobile-nav" className={`sidebar-wrap${menuOpen ? ' is-open' : ''}`}>
        <Sidebar route={route} onNavigate={() => setMenuOpen(false)} />
      </div>
      {menuOpen ? <button type="button" className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMenuOpen(false)} /> : null}

      <div className="shell__main">
        <header className="mobile-bar">
          <button type="button" className="mobile-bar__brand" onClick={() => navigate('#/')} aria-label="回到概览">
            <BrandMark />
            <span>Moris</span>
          </button>
          <IconButton
            label={menuOpen ? '关闭导航' : '打开导航'}
            icon={menuOpen ? 'x' : 'menu'}
            aria-expanded={menuOpen}
            aria-controls="mobile-nav"
            onClick={() => setMenuOpen((value) => !value)}
          />
        </header>
        <main id="main" className="main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
