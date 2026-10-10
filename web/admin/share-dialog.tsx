// Create-share and edit-share dialogs, with the shared expiry picker.
import { useEffect, useId, useState } from 'preact/hooks';
import type { ItemDto, ShareDto } from '../../src/types.ts';
import { api, errorMessage } from './api.ts';
import { fmtDate, fromLocalInput, toLocalInput } from './format.ts';
import { CopyButton, Modal } from './ui.tsx';

const DAY = 86_400_000;
type Preset = 'never' | '1d' | '7d' | '30d' | 'custom';
const PRESETS: { id: Preset; label: string; ms?: number }[] = [
  { id: '1d', label: '1 day', ms: DAY },
  { id: '7d', label: '7 days', ms: 7 * DAY },
  { id: '30d', label: '30 days', ms: 30 * DAY },
  { id: 'never', label: 'Never' },
  { id: 'custom', label: 'Custom…' },
];

export interface ExpiryValue {
  preset: Preset;
  custom: string; // datetime-local
}

/** Resolves the picker to a timestamp (null = never) or an error message. */
export function resolveExpiry(v: ExpiryValue, now = Date.now()): { ok: true; value: number | null } | { ok: false; error: string } {
  if (v.preset === 'never') return { ok: true, value: null };
  if (v.preset === 'custom') {
    const t = fromLocalInput(v.custom);
    if (t === null) return { ok: false, error: 'Pick a date and time for the expiry.' };
    if (t <= now + 60_000) return { ok: false, error: 'The expiry must be in the future.' };
    if (t > now + 3650 * DAY) return { ok: false, error: 'The expiry can be at most 10 years ahead.' };
    return { ok: true, value: t };
  }
  return { ok: true, value: now + PRESETS.find((p) => p.id === v.preset)!.ms! };
}

export function ExpiryPicker(props: { value: ExpiryValue; onChange: (v: ExpiryValue) => void; legend?: string }) {
  const name = useId();
  const customId = useId();
  return (
    <fieldset class="field">
      <legend>{props.legend ?? 'Link expires'}</legend>
      <div class="segmented">
        {PRESETS.map((p) => (
          <label key={p.id} class={props.value.preset === p.id ? 'seg seg-on' : 'seg'}>
            <input
              type="radio"
              name={name}
              value={p.id}
              checked={props.value.preset === p.id}
              onChange={() =>
                props.onChange({ preset: p.id, custom: props.value.custom || toLocalInput(Date.now() + 7 * DAY) })
              }
            />
            {p.label}
          </label>
        ))}
      </div>
      {props.value.preset === 'custom' && (
        <div class="field-inline">
          <label for={customId}>Expires at (your local time)</label>
          <input
            id={customId}
            type="datetime-local"
            value={props.value.custom}
            min={toLocalInput(Date.now())}
            onInput={(e) => props.onChange({ ...props.value, custom: (e.target as HTMLInputElement).value })}
          />
        </div>
      )}
    </fieldset>
  );
}

function PasswordInput(props: { id: string; value: string; onInput: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div class="password-row">
      <input
        id={props.id}
        type={show ? 'text' : 'password'}
        autocomplete="new-password"
        maxLength={200}
        value={props.value}
        placeholder={props.placeholder}
        onInput={(e) => props.onInput((e.target as HTMLInputElement).value)}
      />
      <button type="button" class="btn btn-small" aria-pressed={show} onClick={() => setShow(!show)}>
        {show ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

// ------------------------------------------------------------------------------- create share

export function ShareDialog(props: { item: ItemDto | null; onClose: () => void; onCreated: (s: ShareDto) => void }) {
  const [password, setPassword] = useState('');
  const [expiry, setExpiry] = useState<ExpiryValue>({ preset: '7d', custom: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<ShareDto | null>(null);
  const pwId = useId();

  useEffect(() => {
    if (props.item) {
      setPassword('');
      setExpiry({ preset: '7d', custom: '' });
      setError(null);
      setCreated(null);
    }
  }, [props.item?.id]);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!props.item) return;
    const exp = resolveExpiry(expiry);
    if (!exp.ok) return setError(exp.error);
    setBusy(true);
    setError(null);
    try {
      const body: { itemId: string; password?: string; expiresAt?: number } = { itemId: props.item.id };
      if (password) body.password = password;
      if (exp.value !== null) body.expiresAt = exp.value;
      const share = await api<ShareDto>('POST', '/api/admin/shares', body);
      setCreated(share);
      setPassword('');
      props.onCreated(share);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={props.item !== null} title={created ? 'Link ready' : `Share “${props.item?.name ?? ''}”`} onClose={props.onClose}>
      {created ? (
        <div>
          <p>Anyone with this link can download <strong>{created.itemName}</strong>
            {created.hasPassword ? ' after entering the password' : ''}.</p>
          <div class="link-row">
            <input type="text" readOnly value={created.url} aria-label="Share link" onFocus={(e) => (e.target as HTMLInputElement).select()} />
            <CopyButton text={created.url} label="Copy link" />
          </div>
          <p class="muted">
            {created.expiresAt ? `Expires ${fmtDate(created.expiresAt)}.` : 'Never expires.'}
            {created.hasPassword ? ' Send the password separately from the link.' : ''}
          </p>
          <div class="actions">
            <button type="button" class="btn btn-primary" onClick={props.onClose}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div class="field">
            <label for={pwId}>Password (optional)</label>
            <PasswordInput id={pwId} value={password} onInput={setPassword} placeholder="No password" />
            <p class="hint">Recipients must enter it before downloading. 1–200 characters.</p>
          </div>
          <ExpiryPicker value={expiry} onChange={setExpiry} />
          {error && <p class="form-error" role="alert">{error}</p>}
          <div class="actions">
            <button type="button" class="btn" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" disabled={busy}>
              {busy ? 'Creating…' : 'Create link'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

// --------------------------------------------------------------------------------- edit share

type PwMode = 'keep' | 'set' | 'remove';

export function EditShareDialog(props: { share: ShareDto | null; onClose: () => void; onSaved: (s: ShareDto) => void }) {
  const [pwMode, setPwMode] = useState<PwMode>('keep');
  const [password, setPassword] = useState('');
  const [changeExpiry, setChangeExpiry] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryValue>({ preset: '7d', custom: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pwId = useId();
  const pwName = useId();

  useEffect(() => {
    if (props.share) {
      setPwMode('keep');
      setPassword('');
      setChangeExpiry(false);
      setExpiry(
        props.share.expiresAt ? { preset: 'custom', custom: toLocalInput(props.share.expiresAt) } : { preset: 'never', custom: '' },
      );
      setError(null);
    }
  }, [props.share?.id]);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (!props.share) return;
    const patch: { password?: string | null; expiresAt?: number | null } = {};
    if (pwMode === 'set') {
      if (!password) return setError('Enter the new password, or choose “Keep”.');
      patch.password = password;
    } else if (pwMode === 'remove') patch.password = null;
    if (changeExpiry) {
      const exp = resolveExpiry(expiry);
      if (!exp.ok) return setError(exp.error);
      patch.expiresAt = exp.value;
    }
    if (Object.keys(patch).length === 0) return props.onClose();
    setBusy(true);
    setError(null);
    try {
      const s = await api<ShareDto>('PATCH', `/api/admin/shares/${encodeURIComponent(props.share.id)}`, patch);
      props.onSaved(s);
      props.onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const share = props.share;
  return (
    <Modal open={share !== null} title="Edit share" onClose={props.onClose}>
      {share && (
        <form onSubmit={submit}>
          <p class="muted">
            {share.itemName} · currently {share.hasPassword ? 'password-protected' : 'no password'} ·{' '}
            {share.expiresAt ? `expires ${fmtDate(share.expiresAt)}` : 'never expires'}
          </p>
          <fieldset class="field">
            <legend>Password</legend>
            <div class="segmented">
              {(['keep', 'set', 'remove'] as PwMode[]).map((m) => (
                <label key={m} class={pwMode === m ? 'seg seg-on' : 'seg'}>
                  <input type="radio" name={pwName} value={m} checked={pwMode === m} onChange={() => setPwMode(m)} disabled={m === 'remove' && !share.hasPassword} />
                  {m === 'keep' ? 'Keep' : m === 'set' ? (share.hasPassword ? 'Change' : 'Add') : 'Remove'}
                </label>
              ))}
            </div>
            {pwMode === 'set' && (
              <div class="field-inline">
                <label for={pwId}>New password</label>
                <PasswordInput id={pwId} value={password} onInput={setPassword} />
              </div>
            )}
            {pwMode !== 'keep' && <p class="hint">Changing the password signs out everyone who already unlocked the link.</p>}
          </fieldset>
          <label class="check">
            <input type="checkbox" checked={changeExpiry} onChange={(e) => setChangeExpiry((e.target as HTMLInputElement).checked)} />
            Change expiry
          </label>
          {changeExpiry && <ExpiryPicker value={expiry} onChange={setExpiry} legend="New expiry" />}
          {error && <p class="form-error" role="alert">{error}</p>}
          <div class="actions">
            <button type="button" class="btn" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" class="btn btn-primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
