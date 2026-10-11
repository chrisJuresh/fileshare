// WebTorrent client wrapper: one torrent, selected files only, P2P first with a capped webseed fallback.
// Settings follow docs/ARCHITECTURE.md §11 (browser client).
import type { UnlockResponse } from '../../src/types.ts';
import { AccessError, fetchTorrent } from './api.ts';
import { hasWebRTC, testHook } from './env.ts';
import { type WtClient, type WtFile, type WtTorrent, type WtWire, loadWebTorrent } from './wt-types.ts';

export type EnginePhase = 'idle' | 'starting' | 'downloading' | 'complete' | 'stopped' | 'error';

export interface FileProgress {
  downloaded: number;
  done: boolean;
}

export interface EngineSnapshot {
  phase: EnginePhase;
  /** 0..1 over the SELECTED files. */
  progress: number;
  selectedBytes: number;
  doneBytes: number;
  down: number;
  up: number;
  uploaded: number;
  downloaded: number;
  eta: number | null;
  files: FileProgress[];
  numPeers: number;
  webseedActive: boolean;
  peerBytes: number;
  webseedBytes: number;
  /** Seeding files this browser downloaded on an earlier visit (see `resume`). */
  resumed: boolean;
  error: string | null;
}

/** No peer data for this long (ms) → add the webseed. */
const DEFAULT_WEBSEED_AFTER_MS = 10_000;
/** Needed pieces missing from every connected peer for this long (ms) → add the webseed. */
const MISSING_PIECES_GRACE_MS = 5_000;
/** Keep the webseed at least this long once added (avoids flapping). */
const WEBSEED_MIN_MS = 15_000;
/** Peers count as "back" if one delivered data within this window (ms). */
const PEERS_HEALTHY_MS = 3_000;

export class Engine {
  private client: WtClient | null = null;
  private torrent: WtTorrent | null = null;
  private fileMap: (WtFile | undefined)[] = [];
  private selected: number[] = [];
  private phase: EnginePhase = 'idle';
  private error: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private lastPeerDataAt = 0;
  private missingSince: number | null = null;
  private webseedUrl: string | null = null;
  private webseedAddedAt: number | null = null;
  private peerBytes = 0;
  private webseedBytes = 0;
  private smoothedDown = 0;
  private lock: { release: () => void } | null = null;
  /** Set by `resume`: never download, only seed what the store already holds. */
  private resuming = false;
  private readonly webseedAfterMs: number;

  /** Called on every state change and once per second while active. */
  onChange: () => void = () => {};
  /** Called when the server refuses our token (password changed / share gone). */
  onAccessDenied: (status: number) => void = () => {};

  constructor(private readonly info: UnlockResponse) {
    const hookDelay = testHook()?.webseedAfterMs;
    this.webseedAfterMs = !hasWebRTC()
      ? 0
      : typeof hookDelay === 'number' && hookDelay >= 0
        ? hookDelay
        : DEFAULT_WEBSEED_AFTER_MS;
  }

  /** Loads WebTorrent and creates the client (no torrent yet), so we have a peerId for the live socket. */
  async init(): Promise<void> {
    const WebTorrent = await loadWebTorrent();
    const iceServers = this.info.iceServers
      .filter((s) => s && typeof s.urls === 'string' && /^stuns?:/i.test(s.urls))
      .map((s) => ({ urls: s.urls }));
    this.client = new WebTorrent({
      dht: false,
      lsd: false,
      utPex: false,
      webSeeds: false, // added manually as a fallback only
      tracker: { rtcConfig: { iceServers } },
    });
    this.client.on('error', (err: unknown) => this.fail(err));
  }

  get peerId(): string | null {
    return this.client?.peerId ?? null;
  }

  get wtClient(): WtClient | null {
    return this.client;
  }

  /** WebTorrent file for an UnlockResponse file index. */
  file(index: number): WtFile | undefined {
    return this.fileMap[index];
  }

  get selectedIndices(): readonly number[] {
    return this.selected;
  }

  /** Files this browser finished on an earlier visit whose pieces are still stored, or null. */
  async resumable(): Promise<number[] | null> {
    const files = loadSeeding(this.info);
    if (!files) return null;
    if (await hasStore(this.info.infoHash).catch(() => false)) return files;
    forgetSeeding(this.info.infoHash);
    return null;
  }

  /**
   * Seeds `files` again from the browser's piece store (re-verified by WebTorrent). Downloads nothing:
   * if the store no longer holds all of them, the torrent is dropped, the engine is idle again and
   * this returns false.
   */
  async resume(files: number[]): Promise<boolean> {
    if (this.phase !== 'idle') return false;
    this.resuming = true;
    await this.start(files);
    const phase = this.phase as EnginePhase; // TS keeps the pre-await narrowing to 'idle'
    if (phase === 'complete') return true;
    if (phase === 'idle') forgetSeeding(this.info.infoHash);
    this.resuming = false;
    return false;
  }

  async start(selected: number[]): Promise<void> {
    if (!this.client) throw new Error('not initialised');
    if (this.phase !== 'idle') return;
    this.selected = [...selected].sort((a, b) => a - b);
    this.phase = 'starting';
    this.onChange();

    let bytes: Uint8Array;
    try {
      bytes = await fetchTorrent(this.info.torrentUrl);
    } catch (err) {
      if (err instanceof AccessError) {
        this.stop();
        this.onAccessDenied(err.status);
        return;
      }
      this.fail(err);
      return;
    }
    if (this.phase !== 'starting') return; // stopped meanwhile

    await cleanupOtherStores(this.info.infoHash).catch(() => {});
    this.lock = await holdStoreLock(this.info.infoHash).catch(() => null);

    const torrent = this.client.add(bytes, {
      // The .torrent also lists the https tracker; browsers can't use it and WebTorrent just emits a
      // harmless "Unsupported tracker protocol" warning for it. This adds the wss one explicitly.
      announce: [this.info.announce.ws],
      strategy: 'rarest',
      deselect: true,
      maxWebConns: 2,
      storeCacheSlots: 8,
    });
    this.torrent = torrent;
    torrent.on('error', (err: unknown) => this.fail(err));
    torrent.on('warning', () => {
      /* tracker/webseed warnings are expected (e.g. the https tracker); nothing to show */
    });
    torrent.on('wire', (wire: WtWire) => {
      wire.on('download', (n: number) => {
        if (wire.type === 'webSeed') {
          this.webseedBytes += n;
        } else {
          this.peerBytes += n;
          this.lastPeerDataAt = Date.now();
        }
      });
    });

    await new Promise<void>((resolve) => {
      if (torrent.ready) resolve();
      else torrent.once('ready', () => resolve());
    });
    if (this.torrent !== torrent || torrent.destroyed) return;

    skipOwnedPiecesInRarestSearch(torrent);
    this.mapFiles(torrent);
    if (this.resuming && !this.allSelectedDone()) {
      this.dropTorrent();
      return;
    }
    for (const i of this.selected) {
      const f = this.fileMap[i];
      f?.select();
      f?.once('done', () => queueMicrotask(() => this.tick()));
    }
    this.webseedUrl = webseedUrlFor(this.info.webseed, torrent);
    this.startedAt = Date.now();
    this.lastPeerDataAt = this.startedAt;
    this.phase = this.allSelectedDone() ? 'complete' : 'downloading';
    if (this.phase === 'complete') rememberSeeding(this.info.infoHash, this.selected);
    this.timer = setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /** Back to idle with the client kept (its peerId is on the live socket). The piece store stays. */
  private dropTorrent(): void {
    const t = this.torrent;
    this.torrent = null;
    try {
      t?.destroy();
    } catch {
      /* ignore */
    }
    this.lock?.release();
    this.lock = null;
    this.fileMap = [];
    this.selected = [];
    this.phase = 'idle';
    this.onChange();
  }

  private mapFiles(torrent: WtTorrent): void {
    const byPath = new Map<string, WtFile>();
    for (const f of torrent.files) byPath.set(f.path, f);
    this.fileMap = this.info.files.map(
      (f, i) => byPath.get(`${torrent.name}/${f.path}`) ?? byPath.get(f.path) ?? torrent.files[i],
    );
  }

  private allSelectedDone(): boolean {
    return this.selected.every((i) => this.fileMap[i]?.done === true);
  }

  private tick(): void {
    const t = this.torrent;
    if (!t || t.destroyed) return;
    const now = Date.now();
    this.smoothedDown = this.smoothedDown * 0.7 + t.downloadSpeed * 0.3;

    if (this.phase === 'downloading' && this.allSelectedDone()) {
      this.phase = 'complete';
      rememberSeeding(this.info.infoHash, this.selected);
    }
    this.updateWebseed(t, now);
    this.onChange();
  }

  /** Adds the webseed when peers can't deliver; removes it when they're back. */
  private updateWebseed(t: WtTorrent, now: number): void {
    const url = this.webseedUrl;
    if (!url) return;
    const active = this.webseedAddedAt !== null;

    if (this.phase !== 'downloading') {
      if (active) this.removeWebseed(t);
      return;
    }

    const peerWires = t.wires.filter((w) => w.type !== 'webSeed');
    // "Peers lack pieces we need" only counts while we have peers; with no peers at all the
    // no-peer-data timer below decides (connecting over WebRTC can take a few seconds).
    const missing = peerWires.length > 0 && this.neededPiecesMissingFromPeers(t, peerWires);
    if (missing) this.missingSince ??= now;
    else this.missingSince = null;

    if (!active) {
      const stalled = now - this.lastPeerDataAt >= this.webseedAfterMs;
      const unavailable = this.missingSince !== null && now - this.missingSince >= MISSING_PIECES_GRACE_MS;
      if (stalled || unavailable) {
        try {
          t.addWebSeed(url);
          this.webseedAddedAt = now;
        } catch {
          /* torrent destroyed */
        }
      }
    } else if (this.webseedAfterMs > 0) {
      const healthy = peerWires.length > 0 && !missing && now - this.lastPeerDataAt < PEERS_HEALTHY_MS;
      if (healthy && now - (this.webseedAddedAt ?? now) >= WEBSEED_MIN_MS) this.removeWebseed(t);
    }
  }

  private removeWebseed(t: WtTorrent): void {
    if (this.webseedUrl && this.webseedAddedAt !== null) {
      try {
        t.removePeer(this.webseedUrl);
      } catch {
        /* ignore */
      }
    }
    this.webseedAddedAt = null;
  }

  private neededPiecesMissingFromPeers(t: WtTorrent, peerWires: WtWire[]): boolean {
    const bf = t.bitfield;
    if (!bf) return false;
    for (const i of this.selected) {
      const f = this.fileMap[i];
      if (!f || f.done) continue;
      for (let p = f._startPiece; p <= f._endPiece; p++) {
        if (bf.get(p)) continue;
        if (!peerWires.some((w) => w.peerPieces?.get(p))) return true;
      }
    }
    return false;
  }

  snapshot(): EngineSnapshot {
    const t = this.torrent;
    const files: FileProgress[] = this.info.files.map((f, i) => {
      const wf = this.fileMap[i];
      // WebTorrent 3.0.21's `file.downloaded` subtracts a whole piece from a file that ends exactly on
      // a piece boundary (lib/file.js, "irrelevantLastPieceBytes"), so such files never showed 100 %.
      // A done file is complete by definition.
      const downloaded = !wf ? 0 : wf.done ? f.length : Math.min(f.length, wf.downloaded);
      return { downloaded, done: wf?.done ?? false };
    });
    let selectedBytes = 0;
    let doneBytes = 0;
    for (const i of this.selected) {
      selectedBytes += this.info.files[i]?.length ?? 0;
      doneBytes += files[i]?.downloaded ?? 0;
    }
    const progress = selectedBytes > 0 ? doneBytes / selectedBytes : this.phase === 'complete' ? 1 : 0;
    const remaining = selectedBytes - doneBytes;
    const down = t && !t.destroyed ? t.downloadSpeed : 0;
    return {
      phase: this.phase,
      progress: Math.max(0, Math.min(1, progress)),
      selectedBytes,
      doneBytes,
      down,
      up: t && !t.destroyed ? t.uploadSpeed : 0,
      uploaded: t?.uploaded ?? 0,
      downloaded: t && !t.destroyed ? t.downloaded : 0,
      eta: this.phase === 'downloading' && this.smoothedDown > 1024 ? remaining / this.smoothedDown : null,
      files,
      numPeers: t && !t.destroyed ? t.wires.filter((w) => w.type !== 'webSeed').length : 0,
      webseedActive: this.webseedAddedAt !== null,
      peerBytes: this.peerBytes,
      webseedBytes: this.webseedBytes,
      resumed: this.resuming,
      error: this.error,
    };
  }

  private fail(err: unknown): void {
    if (this.phase === 'stopped') return;
    this.error = describeError(err);
    this.phase = 'error';
    this.clearTimer();
    this.onChange();
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Stops everything (share revoked, page leaving). */
  stop(): void {
    this.clearTimer();
    if (this.phase !== 'error') this.phase = 'stopped';
    const t = this.torrent;
    this.torrent = null;
    try {
      t?.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.client?.destroy();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.lock?.release();
    this.lock = null;
    this.onChange();
  }
}

/**
 * Workaround for WebTorrent 3.0.21 with strategy 'rarest' (lib/torrent.js trySelectWire/validateWire,
 * lib/rarity-map.js): getRarestPiece() also returns pieces we already have. Each one is then rejected
 * by _request(), marked "tried", and the O(pieces) search runs again — quadratic in the number of
 * pieces. On a 10 GiB share (2584 pieces) that pinned the page's main thread at 100 % and stalled
 * downloads for good at ~35 %. Only search pieces we don't have yet. (`_rarityMap` exists from
 * metadata on, before any file is selected.)
 */
export function skipOwnedPiecesInRarestSearch(torrent: WtTorrent): void {
  const rm = (torrent as unknown as { _rarityMap?: { getRarestPiece?: (filter?: (i: number) => boolean) => number } })._rarityMap;
  const orig = rm?.getRarestPiece;
  if (!rm || typeof orig !== 'function') return;
  rm.getRarestPiece = (filter) => orig.call(rm, (i: number) => !torrent.bitfield?.get(i) && (!filter || filter(i)));
}

/**
 * WebTorrent uses the webseed URL as-is for torrents with ≤ 1 file and appends `<name>/<path>` for
 * multi-file torrents (lib/webconn.js). The server's webseed base ends in `/`, so for one file we add
 * the path ourselves.
 */
export function webseedUrlFor(base: string, torrent: WtTorrent): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  if (torrent.files.length <= 1) {
    const f = torrent.files[0];
    return f ? b + encodePath(f.path) : b;
  }
  return b;
}

export function encodePath(p: string): string {
  return p
    .split('/')
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join('/');
}

/** Plain HTTP URL of one file on the webseed (last-resort direct download). */
export function directUrl(info: UnlockResponse, index: number): string {
  const b = info.webseed.endsWith('/') ? info.webseed : `${info.webseed}/`;
  const f = info.files[index];
  if (!f) return b;
  const single = info.files.length === 1 && f.path === info.name;
  return single ? b + encodeURIComponent(info.name) : `${b}${encodeURIComponent(info.name)}/${encodePath(f.path)}`;
}

function describeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/quota/i.test(msg)) return 'Your browser ran out of storage space for this download.';
  return msg.slice(0, 200) || 'Something went wrong.';
}

// --- browser storage housekeeping ---------------------------------------------------------------
// WebTorrent's default browser store keeps pieces in OPFS under `<name> - <infohash[0:8]>/`. Stores of
// other shares are left behind when a tab closes; remove those that no open tab is using (Web Locks).
// A finished download's store is kept until then, so reopening its link seeds it again (`resume`):
// localStorage remembers which files were finished (infohash and file indices only, never the token).

const LOCK_PREFIX = 'fileshare-store-';
const SEEDING_PREFIX = 'fileshare.seeding.';

function rememberSeeding(infoHash: string, files: readonly number[]): void {
  try {
    localStorage.setItem(SEEDING_PREFIX + infoHash.slice(0, 8), JSON.stringify({ infoHash, files }));
  } catch {
    /* storage disabled: no resume */
  }
}

function forgetSeeding(infoHash: string): void {
  try {
    localStorage.removeItem(SEEDING_PREFIX + infoHash.slice(0, 8));
  } catch {
    /* ignore */
  }
}

/** The remembered file indices for this share, if they are valid for it. */
export function loadSeeding(info: Pick<UnlockResponse, 'infoHash' | 'files'>): number[] | null {
  try {
    const raw = localStorage.getItem(SEEDING_PREFIX + info.infoHash.slice(0, 8));
    if (!raw) return null;
    const v = JSON.parse(raw) as { infoHash?: unknown; files?: unknown };
    if (v.infoHash !== info.infoHash || !Array.isArray(v.files) || v.files.length === 0) return null;
    const files = v.files as unknown[];
    const ok = files.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < info.files.length);
    return ok && new Set(files).size === files.length ? (files as number[]) : null;
  } catch {
    return null;
  }
}

async function hasStore(infoHash: string): Promise<boolean> {
  if (!navigator.storage?.getDirectory) return false;
  const root = await navigator.storage.getDirectory();
  const suffix = ` - ${infoHash.slice(0, 8)}`;
  for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
    if (name.endsWith(suffix)) return true;
  }
  return false;
}

async function holdStoreLock(infoHash: string): Promise<{ release: () => void }> {
  const locks = navigator.locks;
  if (!locks) return { release: () => {} };
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await new Promise<void>((acquired) => {
    void locks.request(LOCK_PREFIX + infoHash.slice(0, 8), { mode: 'shared' }, () => {
      acquired();
      return held;
    });
  });
  return { release };
}

async function cleanupOtherStores(infoHash: string): Promise<void> {
  const locks = navigator.locks;
  if (!locks || !navigator.storage?.getDirectory) return;
  const state = await locks.query();
  const inUse = new Set([...(state.held ?? []), ...(state.pending ?? [])].map((l) => l.name ?? ''));
  const ours = infoHash.slice(0, 8);
  const root = await navigator.storage.getDirectory();
  const iter = (root as unknown as { keys(): AsyncIterable<string> }).keys();
  const victims: string[] = [];
  for await (const name of iter) {
    const m = / - ([0-9a-f]{8})$/.exec(name);
    if (!m || m[1] === ours) continue;
    if (inUse.has(LOCK_PREFIX + m[1])) continue;
    victims.push(name);
  }
  for (const name of victims) {
    await root.removeEntry(name, { recursive: true }).catch(() => {});
    try {
      localStorage.removeItem(SEEDING_PREFIX + name.slice(-8));
    } catch {
      /* ignore */
    }
  }
}
