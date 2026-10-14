import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';

/** Colour roles (DESIGN.md §9): done and verified, failed, or information. */
export type ToastTone = 'success' | 'danger' | 'info';

interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastApi {
  /** Shows a message. Success and information close themselves; a failure
   * stays until it is dismissed, so it can't be missed. */
  show: (message: string, tone?: ToastTone) => void;
}

/** How long a success or information toast stays. */
export const TOAST_DURATION_MS = 5000;

const ToastContext = createContext<ToastApi | null>(null);

const TONE: Record<ToastTone, { border: string; icon: ReactNode }> = {
  success: { border: 'border-success/30', icon: <CheckCircle2 size="1rem" className="text-success shrink-0" /> },
  danger: { border: 'border-danger/30', icon: <XCircle size="1rem" className="text-danger shrink-0" /> },
  info: { border: 'border-border', icon: <Info size="1rem" className="text-muted-foreground shrink-0" /> },
};

/**
 * Non-blocking confirmations and errors (EPOCH-455), announced to screen
 * readers: successes and information politely, failures at once. Mount once,
 * around the app; `useToast` shows one.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = nextId.current++;
      setToasts((current) => [...current, { id, tone, message }]);
      if (tone !== 'danger')
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), TOAST_DURATION_MS)
        );
    },
    [dismiss]
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach((timer) => clearTimeout(timer));
  }, []);

  const render = (items: ToastItem[]) =>
    items.map((toast) => (
      <div
        key={toast.id}
        className={`pointer-events-auto flex items-start gap-3 bg-surface-raised border ${TONE[toast.tone].border} shadow-elevation-3 rounded-lg px-4 py-3 text-data text-foreground`}
      >
        {TONE[toast.tone].icon}
        <p className="flex-1 break-words">{toast.message}</p>
        <button
          type="button"
          onClick={() => dismiss(toast.id)}
          aria-label="Dismiss"
          className="text-muted-foreground hover:text-foreground shrink-0"
        >
          <X size="1rem" />
        </button>
      </div>
    ));

  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      <div className="pointer-events-none fixed bottom-6 right-6 z-50 flex w-96 max-w-[calc(100vw-3rem)] flex-col gap-2">
        <div role="status" aria-live="polite" className="flex flex-col gap-2">
          {render(toasts.filter((t) => t.tone !== 'danger'))}
        </div>
        <div role="alert" aria-live="assertive" className="flex flex-col gap-2">
          {render(toasts.filter((t) => t.tone === 'danger'))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside ToastProvider');
  return api;
}
