import { useEffect, useState } from 'preact/hooks';
import type { UnlockResponse } from '../../src/types.ts';
import { clearSession, getShareStatus, loadSession, saveSession, shareIdFromLocation, unlock } from './api.ts';
import { ShareView } from './ShareView.tsx';

type Screen =
  | { k: 'loading' }
  | { k: 'gone' }
  | { k: 'locked'; notice?: string }
  | { k: 'error'; message: string }
  | { k: 'share'; info: UnlockResponse }
  | { k: 'revoked'; hadStarted: boolean };

export function App() {
  const [shareId] = useState(() => shareIdFromLocation(location.pathname));
  const [screen, setScreen] = useState<Screen>({ k: 'loading' });

  const boot = async (): Promise<void> => {
    if (!shareId) {
      setScreen({ k: 'gone' });
      return;
    }
    setScreen({ k: 'loading' });
    try {
      const status = await getShareStatus(shareId);
      if (status.status === 'gone') {
        clearSession(shareId);
        setScreen({ k: 'gone' });
        return;
      }
      const saved = loadSession(shareId);
      if (saved) {
        setScreen({ k: 'share', info: saved });
        return;
      }
      if (status.status === 'open' && !status.passwordRequired) {
        const r = await unlock(shareId);
        if (r.ok) {
          saveSession(shareId, r.data);
          setScreen({ k: 'share', info: r.data });
        } else if (r.reason === 'gone') setScreen({ k: 'gone' });
        else if (r.reason === 'bad_password') setScreen({ k: 'locked' });
        else setScreen({ k: 'error', message: "We couldn't open this link right now." });
        return;
      }
      setScreen({ k: 'locked' });
    } catch {
      setScreen({ k: 'error', message: "We couldn't reach the server. Check your connection and try again." });
    }
  };

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    document.title = screen.k === 'share' ? `${screen.info.name} · fileshare` : 'fileshare';
  }, [screen]);

  return (
    <main class="page">
      {screen.k === 'loading' && <Loading />}
      {screen.k === 'gone' && <Gone />}
      {screen.k === 'error' && <ErrorScreen message={screen.message} onRetry={() => void boot()} />}
      {screen.k === 'locked' && shareId && (
        <Locked
          shareId={shareId}
          notice={screen.notice}
          onUnlocked={(info) => {
            saveSession(shareId, info);
            setScreen({ k: 'share', info });
          }}
          onGone={() => setScreen({ k: 'gone' })}
        />
      )}
      {screen.k === 'share' && shareId && (
        <ShareView
          key={screen.info.token}
          shareId={shareId}
          info={screen.info}
          onRevoked={(hadStarted) => {
            clearSession(shareId);
            setScreen({ k: 'revoked', hadStarted });
          }}
          onAccessExpired={() => {
            clearSession(shareId);
            setScreen({ k: 'locked', notice: 'Your access to this link has changed. Please enter the password again.' });
          }}
        />
      )}
      {screen.k === 'revoked' && <Revoked hadStarted={screen.hadStarted} />}
    </main>
  );
}

function Brand() {
  return (
    <p class="brand" aria-hidden="true">
      fileshare
    </p>
  );
}

function Loading() {
  return (
    <section class="card center" aria-busy="true">
      <Brand />
      <p role="status">Loading…</p>
    </section>
  );
}

function Gone() {
  return (
    <section class="card center">
      <Brand />
      <h1>This link isn't available</h1>
      <p class="muted">If you think this is a mistake, ask the person who sent it to you.</p>
    </section>
  );
}

function Revoked({ hadStarted }: { hadStarted: boolean }) {
  return (
    <section class="card center" role="alert">
      <Brand />
      <h1>This link isn't available any more</h1>
      <p>
        The person who shared it has turned it off{hadStarted ? ', so the download has stopped' : ''}.
        {hadStarted ? ' Files that had finished saving are kept; anything unfinished was not saved.' : ''}
      </p>
      <p class="muted">If you still need the files, ask them for a new link.</p>
    </section>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section class="card center" role="alert">
      <Brand />
      <h1>Something went wrong</h1>
      <p>{message}</p>
      <button type="button" class="btn primary" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

function Locked(props: { shareId: string; notice?: string; onUnlocked: (info: UnlockResponse) => void; onGone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [waitUntil]);

  const waitLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (busy || waitLeft > 0 || !password) return;
    setBusy(true);
    setError(null);
    const r = await unlock(props.shareId, password);
    setBusy(false);
    if (r.ok) {
      props.onUnlocked(r.data);
      return;
    }
    switch (r.reason) {
      case 'bad_password':
        setError("That password isn't right. Please try again.");
        break;
      case 'rate_limited':
        setWaitUntil(Date.now() + r.retryAfter * 1000);
        setNow(Date.now());
        setError('Too many attempts.');
        break;
      case 'gone':
        props.onGone();
        break;
      default:
        setError("We couldn't check the password right now. Please try again.");
    }
  };

  return (
    <section class="card narrow">
      <Brand />
      <h1>Enter the password</h1>
      <p class="muted">Someone shared files with you. The link is protected with a password.</p>
      {props.notice && (
        <p class="notice" role="status">
          {props.notice}
        </p>
      )}
      <form onSubmit={(e) => void submit(e)} class="stack">
        <label for="pw">Password</label>
        <input
          id="pw"
          type="password"
          autocomplete="current-password"
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? 'pw-err' : undefined}
          maxLength={1024}
          required
          autofocus
        />
        {error && (
          <p id="pw-err" class="error" role="alert">
            {error}
            {waitLeft > 0 ? ` Try again in ${waitLeft} s.` : ''}
          </p>
        )}
        <button type="submit" class="btn primary" disabled={busy || waitLeft > 0 || !password}>
          {busy ? 'Checking…' : 'Open'}
        </button>
      </form>
    </section>
  );
}
