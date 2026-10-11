import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { UnlockResponse } from '../../src/types.ts';
import { cleanNick, loadNick, saveNick } from './api.ts';
import { Engine, type EngineSnapshot, directUrl, prepareStore } from './engine.ts';
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
import { type TreeNode, buildTree, checkState, toggleNode } from './tree.ts';

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
/** Above this, the in-browser download carries a warning pointing to a torrent app. */
const BIG_BROWSER_DOWNLOAD = 1_000_000_000;

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
  /** The in-browser download is tucked away until opened, or until it is running (resumed seeding included). */
  const [browserOpen, setBrowserOpen] = useState(false);

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
      .then(async () => {
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
              ...(s.resumed ? { resumed: true } : {}),
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
        // Downloaded here on an earlier visit and the pieces are still stored: seed them again
        // straight away. The start buttons stay disabled (no snapshot yet) while we check.
        const files = await engine.resumable();
        if (cancelled) return;
        if (files) await resumeSeeding(engine, files);
        if (!cancelled) setSnap(engine.snapshot());
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

  useEffect(() => {
    if (started) setBrowserOpen(true);
  }, [started]);

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
    const reusable = await prepareStore(info.infoHash).catch(() => 0);
    const est = await storageEstimate();
    if (!est) return null;
    const available = Math.max(0, est.quota - est.usage + reusable);
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
    void requestPersist(); // Chromium decides silently; persistence protects the piece store from eviction
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
    // First, while we still have the click's user activation. Firefox may show a permission prompt
    // that the user answers later (or never), so don't wait for it for long.
    const persistRequest = requestPersist();
    const persisted = await Promise.race([persistRequest, new Promise<boolean>((r) => setTimeout(() => r(false), 1500))]);
    if (!persisted) {
      void persistRequest.then(async (granted) => {
        if (!granted) return;
        // Granted later: re-check, and drop the storage warning if it no longer applies.
        if (!(await checkStorage(true))) setStorage(null);
      });
    }
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

  const resumeSeeding = async (engine: Engine, files: number[]): Promise<void> => {
    setSelected(new Set(files));
    setStarted(true);
    if (latest.current.saveMode === 'serviceworker') {
      // So the per-file Save buttons work again; the zip download doesn't need it.
      try {
        const reg = await registerWebTorrentSW();
        const client = engine.wtClient;
        if (client) attachStreamServer(client, reg);
        setSwReady(true);
      } catch {
        /* no Save buttons; still seeding */
      }
    }
    if (await engine.resume(files)) return;
    if (engine.snapshot().phase !== 'idle') return; // stopped (share gone / access lost) or error
    // Not all of it is stored any more: back to the normal choose-and-download screen.
    setStarted(false);
    setSelected(new Set(info.files.map((_, i) => i)));
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

  const onNick = (value: string): void => setNick(value.slice(0, 24));
  /** A name is required: clearing the field puts the last saved name back. */
  const commitNick = (): void => {
    const clean = cleanNick(nick);
    if (!clean) {
      setNick(loadNick());
      return;
    }
    setNick(clean);
    if (clean === loadNick()) return;
    saveNick(clean);
    liveRef.current?.setNick(clean);
  };

  const fileCount = info.files.length;
  const done = phase === 'complete';
  const allState = checkState(root, selected);

  return (
    <div class="share">
      <header class="share-head">
        <h1 class="item-name">{info.name}</h1>
        <p class="muted">
          {fileCount} {fileCount === 1 ? 'file' : 'files'} · {formatBytes(info.totalBytes)}
          {info.expiresAt !== null &&
            ` · Expires ${new Date(info.expiresAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`}
        </p>
      </header>

      <section class="panel torrent" aria-labelledby="torrent-h">
        <h2 id="torrent-h">Download with a torrent app</h2>
        <p class="muted">
          Works in qBittorrent, Transmission or any torrent app, and keeps going after you close this page. Leave it
          seeding afterwards so others get the files faster.
        </p>
        <div class="actions">
          <a class="btn green" href={info.torrentUrl} download={`${info.name}.torrent`}>
            Download .torrent file
          </a>
          <a class="btn green" href={info.magnet}>
            Open magnet link
          </a>
          <CopyButton text={info.magnet} label="Copy magnet link" />
        </div>
        <p class="hint">These links carry your name, so don't pass them on. Send others the page link instead.</p>
      </section>

      <details class="browser-dl" open={browserOpen} onToggle={(e) => setBrowserOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary>Download in your browser</summary>
        <div class="browser-body">
          {selectedBytes > BIG_BROWSER_DOWNLOAD && !started && (
            <p class="warning" role="note">
              This download is {formatBytes(selectedBytes)}. At that size a browser download needs a lot of browser storage
              and this tab open the whole time. A torrent app is much more reliable.
            </p>
          )}
          {phone && <p class="notice">On a phone, downloads are slower and won't help others much.</p>}
          {!webrtc && (
            <p class="notice">Your browser can't connect to other people, so this downloads from the server. It works, but slower.</p>
          )}
          {initError && (
            <p class="error" role="alert">
              {initError}
            </p>
          )}

          <section class="panel" aria-label="Files">
            {fileCount > 1 && (
              <div class={started ? 'panel-head started' : 'panel-head'}>
                <label class="name">
                  <input
                    type="checkbox"
                    class="check"
                    checked={allState === 'all'}
                    indeterminate={allState === 'some'}
                    disabled={started}
                    onChange={() => onToggle(root)}
                  />
                  <span>Name</span>
                </label>
                <span>Size</span>
              </div>
            )}
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

            <div class="panel-foot">
              {!started && (
                <div class="foot-row">
                  <p class="muted" aria-live="polite">
                    {selected.size} of {fileCount} selected · {formatBytes(selectedBytes)}
                  </p>
                  {saveMode === 'directory' && (
                    <button type="button" class="btn" disabled={selected.size === 0 || !snap} onClick={() => void startDirectory()}>
                      Choose folder and download
                    </button>
                  )}
                  {saveMode === 'serviceworker' && (
                    <button type="button" class="btn" disabled={selected.size === 0 || !snap} onClick={() => void startServiceWorker(false)}>
                      Start download
                    </button>
                  )}
                </div>
              )}
              {!started && saveMode !== 'none' && (
                <p class="hint">Use this only if you can't use a torrent app. It stops when you close this tab.</p>
              )}
              {!started && saveMode === 'none' && (
                <p class="notice">This browser can't save large downloads from this page. Use the direct links below.</p>
              )}

              {started && snap && (
                <div class="progress" aria-labelledby="progress-h">
                  <div class="progress-head">
                    <h2 id="progress-h">
                      {done ? 'All done' : snap.phase === 'error' ? 'Download problem' : snap.resumed ? 'Checking your earlier download' : 'Downloading'}
                    </h2>
                    <span class="pct-big">{formatPercent(snap.progress)}</span>
                  </div>
                  <progress class="bar" max={1} value={snap.progress} aria-label="Overall progress" />
                  <p class="stats muted" aria-live="polite">
                    {formatBytes(snap.doneBytes)} of {formatBytes(snap.selectedBytes)}
                    {!done && snap.phase === 'downloading' && ` · ${formatSpeed(snap.down)}`}
                    {!done && snap.phase === 'downloading' && snap.eta !== null && Number.isFinite(snap.eta) && snap.eta >= 0 && ` ·${formatEta(snap.eta)} left`}
                    {` · ${snap.numPeers} ${snap.numPeers === 1 ? 'peer' : 'peers'}`}
                    {snap.webseedActive ? ' + server' : ''}
                    {snap.phase === 'starting' ? ' · getting ready…' : ''}
                  </p>
                  {snap.error && (
                    <p class="error" role="alert">
                      {snap.error}
                    </p>
                  )}
                  {done && snap.resumed && <p class="ok-text">You downloaded these files on an earlier visit.</p>}
                  {done && saveMode === 'directory' && !snap.resumed && (allSaved || saving) && (
                    <p class="ok-text">{allSaved ? 'Everything is saved in the folder you chose.' : 'Finishing saving…'}</p>
                  )}
                  {done && saveMode === 'serviceworker' && (
                    <div class="foot-row">
                      <p>Save files one by one, or everything at once.</p>
                      <button type="button" class="btn primary" disabled={zipBusy} onClick={() => void downloadAll()}>
                        {zipBusy ? 'Preparing zip…' : 'Download all (.zip)'}
                      </button>
                    </div>
                  )}
                  <p class="hint">
                    {done
                      ? `You've shared ${formatBytes(snap.uploaded)} with friends. Keep this tab open, or reopen the link later, to help them finish faster.`
                      : 'Keep this tab open to help others download faster.'}
                  </p>
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
            </div>
          </section>
        </div>
      </details>

      <SwarmTable swarm={swarm} connected={liveConnected}>
        <form
          class="panel-foot nick"
          onSubmit={(e) => {
            e.preventDefault();
            commitNick();
          }}
        >
          <label for="nick" class="visually-hidden">
            Your name (up to 24 characters)
          </label>
          <span class="muted" aria-hidden="true">
            Your name
          </span>
          <input
            id="nick"
            type="text"
            maxLength={24}
            value={nick}
            required
            autocomplete="name"
            onInput={(e) => onNick((e.target as HTMLInputElement).value)}
            onBlur={commitNick}
          />
          <button type="submit" class="btn">
            Change
          </button>
        </form>
      </SwarmTable>
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
        This download needs about {formatBytes(problem.needed)} inside your browser, but only{' '}
        {formatBytes(problem.available)} is available.
        {!problem.persisted && ' If your browser asks to let this site store data persistently, allowing it gives more room.'}
        {' '}Free up disk space and reload, try anyway, or use a direct download.
      </p>
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
      <summary>Direct download from the server</summary>
      <p class="hint">Slower, and it slows everyone else down too. Use only if nothing else works.</p>
      <ul>
        {selected.map((i) => {
          const f = info.files[i];
          if (!f) return null;
          const name = f.path.split('/').pop() ?? f.path;
          return (
            <li key={i}>
              <a href={directUrl(info, i)} download={name}>
                {f.path}
              </a>
              <span class="size">{formatBytes(f.length)}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
