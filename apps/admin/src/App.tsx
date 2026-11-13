import { useEffect } from 'react';
import { useAuth } from './auth';
import { Layout } from './Layout';
import { navigate, useRoute, type Route } from './router';
import { Button, Icon } from './ui';
import { LoginPage } from './pages/Login';
import { OverviewPage } from './pages/Overview';
import { ProvidersPage } from './pages/Providers';
import { ProviderEditPage } from './pages/ProviderEdit';
import { ModelsPage } from './pages/Models';
import { QuotaPage } from './pages/Quota';
import { RequestsPage } from './pages/Requests';
import { RequestDetailPage } from './pages/RequestDetail';
import { BillsPage } from './pages/Bills';
import { DevicesPage } from './pages/Devices';
import { SettingsPage } from './pages/Settings';

const TITLES: Record<Route['name'], string> = {
  overview: '概览',
  providers: '供应商',
  'provider-new': '新增供应商',
  'provider-edit': '编辑供应商',
  models: '模型目录',
  quota: '余额与额度',
  requests: '请求记录',
  'request-detail': '请求详情',
  bills: '人民币账单',
  devices: '设备密钥',
  settings: '设置',
  login: '登录',
  'not-found': '页面不存在',
};

function Splash({ label = '正在建立会话' }: { label?: string }) {
  return (
    <div className="splash" role="status" aria-live="polite">
      <span className="splash__mark" aria-hidden="true">
        <Icon name="activity" size={22} />
      </span>
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

function NotFoundPage({ route }: { route: Route }) {
  return (
    <div className="page">
      <div className="not-found">
        <p className="eyebrow">404</p>
        <h1>没有这个页面</h1>
        <p>
          地址 <code>{route.name === 'not-found' ? route.path : ''}</code> 不属于控制台路由。
        </p>
        <Button variant="primary" onClick={() => navigate('#/')}>
          回到概览
        </Button>
      </div>
    </div>
  );
}

function RouteView({ route }: { route: Route }) {
  switch (route.name) {
    case 'overview':
      return <OverviewPage />;
    case 'providers':
      return <ProvidersPage />;
    case 'provider-new':
      return <ProviderEditPage mode="new" />;
    case 'provider-edit':
      return <ProviderEditPage mode="edit" id={route.id} />;
    case 'models':
      return <ModelsPage />;
    case 'quota':
      return <QuotaPage />;
    case 'requests':
      return <RequestsPage />;
    case 'request-detail':
      return <RequestDetailPage id={route.id} />;
    case 'bills':
      return <BillsPage />;
    case 'devices':
      return <DevicesPage />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <NotFoundPage route={route} />;
  }
}

export function App() {
  const route = useRoute();
  const { ready, session } = useAuth();

  useEffect(() => {
    document.title = `${TITLES[route.name]} · MorisLLMGateway`;
  }, [route.name]);

  useEffect(() => {
    if (ready && session && route.name === 'login') navigate('#/');
  }, [ready, session, route.name]);

  if (!ready) return <Splash />;

  if (!session) {
    return <LoginPage />;
  }

  if (route.name === 'login') return <Splash label="正在回到控制台" />;

  return (
    <Layout route={route}>
      <RouteView route={route} />
    </Layout>
  );
}
