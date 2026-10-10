// Swarm stats (docs/ARCHITECTURE.md §8): per-share live view (server row, browsers via the stats
// WebSocket, torrent clients via seeder wires / tracker announces) and persisted share_stats.
// Peers are keyed internally by their BitTorrent peer id and exposed only as opaque `p<N>` ids.
// No IPs anywhere.
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import type { ShareStatsRow } from '../db/index.js';
import type { ClientMsg, ServerMsg, ShareStatsDto, SwarmPeer, SwarmSnapshot } from '../types.js';
import { RateMeter } from './limiter.js';
import type { WtTorrent, WtWire } from './seeder.js';
import { shareState, type ShareStore } from './shares.js';
import type { AnnounceInfo } from './tracker.js';

export const LINGER_MS = 30_000;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_STATS_PER_SEC = 2;
const MAX_MSGS_PER_SEC = 20;
const MAX_SOCKETS_PER_SHARE = 500;
const MAX_MSG_CHARS = 4096;
const ANNOUNCE_TTL_MS = { http: 25 * 60_000, ws: 5 * 60_000 } as const;
const PEER_ID_RE = /^[0-9a-f]{40}$/;
const MAX_NUM = 1e15;
/** Per-share bound on remembered peers (announces, upload ledger, completions); oldest evicted. */
export const MAX_PEERS_PER_SHARE = 1000;
/** Per-share bound on counted completions per rolling hour (announce/stats spam can't inflate it). */
export const MAX_COMPLETIONS_PER_HOUR = 200;
const HOUR_MS = 3600_000;

/** Make room for one new key: drop the oldest (first-inserted) entries until size < max. */
function evictOldest(m: Map<string, unknown> | Set<string>, max: number): void {
  for (const k of m.keys()) {
    if (m.size < max) return;
    m.delete(k);
  }
}

/** Trim, strip control/format characters, collapse whitespace, cap at 24 characters. */
export function sanitizeNick(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw
    .normalize('NFC')
    .replace(/\s+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, '')
    .trim();
  const chars = Array.from(cleaned).slice(0, 24).join('').trim();
  return chars.length > 0 ? chars : undefined;
}

function finiteNonNeg(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

interface BrowserState {
  peerId: string;
  nick?: string;
  progress: number;
  down: number;
  up: number;
  uploaded: number;
  done: boolean;
  socket?: LiveSocket;
}

interface AnnouncedPeer {
  type: 'http' | 'ws';
  left: number;
  uploaded: number;
  lastSeen: number;
  /** Sent a non-`completed` announce (started/update) before: only such a peer can complete. */
  begun: boolean;
}

interface Pending {
  webseed: number;
  p2p: number;
  peerBytes: number;
  completed: number;
  peak: number;
  lastActivity: number | null;
}

type LiveSocket = WebSocket & { fsPeerId?: string; fsTokenVersion?: number };

class ShareSwarm {
  private nextN = 1;
  readonly ids = new Map<string, number>();
  readonly browsers = new Map<string, BrowserState>();
  readonly announced = new Map<string, AnnouncedPeer>();
  /** Last row + time it was last current, for the 30 s linger. */
  readonly recent = new Map<string, { row: SwarmPeer; at: number }>();
  /** Upload ledger and completions are kept until the share becomes inactive (not on idle), so a
   * peer that comes back after an idle gap is not counted twice. Both are bounded. */
  readonly lastUploaded = new Map<string, number>();
  readonly completed = new Set<string>();
  /** Times of counted completions in the last hour (rate cap). */
  completionTimes: number[] = [];
  readonly sockets = new Set<LiveSocket>();
  readonly webseedMeter = new RateMeter();
  pending: Pending = { webseed: 0, p2p: 0, peerBytes: 0, completed: 0, peak: 0, lastActivity: null };
  broadcastTimer: NodeJS.Timeout | undefined;

  constructor(readonly shareId: string) {}

  n(peerId: string): number {
    let n = this.ids.get(peerId);
    if (n === undefined) {
      evictOldest(this.ids, 4 * MAX_PEERS_PER_SHARE);
      n = this.nextN++;
      this.ids.set(peerId, n);
    }
    return n;
  }

  /** Nothing live and nothing pending. The ledger (lastUploaded/completed) may still be set. */
  isIdle(): boolean {
    const p = this.pending;
    return (
      this.sockets.size === 0 &&
      this.browsers.size === 0 &&
      this.announced.size === 0 &&
      this.recent.size === 0 &&
      p.webseed === 0 &&
      p.p2p === 0 &&
      p.peerBytes === 0 &&
      p.completed === 0 &&
      p.lastActivity === null
    );
  }
}

export interface SwarmTimings {
  helloTimeoutMs: number;
  lingerMs: number;
}

export interface SwarmDeps {
  shares: ShareStore;
  /** Seeder torrent + server peer id for a share (undefined when not seeding). */
  seedTorrent: (shareId: string) => WtTorrent | undefined;
  serverPeerId: () => string | undefined;
}

export class SwarmStats {
  private readonly states = new Map<string, ShareSwarm>();
  private readonly persisted = new Map<string, ShareStatsRow>();
  private readonly log;

  private readonly timings: SwarmTimings;

  constructor(
    private readonly ctx: AppContext,
    private readonly deps: SwarmDeps,
    timings: Partial<SwarmTimings> = {},
    private readonly now: () => number = Date.now,
  ) {
    this.log = ctx.log.child({ mod: 'swarm' });
    this.timings = { helloTimeoutMs: HELLO_TIMEOUT_MS, lingerMs: LINGER_MS, ...timings };
  }

  private state(shareId: string): ShareSwarm {
    let s = this.states.get(shareId);
    if (!s) this.states.set(shareId, (s = new ShareSwarm(shareId)));
    return s;
  }

  // ---------- byte / event accounting ----------

  addWebseed(shareId: string, bytes: number): void {
    const s = this.state(shareId);
    s.pending.webseed += bytes;
    s.webseedMeter.add(bytes);
    s.pending.lastActivity = this.now();
  }

  addP2p(shareId: string, bytes: number): void {
    const s = this.state(shareId);
    s.pending.p2p += bytes;
    s.pending.lastActivity = this.now();
  }

  /** Peer-reported cumulative `uploaded` → delta (monotonic per peer id; decreases ignored). */
  private peerUploaded(s: ShareSwarm, peerId: string, uploaded: number): void {
    if (!finiteNonNeg(uploaded)) return;
    const prev = s.lastUploaded.get(peerId) ?? 0;
    if (uploaded > prev) {
      s.pending.peerBytes += Math.min(uploaded - prev, MAX_NUM);
      if (!s.lastUploaded.has(peerId)) evictOldest(s.lastUploaded, MAX_PEERS_PER_SHARE);
      s.lastUploaded.set(peerId, uploaded);
      s.pending.lastActivity = this.now();
    }
  }

  private markCompleted(s: ShareSwarm, peerId: string, kind: 'browser' | 'client'): void {
    if (s.completed.has(peerId)) return;
    const now = this.now();
    s.completionTimes = s.completionTimes.filter((t) => now - t < HOUR_MS);
    if (s.completionTimes.length >= MAX_COMPLETIONS_PER_HOUR) return;
    s.completionTimes.push(now);
    evictOldest(s.completed, MAX_PEERS_PER_SHARE);
    s.completed.add(peerId);
    s.pending.completed += 1;
    s.pending.lastActivity = this.now();
    try {
      this.deps.shares.event(s.shareId, 'completed', { kind });
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'could not record completion');
    }
  }

  onAnnounce(a: AnnounceInfo): void {
    if (!PEER_ID_RE.test(a.peerId)) return;
    const s = this.state(a.shareId);
    if (a.event === 'stop') {
      s.announced.delete(a.peerId);
      return;
    }
    // Only a peer that announced before can complete (a lone `event=completed` is not a download).
    const prev = s.announced.get(a.peerId);
    if (prev) s.announced.delete(a.peerId); // re-insert below: keeps the map ordered oldest-first
    else evictOldest(s.announced, MAX_PEERS_PER_SHARE);
    const begun = prev?.begun === true;
    s.announced.set(a.peerId, { type: a.type, left: a.left, uploaded: a.uploaded, lastSeen: this.now(), begun: begun || a.event !== 'complete' });
    this.peerUploaded(s, a.peerId, a.uploaded);
    if (a.event === 'complete' && begun) this.markCompleted(s, a.peerId, a.type === 'ws' ? 'browser' : 'client');
    s.pending.lastActivity = this.now();
  }

  // ---------- stats ----------

  private persistedRow(shareId: string): ShareStatsRow {
    let r = this.persisted.get(shareId);
    if (!r) {
      r =
        (this.ctx.db.prepare('SELECT * FROM share_stats WHERE share_id = ?').get(shareId) as ShareStatsRow | undefined) ??
        ({
          share_id: shareId,
          server_bytes_webseed: 0,
          server_bytes_p2p: 0,
          peer_bytes: 0,
          completed_downloads: 0,
          peak_swarm: 0,
          last_activity_at: null,
        } satisfies ShareStatsRow);
      this.persisted.set(shareId, r);
    }
    return r;
  }

  /** Persisted + not-yet-flushed stats. */
  statsDto(shareId: string): ShareStatsDto {
    const r = this.persistedRow(shareId);
    const p = this.states.get(shareId)?.pending;
    const la = p?.lastActivity ?? null;
    return {
      serverBytesWebseed: r.server_bytes_webseed + (p?.webseed ?? 0),
      serverBytesP2p: r.server_bytes_p2p + (p?.p2p ?? 0),
      peerBytes: r.peer_bytes + (p?.peerBytes ?? 0),
      completedDownloads: r.completed_downloads + (p?.completed ?? 0),
      peakSwarm: Math.max(r.peak_swarm, p?.peak ?? 0),
      lastActivityAt: la === null ? r.last_activity_at : Math.max(r.last_activity_at ?? 0, la),
    };
  }

  /** Write pending deltas to share_stats (one transaction). */
  flush(): void {
    const dirty = [...this.states.values()].filter((s) => {
      const p = s.pending;
      return p.webseed || p.p2p || p.peerBytes || p.completed || p.peak || p.lastActivity !== null;
    });
    if (dirty.length === 0) return;
    const db = this.ctx.db;
    const ins = db.prepare('INSERT INTO share_stats (share_id) VALUES (?) ON CONFLICT(share_id) DO NOTHING');
    const upd = db.prepare(
      `UPDATE share_stats SET
         server_bytes_webseed = server_bytes_webseed + @webseed,
         server_bytes_p2p = server_bytes_p2p + @p2p,
         peer_bytes = peer_bytes + @peerBytes,
         completed_downloads = completed_downloads + @completed,
         peak_swarm = MAX(peak_swarm, @peak),
         last_activity_at = CASE WHEN @lastActivity IS NULL THEN last_activity_at
                                 ELSE MAX(COALESCE(last_activity_at, 0), @lastActivity) END
       WHERE share_id = @id`,
    );
    try {
      db.transaction(() => {
        for (const s of dirty) {
          ins.run(s.shareId);
          upd.run({ id: s.shareId, ...s.pending });
        }
      })();
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'share_stats flush failed');
      return;
    }
    for (const s of dirty) {
      s.pending = { webseed: 0, p2p: 0, peerBytes: 0, completed: 0, peak: 0, lastActivity: null };
      this.persisted.delete(s.shareId);
    }
  }

  // ---------- snapshots ----------

  private wireProgress(w: WtWire, t: WtTorrent): number {
    const n = t.pieces.length;
    if (n === 0) return 0;
    let have = 0;
    for (let i = 0; i < n; i++) if (w.peerPieces.get(i)) have++;
    return have / n;
  }

  /** Current snapshot for an active share (undefined if unknown/revoked/expired). */
  snapshot(shareId: string): SwarmSnapshot | undefined {
    const row = this.deps.shares.getRow(shareId);
    const now = this.now();
    if (!row || shareState(row, now) !== 'active') return undefined;
    const s = this.state(shareId);
    const total = this.deps.shares.info(row).totalBytes;
    const torrent = this.deps.seedTorrent(shareId);
    const spid = this.deps.serverPeerId();
    const stats = this.statsDto(shareId);

    const current = new Map<string, SwarmPeer>();
    const label = (peerId: string, kind: 'browser' | 'client', nick?: string): string =>
      kind === 'client' ? 'Torrent client' : (nick ?? `Friend ${s.n(peerId)}`);

    for (const b of s.browsers.values()) {
      if (!b.socket) continue;
      current.set(b.peerId, {
        id: `p${s.n(b.peerId)}`,
        label: label(b.peerId, 'browser', b.nick),
        kind: 'browser',
        progress: b.progress,
        down: b.down,
        up: b.up,
        uploaded: b.uploaded,
      });
    }
    for (const w of torrent?.wires ?? []) {
      const pid = w.peerId;
      if (!pid || pid === spid || w.type === 'webSeed' || current.has(pid)) continue;
      const kind = w.type === 'webrtc' ? 'browser' : 'client';
      const ann = s.announced.get(pid);
      current.set(pid, {
        id: `p${s.n(pid)}`,
        label: label(pid, kind),
        kind,
        progress: this.wireProgress(w, torrent!),
        down: Math.round(w.uploadSpeed()),
        up: Math.round(w.downloadSpeed()),
        uploaded: ann?.uploaded ?? s.lastUploaded.get(pid) ?? 0,
      });
    }
    for (const [pid, a] of s.announced) {
      if (now - a.lastSeen > ANNOUNCE_TTL_MS[a.type]) {
        s.announced.delete(pid);
        continue;
      }
      if (pid === spid || current.has(pid)) continue;
      const kind = a.type === 'ws' ? 'browser' : 'client';
      const progress = total > 0 && Number.isFinite(a.left) ? Math.min(1, Math.max(0, 1 - a.left / total)) : a.left === 0 ? 1 : 0;
      current.set(pid, { id: `p${s.n(pid)}`, label: label(pid, kind), kind, progress, down: 0, up: 0, uploaded: a.uploaded });
    }

    for (const [pid, r] of current) s.recent.set(pid, { row: r, at: now });
    const peers: SwarmPeer[] = [];
    for (const [pid, rec] of s.recent) {
      const cur = current.get(pid);
      if (cur) peers.push(cur);
      else if (now - rec.at < this.timings.lingerMs) peers.push({ ...rec.row, down: 0, up: 0 });
      else {
        s.recent.delete(pid);
        s.ids.delete(pid);
        const b = s.browsers.get(pid);
        if (b && !b.socket) s.browsers.delete(pid);
      }
    }
    for (const [pid, b] of s.browsers) if (!b.socket && !s.recent.has(pid)) s.browsers.delete(pid);

    const server: SwarmPeer = {
      id: 'srv',
      label: 'Server',
      kind: 'server',
      progress: 1,
      down: 0,
      up: Math.round((torrent?.uploadSpeed ?? 0) + s.webseedMeter.rate()),
      uploaded: stats.serverBytesP2p + stats.serverBytesWebseed,
    };
    const all = [server, ...peers];
    if (all.length > s.pending.peak && all.length > stats.peakSwarm) s.pending.peak = all.length;
    return {
      peers: all,
      totals: {
        peers: all.length,
        serverBytes: stats.serverBytesP2p + stats.serverBytesWebseed,
        peerBytes: stats.peerBytes,
        completed: stats.completedDownloads,
      },
    };
  }

  /** Shares worth looking at: in-memory state or a seeded torrent with wires. */
  private interestingShares(seeded: string[]): string[] {
    const ids = new Set(this.states.keys());
    for (const id of seeded) if ((this.deps.seedTorrent(id)?.wires.length ?? 0) > 0) ids.add(id);
    return [...ids];
  }

  /** Periodic work (~1.5 s): broadcast to live sockets, track peaks, drop idle state. */
  tick(seeded: string[]): void {
    for (const id of this.interestingShares(seeded)) {
      const snap = this.snapshot(id);
      const s = this.states.get(id);
      if (!s) continue;
      if (!snap) {
        // Share no longer active: disconnect live sockets; keep pending bytes until flushed.
        this.closeShare(id, 4404);
        s.browsers.clear();
        s.announced.clear();
        s.recent.clear();
        s.lastUploaded.clear();
        s.completed.clear();
      } else {
        this.broadcast(s, snap);
      }
      // An active share keeps its ledger while idle; only drop state that holds nothing at all.
      if (s.isIdle() && s.lastUploaded.size === 0 && s.completed.size === 0) this.states.delete(id);
    }
  }

  allSnapshots(activeIds: string[]): Record<string, SwarmSnapshot> {
    const out: Record<string, SwarmSnapshot> = {};
    for (const id of activeIds) {
      const snap = this.snapshot(id);
      if (snap) out[id] = snap;
    }
    return out;
  }

  // ---------- live WebSocket (/api/s/:shareId/live) ----------

  private broadcast(s: ShareSwarm, snap: SwarmSnapshot): void {
    for (const sock of s.sockets) {
      if (!sock.fsPeerId || sock.readyState !== 1 || sock.bufferedAmount > 1024 * 1024) continue;
      const msg: ServerMsg = { t: 'swarm', you: `p${s.n(sock.fsPeerId)}`, ...snap };
      sock.send(JSON.stringify(msg));
    }
  }

  private scheduleBroadcast(shareId: string): void {
    const s = this.states.get(shareId);
    if (!s || s.broadcastTimer) return;
    s.broadcastTimer = setTimeout(() => {
      s.broadcastTimer = undefined;
      const snap = this.snapshot(shareId);
      if (snap) this.broadcast(s, snap);
    }, 100);
    s.broadcastTimer.unref?.();
  }

  /** Close every live socket of a share (revoked/expired → 4404). */
  closeShare(shareId: string, code: number): void {
    const s = this.states.get(shareId);
    if (!s) return;
    for (const sock of s.sockets) sock.close(code, code === 4404 ? 'gone' : 'closed');
  }

  /** Close live sockets authenticated with an older token_version (→ 4401). */
  closeStale(shareId: string, tokenVersion: number): void {
    const s = this.states.get(shareId);
    if (!s) return;
    for (const sock of s.sockets) if (sock.fsTokenVersion !== undefined && sock.fsTokenVersion !== tokenVersion) sock.close(4401, 'token');
  }

  closeAll(): void {
    for (const s of this.states.values()) {
      if (s.broadcastTimer) clearTimeout(s.broadcastTimer);
      for (const sock of s.sockets) sock.terminate();
    }
  }

  async register(app: FastifyInstance): Promise<void> {
    app.route<{ Params: { shareId: string } }>({
      method: 'GET',
      url: '/api/s/:shareId/live',
      handler: (_req, reply) => reply.code(404).send({ error: 'not_found' }),
      wsHandler: (socket: WebSocket, req) => this.onLive(socket as LiveSocket, (req.params as { shareId: string }).shareId),
    });
  }

  private onLive(sock: LiveSocket, routeShareId: string): void {
    let s: ShareSwarm | undefined;
    let peer: BrowserState | undefined;
    let windowStart = this.now();
    let msgs = 0;
    let statsMsgs = 0;
    let nickMsgs = 0;
    const helloTimer = setTimeout(() => sock.close(4401, 'hello timeout'), this.timings.helloTimeoutMs);

    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(helloTimer);
      if (!s) return;
      s.sockets.delete(sock);
      if (peer && peer.socket === sock) {
        peer.socket = undefined;
        this.scheduleBroadcast(s.shareId);
      }
    });

    sock.on('message', (data: Buffer, isBinary: boolean) => {
      const now = this.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        msgs = statsMsgs = nickMsgs = 0;
      }
      if (++msgs > MAX_MSGS_PER_SEC) return sock.close(1008, 'too many messages');
      if (isBinary || data.length > MAX_MSG_CHARS) return sock.close(1008, 'bad message');
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString('utf8')) as ClientMsg;
      } catch {
        return sock.close(1008, 'bad message');
      }
      if (!msg || typeof msg !== 'object') return sock.close(1008, 'bad message');

      if (!peer) {
        if (msg.t !== 'hello') return sock.close(4401, 'hello first');
        clearTimeout(helloTimer);
        const auth = this.deps.shares.authorize(typeof msg.token === 'string' ? msg.token : '');
        if (!auth.ok) return sock.close(auth.reason === 'gone' ? 4404 : 4401, auth.reason);
        if (auth.share.id !== routeShareId) return sock.close(4401, 'invalid');
        const peerId = typeof msg.peerId === 'string' ? msg.peerId.toLowerCase() : '';
        if (!PEER_ID_RE.test(peerId) || peerId === this.deps.serverPeerId()) return sock.close(1008, 'bad peerId');
        s = this.state(auth.share.id);
        if (s.sockets.size >= MAX_SOCKETS_PER_SHARE) return sock.close(1013, 'busy');
        sock.fsPeerId = peerId;
        sock.fsTokenVersion = auth.share.token_version;
        s.sockets.add(sock);
        const prev = s.browsers.get(peerId);
        if (prev?.socket && prev.socket !== sock) prev.socket.close(1000, 'replaced');
        peer = prev ?? { peerId, progress: 0, down: 0, up: 0, uploaded: 0, done: false };
        peer.socket = sock;
        const nick = sanitizeNick(msg.nick);
        if (nick) peer.nick = nick;
        s.browsers.set(peerId, peer);
        s.n(peerId);
        s.pending.lastActivity = now;
        this.scheduleBroadcast(s.shareId);
        return;
      }

      if (msg.t === 'stats') {
        if (++statsMsgs > MAX_STATS_PER_SEC) return;
        const { progress, down, up, uploaded, downloaded, done } = msg;
        if (![progress, down, up, uploaded, downloaded].every(finiteNonNeg) || typeof done !== 'boolean') return;
        peer.progress = Math.min(1, progress);
        peer.down = Math.min(down, MAX_NUM);
        peer.up = Math.min(up, MAX_NUM);
        peer.uploaded = Math.min(uploaded, MAX_NUM);
        this.peerUploaded(s!, peer.peerId, peer.uploaded);
        if (done && !peer.done) this.markCompleted(s!, peer.peerId, 'browser');
        peer.done = done;
      } else if (msg.t === 'nick') {
        if (++nickMsgs > 1) return;
        const nick = sanitizeNick(msg.nick);
        if (nick) peer.nick = nick;
        else delete peer.nick;
        this.scheduleBroadcast(s!.shareId);
      }
      // A repeated hello or unknown types are ignored.
    });
  }
}
