import { useEffect, useRef, useState, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { confirmNavigation } from './lib/navigation-guard';

export type Route =
  | { name: 'overview' }
  | { name: 'providers' }
  | { name: 'provider-new' }
  | { name: 'provider-edit'; id: string }
  | { name: 'models' }
  | { name: 'quota' }
  | { name: 'requests' }
  | { name: 'request-detail'; id: string }
  | { name: 'bills' }
  | { name: 'devices' }
  | { name: 'settings' }
  | { name: 'login' }
  | { name: 'not-found'; path: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '') || '/';
  if (path === '/') return { name: 'overview' };
  if (path === '/login') return { name: 'login' };
  if (path === '/providers') return { name: 'providers' };
  if (path === '/providers/new') return { name: 'provider-new' };
  const providerMatch = /^\/providers\/([^/]+)\/edit$/.exec(path);
  if (providerMatch?.[1]) return { name: 'provider-edit', id: decodeURIComponent(providerMatch[1]) };
  if (path === '/models') return { name: 'models' };
  if (path === '/quota') return { name: 'quota' };
  if (path === '/requests') return { name: 'requests' };
  const requestMatch = /^\/requests\/([^/]+)$/.exec(path);
  if (requestMatch?.[1]) return { name: 'request-detail', id: decodeURIComponent(requestMatch[1]) };
  if (path === '/bills') return { name: 'bills' };
  if (path === '/devices') return { name: 'devices' };
  if (path === '/settings') return { name: 'settings' };
  return { name: 'not-found', path };
}

export function routeHref(route: Route): string {
  switch (route.name) {
    case 'overview':
      return '#/';
    case 'providers':
      return '#/providers';
    case 'provider-new':
      return '#/providers/new';
    case 'provider-edit':
      return `#/providers/${encodeURIComponent(route.id)}/edit`;
    case 'models':
      return '#/models';
    case 'quota':
      return '#/quota';
    case 'requests':
      return '#/requests';
    case 'request-detail':
      return `#/requests/${encodeURIComponent(route.id)}`;
    case 'bills':
      return '#/bills';
    case 'devices':
      return '#/devices';
    case 'settings':
      return '#/settings';
    case 'login':
      return '#/login';
    default:
      return `#${route.path}`;
  }
}

export function navigate(route: Route | string): void {
  const next = typeof route === 'string' ? route : routeHref(route);
  if (window.location.hash === next) return;
  if (!confirmNavigation()) return;
  window.location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const lastHash = useRef(window.location.hash);
  useEffect(() => {
    const onChange = () => {
      const next = window.location.hash;
      if (next === lastHash.current) return;
      if (!confirmNavigation()) {
        // 在更新路由状态前恢复地址；页面不卸载，未保存的草稿不会丢失。
        window.location.hash = lastHash.current;
        return;
      }
      lastHash.current = next;
      setRoute(parseRoute(next));
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: Route; children: ReactNode };

export function Link({ to, children, ...rest }: LinkProps) {
  return (
    <a href={routeHref(to)} {...rest}>
      {children}
    </a>
  );
}
