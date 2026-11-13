import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { describeError } from './lib/api';
import type { DataState } from './lib/contracts';

/* ------------------------------------------------------------------ icons */

export type IconName =
  | 'overview'
  | 'server'
  | 'cube'
  | 'chart'
  | 'activity'
  | 'receipt'
  | 'key'
  | 'sliders'
  | 'logout'
  | 'plus'
  | 'search'
  | 'refresh'
  | 'x'
  | 'menu'
  | 'chevron-right'
  | 'arrow-left'
  | 'check'
  | 'alert'
  | 'copy'
  | 'edit'
  | 'trash'
  | 'sync'
  | 'shield'
  | 'link';

const ICON_PATHS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <path d="M4 13a8 8 0 1 1 16 0" />
      <path d="M12 13l4-3.5" />
      <path d="M5 19h14" />
    </>
  ),
  server: (
    <>
      <rect x="3.5" y="4.5" width="17" height="6" rx="1.5" />
      <rect x="3.5" y="13.5" width="17" height="6" rx="1.5" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  cube: (
    <>
      <path d="M12 3.8 20 8v8l-8 4.2L4 16V8z" />
      <path d="m4.4 8.2 7.6 4 7.6-4M12 12.2v8" />
    </>
  ),
  chart: (
    <>
      <path d="M4 19V5M4 19h16" />
      <path d="M8 16v-4M12 16V8M16 16v-6M20 16v-2" />
    </>
  ),
  activity: <path d="M3 12h3l2.4-6 4 12 2.4-6H21" />,
  receipt: (
    <>
      <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2z" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="3.5" />
      <path d="M11.5 12H21M17 12v3M20 12v2" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 7h7M15 7h5M4 12h3M11 12h9M4 17h9M17 17h3" />
      <circle cx="13" cy="7" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="15" cy="17" r="2" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4H5v16h5" />
      <path d="M14 8l4 4-4 4M9 12h9" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 7v5h-5" />
      <path d="M19 12a7 7 0 1 0-1.8 4.8" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  alert: (
    <>
      <path d="M12 4 3.5 19h17z" />
      <path d="M12 9v4.5M12 16.5h.01" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 9V5.5A1.5 1.5 0 0 0 13.5 4H5.5A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15H9" />
    </>
  ),
  edit: (
    <>
      <path d="m4 20 4.5-1 10-10-3.5-3.5-10 10z" />
      <path d="m13.5 7 3.5 3.5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  sync: (
    <>
      <path d="M20 11a8 8 0 0 0-14.5-4M4 5v5h5" />
      <path d="M4 13a8 8 0 0 0 14.5 4M20 19v-5h-5" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5.5c0 4.2 2.8 7.6 7 9.5 4.2-1.9 7-5.3 7-9.5V6z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.5 6.3" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.3-1.3" />
    </>
  ),
};

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

/* ----------------------------------------------------------------- buttons */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: IconName;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon,
  children,
  className,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn--${variant} btn--${size}${className ? ` ${className}` : ''}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  ...rest
}: Omit<ButtonProps, 'aria-label' | 'children' | 'icon'> & { label: string; icon: IconName }) {
  return (
    <button type="button" className="icon-btn" aria-label={label} title={label} {...rest}>
      <Icon name={icon} size={17} />
    </button>
  );
}

/* ------------------------------------------------------------------ badges */

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'bad' | 'info';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

const DATA_STATE: Record<DataState, { label: string; tone: Tone }> = {
  ok: { label: '正常', tone: 'ok' },
  unknown: { label: '未知', tone: 'neutral' },
  stale: { label: '已过期', tone: 'warn' },
  error: { label: '获取失败', tone: 'bad' },
  unsupported: { label: '不支持', tone: 'info' },
};

export function DataStateBadge({ state }: { state: DataState | null | undefined }) {
  if (!state) return <Badge>未知</Badge>;
  const item = DATA_STATE[state] ?? { label: state, tone: 'neutral' as Tone };
  return <Badge tone={item.tone}>{item.label}</Badge>;
}

const REQUEST_STATUS: Array<{ match: string[]; label: string; tone: Tone }> = [
  { match: ['succeeded', 'success', 'completed', 'complete', 'ok'], label: '成功', tone: 'ok' },
  { match: ['error', 'failed', 'failure'], label: '失败', tone: 'bad' },
  { match: ['cancelled', 'canceled', 'cancel'], label: '已取消', tone: 'warn' },
  { match: ['interrupted'], label: '已中断', tone: 'warn' },
  { match: ['timeout', 'timed_out'], label: '超时', tone: 'warn' },
  { match: ['running', 'pending', 'streaming', 'in_progress'], label: '进行中', tone: 'info' },
  { match: ['partial'], label: '部分完成', tone: 'warn' },
];

export function RequestStatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <Badge>未知</Badge>;
  const normalized = status.toLowerCase();
  const found = REQUEST_STATUS.find((item) => item.match.includes(normalized));
  return <Badge tone={found?.tone ?? 'neutral'}>{found?.label ?? status}</Badge>;
}

export function EnabledBadge({ enabled }: { enabled: boolean }) {
  return <Badge tone={enabled ? 'ok' : 'neutral'}>{enabled ? '已启用' : '已停用'}</Badge>;
}

/* ------------------------------------------------------------------ layout */

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header__text">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-header__actions">{actions}</div> : null}
    </header>
  );
}

export function Card({
  title,
  action,
  children,
  className,
  flush = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  flush?: boolean;
}) {
  return (
    <section className={`card${flush ? ' card--flush' : ''}${className ? ` ${className}` : ''}`}>
      {title || action ? (
        <header className="card__head">
          {title ? <h2>{title}</h2> : <span />}
          {action ? <div className="card__action">{action}</div> : null}
        </header>
      ) : null}
      <div className="card__body">{children}</div>
    </section>
  );
}

export function SectionTitle({ title, note }: { title: string; note?: ReactNode }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {note ? <p>{note}</p> : null}
    </div>
  );
}

export function TableFrame({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={`table-frame${className ? ` ${className}` : ''}`} role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty__mark" aria-hidden="true">
        <Icon name="cube" size={22} />
      </div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="notice notice--bad" role="alert">
      <Icon name="alert" size={18} />
      <div>
        <strong>读取失败</strong>
        <p>{describeError(error)}</p>
      </div>
      {onRetry ? (
        <Button size="sm" variant="secondary" onClick={onRetry} icon="refresh">
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function LoadingBlock({ label = '正在读取网关数据' }: { label?: string }) {
  return (
    <div className="loading-block" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <span key={index} className="skeleton__row" />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ fields */

export function Field({
  label,
  id,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  id: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {error ? (
        <p className="field__error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`input${className ? ` ${className}` : ''}`} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`input select${className ? ` ${className}` : ''}`} {...rest}>
      {children}
    </select>
  );
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`input textarea${className ? ` ${className}` : ''}`} {...rest} />;
}

export function Checkbox({
  label,
  description,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; description?: ReactNode }) {
  const id = useId();
  return (
    <label className="checkbox" htmlFor={rest.id ?? id}>
      <input type="checkbox" id={rest.id ?? id} {...rest} />
      <span>
        <strong>{label}</strong>
        {description ? <small>{description}</small> : null}
      </span>
    </label>
  );
}

export function FormGrid({ children }: { children: ReactNode }) {
  return <div className="form-grid">{children}</div>;
}

export function FormActions({ children }: { children: ReactNode }) {
  return <div className="form-actions">{children}</div>;
}

export function focusFirstInvalid(): void {
  window.setTimeout(() => {
    const element = document.querySelector<HTMLElement>('[aria-invalid="true"]');
    element?.focus();
  }, 0);
}

/* ------------------------------------------------------------------ modal */

interface ModalProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  dismissible?: boolean;
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size = 'md',
  dismissible = true,
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const dismissRef = useRef(dismissible);
  dismissRef.current = dismissible;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');

    const panel = panelRef.current;
    const autofocus = panel?.querySelector<HTMLElement>('[data-autofocus]');
    const first = panel?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    window.setTimeout(() => (autofocus ?? first)?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panel) return;
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (!firstEl || !lastEl) return;
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      root?.removeAttribute('inert');
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="moris-modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      <div ref={panelRef} className={`moris-modal moris-modal--${size}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header className="moris-modal__head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p>{description}</p> : null}
          </div>
          {dismissible ? <IconButton label="关闭对话框" icon="x" onClick={onClose} /> : null}
        </header>
        <div className="moris-modal__body">{children}</div>
        {footer ? <footer className="moris-modal__foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = '确认',
  tone = 'danger',
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant={tone} onClick={onConfirm} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-copy">{description}</div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ toast */

type ToastTone = 'ok' | 'bad' | 'info';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  push: (message: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const push = useCallback((message: string, tone: ToastTone = 'ok') => {
    const id = nextId.current++;
    setItems((current) => [...current, { id, message, tone }]);
    if (tone !== 'bad') {
      window.setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== id));
      }, 4200);
    }
  }, []);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((item) => (
          <div key={item.id} className={`toast toast--${item.tone}`} role="status">
            <Icon name={item.tone === 'ok' ? 'check' : item.tone === 'bad' ? 'alert' : 'activity'} size={16} />
            <span>{item.message}</span>
            <button type="button" aria-label="关闭提示" onClick={() => dismiss(item.id)}>
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) throw new Error('useToast 必须在 ToastProvider 内使用');
  return value;
}

/* ------------------------------------------------------------------ misc */

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      window.setTimeout(() => setState('idle'), 1800);
    } catch {
      setState('failed');
      window.setTimeout(() => setState('idle'), 2400);
    }
  };

  return (
    <Button size="sm" variant="secondary" icon={state === 'copied' ? 'check' : 'copy'} onClick={copy}>
      {state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : label}
    </Button>
  );
}

export function ProgressBar({ ratio, label }: { ratio: number; label: string }) {
  const bounded = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const tone = bounded >= 0.9 ? 'bad' : bounded >= 0.75 ? 'warn' : 'accent';
  return (
    <div
      className={`progress progress--${tone}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(bounded * 100)}
      aria-label={label}
    >
      <span style={{ transform: `scaleX(${bounded})` }} />
    </div>
  );
}

export function InlineNote({
  tone = 'info',
  children,
}: {
  tone?: 'info' | 'warn' | 'bad' | 'ok';
  children: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone === 'info' ? 'info' : tone}`}>
      <Icon name={tone === 'ok' ? 'check' : tone === 'bad' ? 'alert' : 'shield'} size={18} />
      <div>{children}</div>
    </div>
  );
}
