import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { apiRequest, ApiError, describeError, type ApiRequestOptions } from './lib/api';
import type { Session } from './types';
import { navigate } from './router';

interface AuthContextValue {
  session: Session | null;
  ready: boolean;
  bootError: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  retrySession: () => Promise<void>;
  handleUnauthorized: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const retrySession = useCallback(async () => {
    setBootError(null);
    try {
      const next = await apiRequest<Session>('/api/auth/session');
      setSession(next);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setSession(null);
      } else {
        setBootError(describeError(error));
      }
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void retrySession();
  }, [retrySession]);

  const handleUnauthorized = useCallback(() => {
    setSession(null);
    if (window.location.hash !== '#/login') navigate('#/login', { force: true });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const next = await apiRequest<Session>('/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    setSession(next);
    setBootError(null);
  }, []);

  const logout = useCallback(async () => {
    const csrfToken = session?.csrfToken;
    try {
      if (csrfToken) {
        await apiRequest('/api/auth/logout', { method: 'POST', csrfToken });
      }
    } catch {
      // 会话已经失效时也要清掉本地状态，避免停在半登录界面。
    } finally {
      setSession(null);
      navigate('#/login', { force: true });
    }
  }, [session?.csrfToken]);

  const value = useMemo<AuthContextValue>(
    () => ({ session, ready, bootError, login, logout, retrySession, handleUnauthorized }),
    [session, ready, bootError, login, logout, retrySession, handleUnauthorized],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return value;
}

/** 所有需要登录的读写都走这里：附带内存中的 CSRF，401 时统一回登录页。 */
export function useApi() {
  const { session, handleUnauthorized } = useAuth();

  return useCallback(
    async <T,>(path: string, options: ApiRequestOptions = {}): Promise<T> => {
      try {
        return await apiRequest<T>(path, { ...options, csrfToken: session?.csrfToken });
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          handleUnauthorized();
        }
        throw error;
      }
    },
    [session?.csrfToken, handleUnauthorized],
  );
}
