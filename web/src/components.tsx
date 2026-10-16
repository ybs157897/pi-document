import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertCircle, Check, ChevronRight, LoaderCircle, X } from 'lucide-react';

export function Button({
  children, variant = 'secondary', size = 'md', className = '', ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'quiet' | 'danger'; size?: 'sm' | 'md' }) {
  return <button {...props} type={props.type ?? 'button'} className={`button button--${variant} button--${size} ${className}`.trim()}>{children}</button>;
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} type={props.type ?? 'button'} className={`icon-button ${className}`.trim()} aria-label={label} title={label}>{children}</button>;
}

export function PageHeading({ title, description, eyebrow, actions }: { title: string; description?: ReactNode; eyebrow?: string; actions?: ReactNode }) {
  return <div className="page-heading">
    <div className="page-heading__text">
      {eyebrow && <p className="eyebrow">{eyebrow}</p>}
      <h1>{title}</h1>
      {description && <p className="page-heading__description">{description}</p>}
    </div>
    {actions && <div className="page-heading__actions">{actions}</div>}
  </div>;
}

export function SectionHeading({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <div className="section-heading">
    <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
    {actions && <div className="section-heading__actions">{actions}</div>}
  </div>;
}

export function Alert({ children, tone = 'error', title, onDismiss }: { children: ReactNode; tone?: 'error' | 'info' | 'success' | 'warning'; title?: string; onDismiss?: () => void }) {
  const Icon = tone === 'success' ? Check : tone === 'info' ? AlertCircle : AlertCircle;
  return <div className={`alert alert--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon size={17} aria-hidden="true" />
    <div className="alert__body">{title && <strong>{title}</strong>}<div>{children}</div></div>
    {onDismiss && <IconButton label="关闭提示" onClick={onDismiss}><X size={16} aria-hidden="true" /></IconButton>}
  </div>;
}

export function StatusPill({ label, tone = 'neutral', dot = false }: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info'; dot?: boolean }) {
  return <span className={`status-pill status-pill--${tone}`}>{dot && <span className="status-pill__dot" aria-hidden="true" />}{label}</span>;
}

export function LoadingState({ label = '正在加载…' }: { label?: string }) {
  return <div className="state-block" role="status" aria-live="polite"><LoaderCircle className="spin" size={22} aria-hidden="true" /><span>{label}</span></div>;
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: string; action?: ReactNode; icon?: ReactNode }) {
  return <div className="empty-state">
    {icon && <div className="empty-state__icon" aria-hidden="true">{icon}</div>}
    <h3>{title}</h3>
    {description && <p>{description}</p>}
    {action && <div className="empty-state__action">{action}</div>}
  </div>;
}

export function Dialog({
  open, title, description, onClose, children, className = '', labelledBy, footer,
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = labelledBy ?? `dialog-title-${title.replace(/[^a-z0-9\u4e00-\u9fff]+/gi, '-').toLowerCase()}`;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
    return () => { if (dialog.open) dialog.close(); };
  }, [open]);
  return <dialog
    ref={ref}
    className={`dialog ${className}`.trim()}
    aria-labelledby={id}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
  >
    <div className="dialog__layout">
      <header className="dialog__header">
        <div><h2 id={id}>{title}</h2>{description && <p>{description}</p>}</div>
        <IconButton label="关闭窗口" onClick={onClose}><X size={18} aria-hidden="true" /></IconButton>
      </header>
      <div className="dialog__body">{children}</div>
      {footer && <footer className="dialog__footer">{footer}</footer>}
    </div>
  </dialog>;
}

export function InlineLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button type="button" className="inline-link" onClick={onClick}>{children}<ChevronRight size={15} aria-hidden="true" /></button>;
}

export function Field({ label, hint, error, htmlFor, required, children }: { label: string; hint?: string; error?: string; htmlFor: string; required?: boolean; children: ReactNode }) {
  const hintId = `${htmlFor}-hint`;
  const errorId = `${htmlFor}-error`;
  return <div className="field">
    <label htmlFor={htmlFor}>{label}{required && <span className="required-mark" aria-label="必填"> *</span>}</label>
    {children}
    {error && <p className="field__error" id={errorId} role="alert">{error}</p>}
    {hint && <p className="field__hint" id={hintId}>{hint}</p>}
  </div>;
}

export function fieldDescription(hint?: string, error?: string): string | undefined {
  if (hint && error) return undefined;
  return error ? undefined : hint;
}

export function CopyButton({ value, onCopy, label = '复制' }: { value: string; onCopy: (message: string) => void; label?: string }) {
  return <Button variant="secondary" size="sm" onClick={async () => {
    try { await navigator.clipboard.writeText(value); onCopy('已复制到剪贴板'); }
    catch { onCopy('浏览器未允许复制，请手动选择并复制'); }
  }}><span>{label}</span></Button>;
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="visually-hidden">{children}</span>;
}
