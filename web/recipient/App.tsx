import { useEffect, useState } from 'preact/hooks';
import type { UnlockResponse } from '../../src/types.ts';
import {
  cleanNick,
  clearSession,
  getShareStatus,
  loadNick,
  loadSession,
  nameToken,
  refreshSession,
  saveNick,
  saveSession,
  shareIdFromLocation,
  tokenHasName,
  unlock,
} from './api.ts';
import { Logo } from './icons.tsx';
import { ShareView } from './ShareView.tsx';

type Screen =
  | { k: 'loading' }
  | { k: 'gone' }
  | { k: 'gate'; passwordRequired: boolean; notice?: string }
  | { k: 'error'; message: string }
  /** `rev` remounts the share view (its engine was stopped) even if the infohash did not change. */
  | { k: 'share'; info: UnlockResponse; notice?: string; rev?: number }
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
      // Everyone gives a name before downloading; one remembered from an earlier visit is reused.
      const name = loadNick();
      let saved = loadSession(shareId);
      if (saved && name && !tokenHasName(saved.token)) {
        // Unlocked before it had a name (or before names existed): swap for a token carrying it, so
        // the .torrent / magnet links name this recipient.
        const r = await nameToken(shareId, saved.token, name);
        if (r.ok) {
          saveSession(shareId, r.data);
          saved = r.data;
        } else if (r.reason === 'gone') {
          clearSession(shareId);
          setScreen({ k: 'gone' });
          return;
        } else if (r.reason === 'invalid') {
          clearSession(shareId);
          saved = null;
        }
      }
      if (saved && name) {
        // The share's files may have changed since this tab saved its info.
        const r = await refreshSession(shareId, saved.token);
        if (r.ok) {
          saveSession(shareId, r.data);
          setScreen({ k: 'share', info: r.data });
          return;
        }
        if (r.reason === 'gone') {
          clearSession(shareId);
          setScreen({ k: 'gone' });
          return;
        }
        if (r.reason === 'error') {
          setScreen({ k: 'share', info: saved });
          return;
        }
        clearSession(shareId); // invalid: unlock again below
      }
      if (status.status === 'open' && !status.passwordRequired && name) {
        const r = await unlock(shareId, name);
        if (r.ok) {
          saveSession(shareId, r.data);
          setScreen({ k: 'share', info: r.data });
        } else if (r.reason === 'gone') setScreen({ k: 'gone' });
        else if (r.reason === 'bad_password') setScreen({ k: 'gate', passwordRequired: true });
        else setScreen({ k: 'error', message: "We couldn't open this link right now." });
        return;
      }
      setScreen({ k: 'gate', passwordRequired: status.passwordRequired });
    } catch {
      setScreen({ k: 'error', message: "We couldn't reach the server. Check your connection and try again." });
    }
  };

  /** The sender added files to the share: load the new file list for the token we hold. */
  const contentChanged = async (token: string): Promise<void> => {
    if (!shareId) return;
    const r = await refreshSession(shareId, token);
    if (r.ok) {
      saveSession(shareId, r.data);
      setScreen({
        k: 'share',
        info: r.data,
        rev: Date.now(),
        notice:
          'Files were added to this share. If your torrent app already has the earlier files, download the .torrent file again and save it to the same folder: it only fetches what is new.',
      });
    } else if (r.reason === 'gone') {
      clearSession(shareId);
      setScreen({ k: 'gone' });
    } else {
      clearSession(shareId);
      void boot();
    }
  };

  useEffect(() => {
    void boot();
  }, []);

  useEffect(() => {
    document.title = screen.k === 'share' ? `${screen.info.name} · fileshare` : 'fileshare';
  }, [screen]);

  return (
    <>
      <header class="topbar">
        <span class="wordmark" aria-hidden="true">
          <Logo />
          fileshare
        </span>
      </header>
      <main class="page">
        {screen.k === 'loading' && <Loading />}
        {screen.k === 'gone' && <Gone />}
        {screen.k === 'error' && <ErrorScreen message={screen.message} onRetry={() => void boot()} />}
        {screen.k === 'gate' && shareId && (
          <Gate
            shareId={shareId}
            passwordRequired={screen.passwordRequired}
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
            key={`${screen.info.token} ${screen.info.infoHash} ${screen.rev ?? 0}`}
            shareId={shareId}
            info={screen.info}
            notice={screen.notice}
            onContentChanged={() => void contentChanged(screen.info.token)}
            onRevoked={(hadStarted) => {
              clearSession(shareId);
              setScreen({ k: 'revoked', hadStarted });
            }}
            onAccessExpired={() => {
              clearSession(shareId);
              setScreen({ k: 'gate', passwordRequired: true, notice: 'Your access to this link has changed. Please enter the password again.' });
            }}
          />
        )}
        {screen.k === 'revoked' && <Revoked hadStarted={screen.hadStarted} />}
      </main>
    </>
  );
}

function Loading() {
  return (
    <section class="screen" aria-busy="true">
      <p class="muted" role="status">
        Loading…
      </p>
    </section>
  );
}

function Gone() {
  return (
    <section class="screen">
      <h1>This link isn't available</h1>
      <p class="muted">If you think this is a mistake, ask the person who sent it.</p>
    </section>
  );
}

function Revoked({ hadStarted }: { hadStarted: boolean }) {
  return (
    <section class="screen" role="alert">
      <h1>This link isn't available any more</h1>
      <p class="muted">
        The sender turned it off{hadStarted ? ', so the download has stopped' : ''}.
        {hadStarted ? ' Files that finished saving are kept.' : ''} Ask them for a new link if you still need the files.
      </p>
    </section>
  );
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section class="screen" role="alert">
      <h1>Something went wrong</h1>
      <p class="muted">{message}</p>
      <button type="button" class="btn primary" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

/** Asks for the recipient's name (always) and the password (password-protected links) before the files. */
function Gate(props: {
  shareId: string;
  passwordRequired: boolean;
  notice?: string;
  onUnlocked: (info: UnlockResponse) => void;
  onGone: () => void;
}) {
  const [name, setName] = useState(loadNick);
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
  const cleanName = cleanNick(name);
  const ready = cleanName.length > 0 && (!props.passwordRequired || password.length > 0);

  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    if (busy || waitLeft > 0 || !ready) return;
    setBusy(true);
    setError(null);
    const r = await unlock(props.shareId, cleanName, props.passwordRequired ? password : undefined);
    setBusy(false);
    if (r.ok) {
      saveNick(cleanName);
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
        setError(props.passwordRequired ? "We couldn't check the password right now. Please try again." : "We couldn't open this link right now. Please try again.");
    }
  };

  return (
    <section class="screen gate">
      <h1>{props.passwordRequired ? 'Enter your name and the password' : "What's your name?"}</h1>
      {props.notice && (
        <p class="notice" role="status">
          {props.notice}
        </p>
      )}
      <form onSubmit={(e) => void submit(e)} class="stack">
        <div class="field">
          <label for="name">Your name</label>
          <input
            id="name"
            type="text"
            autocomplete="name"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value.slice(0, 24))}
            aria-describedby="name-help"
            maxLength={24}
            required
            autofocus={!name}
          />
          <p id="name-help" class="hint">
            Visible to the sender and anyone else downloading.
          </p>
        </div>
        {props.passwordRequired && (
          <div class="field">
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
              autofocus={!!name}
            />
          </div>
        )}
        {error && (
          <p id="pw-err" class="error" role="alert">
            {error}
            {waitLeft > 0 ? ` Try again in ${waitLeft} s.` : ''}
          </p>
        )}
        <button type="submit" class="btn primary block" disabled={busy || waitLeft > 0 || !ready}>
          {busy ? (props.passwordRequired ? 'Checking…' : 'Opening…') : props.passwordRequired ? 'Open' : 'Continue'}
        </button>
      </form>
    </section>
  );
}

