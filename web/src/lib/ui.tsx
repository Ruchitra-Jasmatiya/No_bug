import { AnimatePresence, motion } from 'framer-motion';
import { AlertTriangle, CheckCircle2, Eye, EyeOff, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';

/* ---------------------------------------------------------------- toasts */
interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}
const ToastCtx = createContext<(text: string, kind?: 'ok' | 'error') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-3), { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div key={t.id} className={`toast ${t.kind === 'error' ? 'toast-error' : ''}`} initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 40 }} transition={{ type: 'spring', stiffness: 400, damping: 30 }}>
              {t.kind === 'ok' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------------------------------------------------------- modal */
export function Modal({ open, onClose, title, children, dismissible = true, labelledBy }: { open: boolean; onClose: () => void; title: string; children: ReactNode; dismissible?: boolean; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('button, [href], input, select, textarea');
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dismissible) onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input, select, textarea')];
        if (f.length === 0) return;
        const a = f[0]!;
        const z = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === a) (e.preventDefault(), z.focus());
        else if (!e.shiftKey && document.activeElement === z) (e.preventDefault(), a.focus());
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open, onClose, dismissible]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && dismissible && onClose()}>
          <motion.div ref={ref} className="modal" role="dialog" aria-modal="true" aria-labelledby={labelledBy ?? titleId} initial={{ y: 28, scale: 0.97, opacity: 0 }} animate={{ y: 0, scale: 1, opacity: 1 }} exit={{ y: 20, opacity: 0 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}>
            <div className="row spread" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <h2 id={titleId}>{title}</h2>
              {dismissible && (
                <button className="btn btn-ghost btn-icon btn-sm" onClick={onClose} aria-label="Close">
                  <X size={18} />
                </button>
              )}
            </div>
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ---------------------------------------------------------------- small pieces */
export function Notice({ kind = 'info', children }: { kind?: 'info' | 'error' | 'ok'; children: ReactNode }) {
  const Icon = kind === 'error' ? AlertTriangle : kind === 'ok' ? CheckCircle2 : Info;
  return (
    <div className={`notice ${kind === 'error' ? 'notice-error' : kind === 'ok' ? 'notice-ok' : ''}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={18} />
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span role="status" className="row" style={{ gap: 10 }}>
      <span className="spinner" />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export function PageLoader({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="empty" style={{ minHeight: '40vh' }}>
      <Spinner label={label} />
      <p className="muted">{label}…</p>
    </div>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`sev sev-${severity}`}>{severity}</span>;
}

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string | null; hint?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <span className="field-error" id={`${htmlFor}-err`}>{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </div>
  );
}

export function PasswordInput({ id, value, onChange, autoComplete, invalid, placeholder }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; invalid?: boolean; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="input-wrap">
      <input id={id} className="input" type={show ? 'text' : 'password'} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-err` : undefined} placeholder={placeholder} />
      <button type="button" className="btn btn-ghost btn-icon btn-sm eye" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}>
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} — NO BUGS ALLOWED`;
  }, [title]);
}

/** Runs `fn` now and every `ms` while the tab is visible. Returns nothing; cleans up on unmount. */
export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}
