// In-process BitTorrent tracker (docs/ARCHITECTURE.md §7.1, §9, §11): bittorrent-tracker `Server` with
// no listeners of its own, mounted on the public Fastify app:
//   GET /tr/:token/announce   HTTP announce (torrent clients)
//   GET /tr/:token (WS)       WebSocket tracker (browsers + the server's own WebRTC peer)
// Every announce is checked by `filter`: valid token AND share active (re-checked each time) AND
// info_hash == that share's infohash. IPs stay inside bittorrent-tracker's in-memory swarm (needed
// to hand out HTTP peers); nothing here logs or persists them.
import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type { AppContext } from '../context.js';
import { IpRateLimiter, type Window } from './ratelimit.js';
import type { ShareStore } from './shares.js';
import { rewriteServerSignal } from './sdp.js';
import { bencode, TrackerServerCtor, type TrackerParams, type TrackerServer, type TrackerSwarm } from './vendor.js';

export type AnnounceEvent = 'start' | 'update' | 'complete' | 'stop' | 'pause';

/** Announce data forwarded to swarm stats. Keyed by peer id; never contains an IP. */
export interface AnnounceInfo {
  shareId: string;
  peerId: string;
  type: 'http' | 'ws';
  event: AnnounceEvent;
  left: number;
  uploaded: number;
  downloaded: number;
  /** Name of the recipient whose token the peer announces with (recipient tokens, §9). */
  name?: string;
}

interface ConnCtx {
  shareId: string;
  tokenVersion: number;
  token: string;
  /** Announce from our own seeder (internal secret matched). */
  isServer: boolean;
  /** Client IP per Fastify's trustProxy rules (HTTP only; memory only). */
  ip?: string;
  /** Recipient name from a recipient token. */
  name?: string;
}

type TrackedSocket = WebSocket & { fsCtx?: ConnCtx; upgradeReq?: unknown; peerId?: string | null };

export interface TrackerOptions {
  /** Random per-process secret; the seeder appends `~<secret>` to its token path segment. */
  internalSecret: string;
  /** Hex peer id of the server's own WebTorrent client, once started. */
  serverPeerId: () => string | undefined;
  onAnnounce: (a: AnnounceInfo) => void;
  /** WEBRTC_ANNOUNCE_IP ('' = off). */
  announceIp: string;
  webrtcPort: number;
  /** HTTP announce limit per client IP (default ANNOUNCE_LIMIT). */
  announceLimit?: Window;
  /** WebSocket tracker connection caps (defaults MAX_WS_PER_SHARE / MAX_WS_TOTAL). */
  maxWsPerShare?: number;
  maxWsTotal?: number;
}

const DENIED = 'access denied';
/** HTTP announces per client IP per minute (clients normally announce every few minutes). */
export const ANNOUNCE_LIMIT: Window = { max: 60, windowMs: 60_000 };
export const MAX_WS_PER_SHARE = 500;
export const MAX_WS_TOTAL = 5000;
const PUBLIC_IP_TTL_MS = 5 * 60_000;

/** Strip share tokens / secrets from library messages before they go anywhere near a log. */
export function scrub(msg: unknown): string {
  return String(msg)
    .replace(/\/(tr|ws)\/[A-Za-z0-9_.~%-]+/g, '/$1/[token]')
    .replace(/([?&]t=)[A-Za-z0-9_.~%-]+/g, '$1[token]')
    .slice(0, 300);
}

function normalizeIp(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
}

function setPeerIp(params: TrackerParams, ip: string): void {
  params.ip = ip;
  params.addr = `${isIP(ip) === 6 ? `[${ip}]` : ip}:${params.port}`;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export class TrackerService {
  readonly server: TrackerServer;
  private readonly sockets = new Map<string, Set<TrackedSocket>>();
  /** Per-IP HTTP announce limiter (IPs HMAC'd in memory only). */
  readonly announceLimiter: IpRateLimiter;
  private readonly secret: Buffer;
  private publicIp: { ip: string | undefined; at: number } | undefined;

  constructor(
    private readonly ctx: AppContext,
    private readonly shares: ShareStore,
    private readonly opts: TrackerOptions,
  ) {
    this.secret = Buffer.from(opts.internalSecret);
    this.announceLimiter = new IpRateLimiter(opts.announceLimit ?? ANNOUNCE_LIMIT);
    this.server = new TrackerServerCtor({
      http: false,
      udp: false,
      ws: false,
      stats: false,
      // We set the client IP ourselves from Fastify's req.ip (which honours the trusted-proxy list);
      // bittorrent-tracker's own trustProxy would trust any X-Forwarded-For blindly.
      trustProxy: false,
      filter: (infoHash, params, cb) => this.filter(infoHash, params, cb),
    });
    const log = ctx.log;
    this.server.on('warning', (err: unknown) => log.debug({ msg2: scrub((err as Error)?.message ?? err) }, 'tracker warning'));
    this.server.on('error', (err: unknown) => log.warn({ msg2: scrub((err as Error)?.message ?? err) }, 'tracker error'));
    for (const ev of ['start', 'update', 'complete', 'stop', 'pause'] as const) {
      this.server.on(ev, (_addr: unknown, params: TrackerParams) => this.emitAnnounce(ev, params));
    }
    if (opts.announceIp) {
      if (!isIP(opts.announceIp)) throw new Error('WEBRTC_ANNOUNCE_IP is not a valid IP address');
      // Rewrite SDPs relayed from the server's own peer (feature flag; off by default).
      const orig = this.server._onWebSocketRequest.bind(this.server);
      this.server._onWebSocketRequest = (socket: unknown, o: unknown, raw: unknown) => {
        const c = (socket as TrackedSocket).fsCtx;
        const spid = this.opts.serverPeerId();
        if (c?.isServer && spid) raw = rewriteServerSignal(raw, Buffer.from(spid, 'hex').toString('latin1'), opts.announceIp, opts.webrtcPort);
        orig(socket, o, raw);
      };
    }
  }

  private ctxOf(params: TrackerParams): ConnCtx | undefined {
    return (params.httpReq?.fsCtx ?? params.socket?.fsCtx) as ConnCtx | undefined;
  }

  private emitAnnounce(event: AnnounceEvent, params: TrackerParams): void {
    const c = this.ctxOf(params);
    if (!c || c.isServer) return;
    const spid = this.opts.serverPeerId();
    if (spid && params.peer_id === spid) return;
    this.opts.onAnnounce({
      shareId: c.shareId,
      peerId: params.peer_id,
      type: params.type,
      event,
      left: Number.isFinite(params.left) ? Math.max(0, params.left) : Number.POSITIVE_INFINITY,
      uploaded: num(params.uploaded),
      downloaded: num(params.downloaded),
      ...(c.name ? { name: c.name } : {}),
    });
  }

  private filter(infoHash: string, params: TrackerParams, cb: (err: Error | null) => void): void {
    const c = this.ctxOf(params);
    if (!c) return cb(new Error(DENIED));
    const auth = this.shares.authorize(c.token);
    if (!auth.ok || auth.share.id !== c.shareId || auth.share.info_hash !== infoHash) return cb(new Error(DENIED));
    const spid = this.opts.serverPeerId();
    // Nobody but our seeder may use the server's peer id (would hijack its swarm slot).
    if (spid && params.peer_id === spid && !c.isServer) return cb(new Error(DENIED));
    if (params.type === 'http') {
      if (c.isServer) {
        // The seeder announces over loopback; advertise the public address to torrent clients.
        void this.serverPublicIp().then((ip) => {
          if (ip) setPeerIp(params, ip);
          cb(null);
        });
        return;
      }
      if (c.ip) setPeerIp(params, c.ip);
    }
    cb(null);
  }

  /** WEBRTC_ANNOUNCE_IP if set, else the PUBLIC_BASE_URL host's IPv4 (cached), else undefined. */
  private async serverPublicIp(): Promise<string | undefined> {
    if (this.opts.announceIp) return this.opts.announceIp;
    const now = Date.now();
    if (this.publicIp && now - this.publicIp.at < PUBLIC_IP_TTL_MS) return this.publicIp.ip;
    const host = this.ctx.config.publicBaseUrl.hostname.replace(/^\[|\]$/g, '');
    let ip: string | undefined;
    if (isIP(host)) ip = host;
    else {
      try {
        ip = (await lookup(host, { family: 4 })).address;
      } catch {
        ip = undefined;
      }
    }
    this.publicIp = { ip, at: now };
    return ip;
  }

  /** Parse `<token>` or `<token>~<internal secret>`. */
  private parseTokenSegment(seg: string): { token: string; isServer: boolean } {
    const i = seg.indexOf('~');
    if (i < 0) return { token: seg, isServer: false };
    const given = Buffer.from(seg.slice(i + 1));
    const isServer = given.length === this.secret.length && timingSafeEqual(given, this.secret);
    return { token: seg.slice(0, i), isServer };
  }

  private connCtx(seg: string, req: FastifyRequest): ConnCtx | { reject: 'invalid' | 'gone' } {
    const { token, isServer } = this.parseTokenSegment(seg);
    const auth = this.shares.authorize(token);
    if (!auth.ok) return { reject: auth.reason };
    const ctx: ConnCtx = { shareId: auth.share.id, tokenVersion: auth.share.token_version, token, isServer, ip: normalizeIp(req.ip) };
    if (auth.recipient) ctx.name = auth.recipient.name;
    return ctx;
  }

  async register(app: FastifyInstance): Promise<void> {
    const failure = Buffer.from(bencode.encode({ 'failure reason': DENIED }));
    const limited = Buffer.from(bencode.encode({ 'failure reason': 'rate limited', interval: 600 }));
    const perShare = this.opts.maxWsPerShare ?? MAX_WS_PER_SHARE;
    const total = this.opts.maxWsTotal ?? MAX_WS_TOTAL;

    app.route<{ Params: { token: string } }>({
      method: 'GET',
      url: '/tr/:token/announce',
      handler: (req, reply) => {
        // Our own seeder (internal secret) is never limited; everyone else per client IP.
        if (!this.parseTokenSegment(req.params.token).isServer && !this.announceLimiter.hit(normalizeIp(req.ip) ?? 'unknown')) {
          return reply.code(429).header('Retry-After', '60').header('Cache-Control', 'no-store').type('text/plain').send(limited);
        }
        const c = this.connCtx(req.params.token, req);
        if ('reject' in c) {
          return reply.code(200).header('Cache-Control', 'no-store').type('text/plain').send(failure);
        }
        (req.raw as unknown as { fsCtx: ConnCtx }).fsCtx = c;
        reply.hijack();
        reply.raw.setHeader('Content-Type', 'text/plain');
        reply.raw.setHeader('Cache-Control', 'no-store');
        reply.raw.setHeader('X-Content-Type-Options', 'nosniff');
        this.server.onHttpRequest(req.raw, reply.raw, { action: 'announce' });
      },
    });

    app.route<{ Params: { token: string } }>({
      method: 'GET',
      url: '/tr/:token',
      handler: (_req, reply) => reply.code(404).send({ error: 'not_found' }),
      wsHandler: (socket: WebSocket, req) => {
        const s = socket as TrackedSocket;
        const c = this.connCtx((req.params as { token: string }).token, req);
        if ('reject' in c) {
          s.close(c.reject === 'gone' ? 4404 : 4401, c.reject);
          return;
        }
        let set = this.sockets.get(c.shareId);
        if (!c.isServer && ((set?.size ?? 0) >= perShare || this.wsCount() >= total)) {
          s.close(1013, 'busy');
          return;
        }
        s.fsCtx = c;
        s.upgradeReq = req.raw;
        if (!set) this.sockets.set(c.shareId, (set = new Set()));
        set.add(s);
        // Registered before the tracker's own close handler, so `peerId` is still set here.
        s.on('close', () => {
          this.sockets.get(c.shareId)?.delete(s);
          if (!c.isServer && typeof s.peerId === 'string') {
            this.opts.onAnnounce({ shareId: c.shareId, peerId: s.peerId, type: 'ws', event: 'stop', left: 0, uploaded: 0, downloaded: 0 });
          }
        });
        this.server.onWebSocketConnection(s);
      },
    });
  }

  /** Open tracker WebSockets across all shares. */
  wsCount(): number {
    let n = 0;
    for (const set of this.sockets.values()) n += set.size;
    return n;
  }

  /** Live revocation: forget the swarm and disconnect its WebSocket peers. */
  dropShare(shareId: string, infoHash: string): void {
    delete this.server.torrents[infoHash];
    const set = this.sockets.get(shareId);
    if (set) for (const s of set) s.close(4404, 'gone');
    this.sockets.delete(shareId);
  }

  /** Disconnect WebSocket peers holding a token from an older token_version. */
  closeStale(shareId: string, tokenVersion: number): void {
    const set = this.sockets.get(shareId);
    if (!set) return;
    for (const s of set) if (s.fsCtx && s.fsCtx.tokenVersion !== tokenVersion) s.close(4401, 'token');
  }

  swarm(infoHash: string): TrackerSwarm | undefined {
    return this.server.torrents[infoHash];
  }

  close(): void {
    for (const set of this.sockets.values()) for (const s of set) s.terminate();
    this.sockets.clear();
    this.server.close();
  }
}
