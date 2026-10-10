import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { UnlockResponse } from '../../src/types.ts';
import { cleanNick, loadNick, saveNick } from './api.ts';
import { Engine, type EngineSnapshot, directUrl } from './engine.ts';
import {
  type SaveMode,
  type TestState,
  detectSaveMode,
  hasWebRTC,
  isPhone,
  pickDirectory,
  requestPersist,
  storageEstimate,
  testHook,
} from './env.ts';
import { FileTree } from './FileTree.tsx';
import { formatBytes, formatEta, formatPercent, formatSpeed } from './format.ts';
import { LiveSocket, type SwarmView } from './live.ts';
import {
  type FileSaveState,
  attachStreamServer,
  downloadZip,
  registerWebTorrentSW,
  registerZipSW,
  saveToDirectory,
} from './save.ts';
import { SwarmTable } from './SwarmTable.tsx';
import { type TreeNode, buildTree, toggleNode } from './tree.ts';

interface Props {
  shareId: string;
  info: UnlockResponse;
  onRevoked: (hadStarted: boolean) => void;
  onAccessExpired: () => void;
}

interface StorageProblem {
  needed: number;
  available: number;
  persisted: boolean;
}

/** Extra room we want beyond the selected bytes (piece boundaries, metadata). */
const STORAGE_SLACK = 64 * 1024 * 1024;

export function ShareView({ shareId, info, onRevoked, onAccessExpired }: Props) {
  const root = useMemo(() => buildTree(info.files), [info]);
  const single = info.files.length === 1 && info.files[0]?.path === info.name;
  const [selected, setSelected] = useState<Set<number>>(() => new Set(info.files.map((_, i) => i)));
  const [saveMode] = useState<SaveMode>(detectSaveMode);
  const [started, setStarted] = useState(false);
  const [snap, setSnap] = useState<EngineSnapshot | null>(null);
  const [saveStates, setSaveStates] = useState<Partial<Record<number, FileSaveState>>>({});
  const [allSaved, setAllSaved] = useState(false);
  const [swarm, setSwarm] = useState<SwarmView | null>(null);
  const [liveConnected, setLiveConnected] = useState(false);
  const [nick, setNick] = useState(loadNick);
  const [problem, setProblem] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageProblem | null>(null);
  const [swReady, setSwReady] = useState(false);
  const [zipBusy, setZipBusy] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [phone] = useState(isPhone);
  const [webrtc] = useState(hasWebRTC);

  const engineRef = useRef<Engine | null>(null);
  const liveRef = useRef<LiveSocket | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nickRef = useRef(nick);
  nickRef.current = nick;
  const latest = useRef({ snap, started, allSaved, selected, liveConnected, saveMode });
  latest.current = { snap, started, allSaved, selected, liveConnected, saveMode };

  // --- engine + live socket lifecycle ---
  useEffect(() => {
    const engine = new Engine(info);
    engineRef.current = engine;
    const abort = new AbortController();
    abortRef.current = abort;
    engine.onChange = () => setSnap(engine.snapshot());
    engine.onAccessDenied = () => {
      abort.abort();
      liveRef.current?.stop();
      onAccessExpired();
    };
    let cancelled = false;

    engine
      .init()
      .then(() => {
        if (cancelled || !engine.peerId) return;
        const live = new LiveSocket({
          shareId,
          token: info.token,
          peerId: engine.peerId,
          nick: () => nickRef.current,
          stats: () => {
            const s = engine.snapshot();
            return {
              progress: s.progress,
              down: s.down,
              up: s.up,
              uploaded: s.uploaded,
              downloaded: s.downloaded,
              done: s.phase === 'complete',
            };
          },
          onSwarm: setSwarm,
          onConnection: setLiveConnected,
          onFatal: (code) => {
            abort.abort();
            const hadStarted = latest.current.started;
            engine.stop();
            if (code === 4404) onRevoked(hadStarted);
            else onAccessExpired();
          },
        });
        liveRef.current = live;
        live.start();
        setSnap(engine.snapshot());
      })
      .catch(() => {
        if (!cancelled) setInitError("This page couldn't load its download engine. Try reloading the page.");
      });

    return () => {
      cancelled = true;
      abort.abort();
      liveRef.current?.stop();
      liveRef.current = null;
      engine.stop();
    };
  }, [info, shareId]);

  // --- automation hook (only when a test injected window.__fileshareTest) ---
  useEffect(() => {
    const hook = testHook();
    if (!hook) return;
    hook.state = (): TestState => {
      const l = latest.current;
      const s = engineRef.current?.snapshot() ?? l.snap;
      return {
        phase: s?.phase ?? 'idle',
        peerId: engineRef.current?.peerId ?? null,
        saveMode: l.saveMode,
        selected: [...l.selected].sort((a, b) => a - b),
        progress: s?.progress ?? 0,
        done: s?.phase === 'complete',
        saved: l.allSaved,
        uploaded: s?.uploaded ?? 0,
        downloaded: s?.downloaded ?? 0,
        peerBytes: s?.peerBytes ?? 0,
        webseedBytes: s?.webseedBytes ?? 0,
        webseedActive: s?.webseedActive ?? false,
        numPeers: s?.numPeers ?? 0,
        liveConnected: l.liveConnected,
        error: s?.error ?? null,
      };
    };
  }, []);

  const phase = snap?.phase ?? 'idle';
  const active = started && (phase === 'starting' || phase === 'downloading' || phase === 'complete');
  const saving = saveMode === 'directory' && started && !allSaved && Object.values(saveStates).some((s) => s === 'writing' || s === 'waiting');

  // --- warn before leaving while downloading/seeding ---
  useEffect(() => {
    if (!active) return;
    const handler = (e: BeforeUnloadEvent): void => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [active]);

  const selectedBytes = useMemo(() => [...selected].reduce((s, i) => s + (info.files[i]?.length ?? 0), 0), [selected, info]);
  const selectedList = (): number[] => [...selected].sort((a, b) => a - b);

  const checkStorage = async (persisted: boolean): Promise<StorageProblem | null> => {
    const est = await storageEstimate();
    if (!est) return null;
    const available = Math.max(0, est.quota - est.usage);
    const needed = selectedBytes + STORAGE_SLACK;
    return available < needed ? { needed, available, persisted } : null;
  };

  const startDirectory = async (): Promise<void> => {
    const engine = engineRef.current;
    if (!engine || selected.size === 0) return;
    setProblem(null);
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await pickDirectory(); // first: needs the click's user activation
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setProblem("We couldn't open that folder. Please pick another one (for example, Downloads).");
      return;
    }
    const sp = await checkStorage(true);
    if (sp) setStorage(sp); // warn, but try anyway (Chromium usually has plenty)
    const indices = selectedList();
    setSaveStates(Object.fromEntries(indices.map((i) => [i, 'waiting' as FileSaveState])));
    setStarted(true);
    await engine.start(indices);
    if (engine.snapshot().phase === 'stopped' || engine.snapshot().phase === 'error') return;
    const jobs = indices.flatMap((i) => {
      const f = info.files[i];
      const wf = engine.file(i);
      return f && wf ? [{ index: i, path: single ? info.name : f.path, length: f.length, file: wf }] : [];
    });
    const ok = await saveToDirectory(
      dir,
      info.name,
      !single,
      jobs,
      (index, state) => setSaveStates((prev) => ({ ...prev, [index]: state })),
      abortRef.current?.signal ?? new AbortController().signal,
    ).catch(() => false);
    setAllSaved(ok);
    if (!ok && !abortRef.current?.signal.aborted) {
      setProblem('Some files could not be saved to that folder. Check there is enough free space and try again.');
    }
  };

  const startServiceWorker = async (force: boolean): Promise<void> => {
    const engine = engineRef.current;
    if (!engine || selected.size === 0) return;
    setProblem(null);
    const persisted = await requestPersist(); // first: may show a permission prompt tied to the click
    if (!force) {
      const sp = await checkStorage(persisted);
      if (sp) {
        setStorage(sp);
        return;
      }
    }
    setStorage(null);
    try {
      const reg = await registerWebTorrentSW();
      const client = engine.wtClient;
      if (client) attachStreamServer(client, reg);
      setSwReady(true);
    } catch {
      setProblem(
        "Your browser blocked the helper this page uses to save files (this happens in some private windows). You can still use the direct download links below.",
      );
      return;
    }
    setStarted(true);
    await engine.start(selectedList());
  };

  const downloadAll = async (): Promise<void> => {
    const engine = engineRef.current;
    if (!engine || zipBusy) return;
    setZipBusy(true);
    setProblem(null);
    try {
      const reg = await registerZipSW();
      const entries = engine.selectedIndices.flatMap((i) => {
        const f = info.files[i];
        const wf = engine.file(i);
        return f && wf ? [{ name: f.path, length: f.length, file: wf }] : [];
      });
      const ok = await downloadZip(reg, `${info.name}.zip`, entries);
      if (!ok) setProblem("The zip download didn't start. Please try again, or save the files one by one.");
    } catch {
      setProblem("The zip download didn't start. Please try again, or save the files one by one.");
    } finally {
      setZipBusy(false);
    }
  };

  const onToggle = (node: TreeNode): void => setSelected((prev) => toggleNode(node, prev));
  const saveUrl = (index: number): string | null => {
    if (saveMode !== 'serviceworker' || !swReady) return null;
    try {
      return engineRef.current?.file(index)?.streamURL ?? null;
    } catch {
      return null;
    }
  };

  const onNick = (value: string): void => {
    const clean = cleanNick(value);
    setNick(value.slice(0, 24));
    saveNick(clean);
  };
  const commitNick = (): void => {
    const clean = cleanNick(nick);
    setNick(clean);
    saveNick(clean);
    liveRef.current?.setNick(clean);
  };

  const fileCount = info.files.length;
  const done = phase === 'complete';

  return (
    <div class="share">
      <header class="card hero">
        <p class="brand" aria-hidden="true">
          fileshare
        </p>
        <h1 class="item-name">{info.name}</h1>
        <p class="muted">
          {fileCount} {fileCount === 1 ? 'file' : 'files'} · {formatBytes(info.totalBytes)}
          {info.expiresAt !== null && ` · link works until ${new Date(info.expiresAt).toLocaleString()}`}
        </p>
        {phone && (
          <p class="notice">
            You're on a phone or tablet. Downloading works, but it will be slower and won't help others much.
          </p>
        )}
        {!webrtc && (
          <p class="notice">
            Your browser can't connect directly to other people, so this download comes straight from the server. It
            works, but it's slower.
          </p>
        )}
        {initError && (
          <p class="error" role="alert">
            {initError}
          </p>
        )}
      </header>

      <section class="card" aria-labelledby="files-h">
        <div class="card-head">
          <h2 id="files-h">Choose files</h2>
          {!started && fileCount > 1 && (
            <div class="actions">
              <button type="button" class="btn link" onClick={() => setSelected(new Set(info.files.map((_, i) => i)))}>
                Select all
              </button>
              <button type="button" class="btn link" onClick={() => setSelected(new Set())}>
                Select none
              </button>
            </div>
          )}
        </div>
        <FileTree
          root={root}
          files={info.files}
          selected={selected}
          onToggle={onToggle}
          locked={started}
          progress={started && snap && snap.phase !== 'starting' ? snap.files : null}
          saveStates={saveStates}
          saveUrl={saveUrl}
        />
        <p class="muted selection" aria-live="polite">
          {selected.size} of {fileCount} selected · {formatBytes(selectedBytes)}
        </p>

        {!started && (
          <div class="start">
            {saveMode === 'directory' && (
              <>
                <button
                  type="button"
                  class="btn primary big"
                  disabled={selected.size === 0 || !snap}
                  onClick={() => void startDirectory()}
                >
                  Choose folder and download
                </button>
                <p class="muted small">You'll pick a folder; files are saved there as they arrive.</p>
              </>
            )}
            {saveMode === 'serviceworker' && (
              <>
                <button
                  type="button"
                  class="btn primary big"
                  disabled={selected.size === 0 || !snap}
                  onClick={() => void startServiceWorker(false)}
                >
                  Start download
                </button>
                <p class="muted small">Files download into your browser first; then you save them with one click.</p>
              </>
            )}
            {saveMode === 'none' && (
              <p class="notice">This browser can't save large downloads from this page. Use the direct links below.</p>
            )}
          </div>
        )}

        {storage && (
          <StorageWarning
            problem={storage}
            info={info}
            selected={selectedList()}
            canForce={saveMode === 'serviceworker' && !started}
            onForce={() => void startServiceWorker(true)}
          />
        )}
        {problem && (
          <p class="error" role="alert">
            {problem}
          </p>
        )}
        {(saveMode === 'none' || (problem && saveMode === 'serviceworker' && !started)) && (
          <DirectLinks info={info} selected={selectedList()} />
        )}
      </section>

      {started && snap && (
        <section class="card" aria-labelledby="progress-h">
          <h2 id="progress-h">{done ? 'All done' : snap.phase === 'error' ? 'Download problem' : 'Downloading'}</h2>
          <progress class="bar big" max={1} value={snap.progress} aria-label="Overall progress" />
          <p class="stats" aria-live="polite">
            <strong>{formatPercent(snap.progress)}</strong>
            {' · '}
            {formatBytes(snap.doneBytes)} of {formatBytes(snap.selectedBytes)}
            {!done && snap.phase === 'downloading' && (
              <>
                {' · '}
                {formatSpeed(snap.down)} · {formatEta(snap.eta)} left
              </>
            )}
          </p>
          <p class="muted small">
            Connected to {snap.numPeers} {snap.numPeers === 1 ? 'peer' : 'peers'}
            {snap.webseedActive ? ' · getting extra help straight from the server' : ''}
            {snap.phase === 'starting' ? ' · getting ready…' : ''}
          </p>
          {snap.error && (
            <p class="error" role="alert">
              {snap.error}
            </p>
          )}
          {done && saveMode === 'directory' && (
            <p class="ok-text">{allSaved ? 'Everything is saved in the folder you chose.' : saving ? 'Finishing saving…' : ''}</p>
          )}
          {done && saveMode === 'serviceworker' && (
            <div class="save-all">
              <p>Your files are ready. Use the Save buttons above, or get everything at once:</p>
              <button type="button" class="btn primary" disabled={zipBusy} onClick={() => void downloadAll()}>
                {zipBusy ? 'Preparing zip…' : 'Download all (.zip)'}
              </button>
            </div>
          )}
          <p class="helping">
            {done
              ? `You've shared ${formatBytes(snap.uploaded)} with friends. Keep this tab open to help your friends download faster.`
              : 'Keep this tab open to help your friends download faster.'}
          </p>
        </section>
      )}

      <SwarmTable swarm={swarm} connected={liveConnected} />

      <section class="card" aria-labelledby="nick-h">
        <h2 id="nick-h">Your name in the list</h2>
        <form
          class="row-form"
          onSubmit={(e) => {
            e.preventDefault();
            commitNick();
          }}
        >
          <label for="nick" class="visually-hidden">
            Nickname (optional, up to 24 characters)
          </label>
          <input
            id="nick"
            type="text"
            maxLength={24}
            placeholder="Optional nickname"
            value={nick}
            autocomplete="nickname"
            onInput={(e) => onNick((e.target as HTMLInputElement).value)}
            onBlur={commitNick}
          />
          <button type="submit" class="btn">
            Set
          </button>
        </form>
        <p class="muted small">Shown to others downloading this link. Leave empty to appear as "Friend".</p>
      </section>

      <details class="card torrent-apps">
        <summary>Use a torrent app instead</summary>
        <p>
          If you have a torrent app (like qBittorrent or Transmission), you can download with it instead. Torrent apps
          keep going when this tab is closed and are good for very large downloads.
        </p>
        <div class="actions">
          <a class="btn" href={info.torrentUrl} download={`${info.name}.torrent`}>
            Download .torrent file
          </a>
          <a class="btn" href={info.magnet}>
            Open magnet link
          </a>
          <CopyButton text={info.magnet} label="Copy magnet link" />
        </div>
      </details>
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      class="btn"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => {},
        );
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function StorageWarning(props: {
  problem: StorageProblem;
  info: UnlockResponse;
  selected: number[];
  canForce: boolean;
  onForce: () => void;
}) {
  const { problem } = props;
  return (
    <div class="warning" role="alert">
      <h3>Not enough browser storage</h3>
      <p>
        This download needs about {formatBytes(problem.needed)} of space inside your browser, but it only lets this page
        use {formatBytes(problem.available)} right now.
        {!problem.persisted && ' Allowing this site to "store data persistently" (if your browser asks) gives it more room.'}
      </p>
      <p>You can free up disk space and reload, try anyway, or use the direct downloads below.</p>
      {props.canForce && (
        <button type="button" class="btn" onClick={props.onForce}>
          Try anyway
        </button>
      )}
      <DirectLinks info={props.info} selected={props.selected} />
    </div>
  );
}

function DirectLinks({ info, selected }: { info: UnlockResponse; selected: number[] }) {
  if (selected.length === 0) return null;
  return (
    <details class="direct">
      <summary>Direct download from the server (last resort)</summary>
      <p class="muted small">
        These links download straight from the server without sharing with others. They're slower, and they make the
        download slower for everyone else too, so please only use them if nothing else works.
      </p>
      <ul>
        {selected.map((i) => {
          const f = info.files[i];
          if (!f) return null;
          const name = f.path.split('/').pop() ?? f.path;
          return (
            <li key={i}>
              <a href={directUrl(info, i)} download={name}>
                {f.path}
              </a>{' '}
              <span class="muted">({formatBytes(f.length)})</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
