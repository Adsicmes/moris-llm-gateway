import { useCallback, useEffect, useRef } from 'react';
import { setNavigationGuard } from './navigation-guard';

/**
 * 有未保存修改时阻止关闭页面，并在站内路由切换前确认。
 * 路由守卫在 hash 真正切换前生效，因此被取消时组件不会卸载，草稿保持原样。
 */
export function useUnsavedChanges(
  dirty: boolean,
  message = '有未保存的修改，离开会丢失。确定离开吗？',
): { allowNavigation: () => void } {
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const allowedRef = useRef(false);
  const messageRef = useRef(message);
  messageRef.current = message;

  useEffect(() => {
    if (!dirty) {
      allowedRef.current = false;
      return;
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const guard = () => {
      if (allowedRef.current || !dirtyRef.current) return true;
      return window.confirm(messageRef.current);
    };
    setNavigationGuard(guard);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      setNavigationGuard(null);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [dirty]);

  const allowNavigation = useCallback(() => {
    allowedRef.current = true;
  }, []);

  return { allowNavigation };
}
