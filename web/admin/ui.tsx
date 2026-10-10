// Small shared UI pieces: modal dialog, confirm, badges, progress, copy button, toasts.
import type { ComponentChildren } from 'preact';
import { createContext } from 'preact';
import { useCallback, useContext, useEffect, useId, useRef, useState } from 'preact/hooks';
import type { ItemStatus } from '../../src/types.ts';
import { fmtPercent } from './format.ts';

// ------------------------------------------------------------------------------------- modal

export function Modal(props: { open: boolean; title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);
  return (
    <dialog
      ref={ref}
      class={props.wide ? 'modal modal-wide' : 'modal'}
      aria-labelledby={titleId}
      onClose={props.onClose}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      {props.open && (
        <div class="modal-body">
          <header class="modal-head">
            <h2 id={titleId}>{props.title}</h2>
            <button type="button" class="btn-icon" aria-label="Close" onClick={props.onClose}>
              ×
            </button>
          </header>
          {props.children}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  message: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (props.open) setError(null);
  }, [props.open]);
  return (
    <Modal open={props.open} title={props.title} onClose={props.onClose}>
      <div class="confirm-message">{props.message}</div>
      {error && <p class="form-error" role="alert">{error}</p>}
      <div class="actions">
        <button type="button" class="btn" onClick={props.onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          class={props.danger ? 'btn btn-danger' : 'btn btn-primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await props.onConfirm();
              props.onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Working…' : props.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------ badges

const STATUS_LABEL: Record<ItemStatus, string> = {
  incoming: 'Incoming',
  stabilising: 'Settling',
  hashing: 'Hashing',
  snapshotting: 'Snapshotting',
  ready: 'Ready',
  error: 'Error',
  deleted: 'Deleted',
};

const STATUS_HINT: Record<ItemStatus, string> = {
  incoming: 'Arriving from the PC',
  stabilising: 'Waiting until the files stop changing',
  hashing: 'Building the torrent',
  snapshotting: 'Waiting for a snapshot to cover it',
  ready: 'Ready to share',
  error: 'Needs attention',
  deleted: 'Deleted',
};

export function StatusBadge(props: { status: ItemStatus; progress: number | null }) {
  const label = props.status === 'hashing' && props.progress !== null ? `Hashing ${fmtPercent(props.progress)}` : STATUS_LABEL[props.status];
  return (
    <span class={`badge badge-${props.status}`} title={STATUS_HINT[props.status]}>
      {label}
    </span>
  );
}

export function Progress(props: { value: number; label: string; warn?: boolean }) {
  const v = Math.max(0, Math.min(1, Number.isFinite(props.value) ? props.value : 0));
  return (
    <div
      class={props.warn ? 'progress progress-warn' : 'progress'}
      role="progressbar"
      aria-label={props.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(v * 100)}
    >
      <div class="progress-fill" style={{ width: `${(v * 100).toFixed(1)}%` }} />
    </div>
  );
}

// -------------------------------------------------------------------------------------- copy

export function CopyButton(props: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="btn btn-small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(props.text);
        } catch {
          // Fallback: select a temporary textarea.
          const ta = document.createElement('textarea');
          ta.value = props.text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      <span aria-live="polite">{copied ? 'Copied' : (props.label ?? 'Copy')}</span>
    </button>
  );
}

// ------------------------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}
type Notify = (text: string, kind?: 'ok' | 'error') => void;
const ToastCtx = createContext<Notify>(() => undefined);
export const useNotify = (): Notify => useContext(ToastCtx);

export function ToastProvider(props: { children: ComponentChildren }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const notify = useCallback<Notify>((text, kind = 'ok') => {
    const id = ++seq.current;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={notify}>
      {props.children}
      <div class="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} class={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
