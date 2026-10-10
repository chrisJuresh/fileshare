// Server-side seeder (docs/ARCHITECTURE.md §11): one WebTorrent client; every ACTIVE share's torrent
// is added from its stored info dict with skipVerify (never re-hashed) over a read-only store rooted
// at /state/seedlinks/<shareId>. It announces to OUR tracker over loopback (same tracker instance as
// the public URLs) with a valid share token plus the internal secret, so the tracker can tell the
// server's own peer apart.
import { realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
// @ts-ignore untyped package
import WebTorrentImpl from 'webtorrent';
import type { AppContext } from '../context.js';
import type { ShareRow } from '../db/index.js';
import { installIceGatheringFix } from './ice.js';
import type { Limiter } from './limiter.js';
import { bencode } from './vendor.js';
import type { ShareStore } from './shares.js';
import { ReadOnlyStore } from './store.js';
import { scrub } from './tracker.js';

/** Minimal typing of the WebTorrent 3 objects we touch. */
export interface WtWire {
  type: string;
  peerId?: string;
  uploaded: number;
  downloaded: number;
  uploadSpeed(): number;
  downloadSpeed(): number;
  peerPieces: { get(i: number): boolean };
}

export interface WtTorrent {
  infoHash: string;
  ready: boolean;
  done: boolean;
  uploaded: number;
  uploadSpeed: number;
  pieces: unknown[];
  wires: WtWire[];
  numPeers: number;
  on(ev: string, fn: (...a: any[]) => void): void;
  once(ev: string, fn: (...a: any[]) => void): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
}

export interface WtClient {
  peerId: string;
  torrents: WtTorrent[];
  throttleGroups: { up: unknown; down: unknown };
  listening: boolean;
  destroyed: boolean;
  add(t: Uint8Array, opts: Record<string, unknown>): WtTorrent;
  remove(t: WtTorrent, opts: { destroyStore: false }, cb: (err?: Error) => void): Promise<void>;
  address(): { port: number } | null;
  on(ev: string, fn: (...a: any[]) => void): void;
  once(ev: string, fn: (...a: any[]) => void): void;
  removeListener(ev: string, fn: (...a: any[]) => void): void;
  destroy(cb?: (err?: Error) => void): void;
}

export const WebTorrent = WebTorrentImpl as new (opts: Record<string, unknown>) => WtClient;

export interface SeederOptions {
  btPort: number;
  webrtcPort: number;
  stunUrls: string[];
  /** e.g. `127.0.0.1:8090` — where the public listener can be reached over loopback. */
  internalHost: string;
  internalSecret: string;
  /** Unchoke slots per torrent. */
  uploads?: number;
  /** WebRTC ICE bind address. */
  rtcBindAddress?: string;
  /** Called with bytes actually written to peers (after the throttle). */
  onUpload: (shareId: string, bytes: number) => void;
}

interface Entry {
  torrent: WtTorrent;
  tokenVersion: number;
}

export function internalAnnounceHost(bind: string, port: number): string {
  const host = bind === '0.0.0.0' || bind === '' ? '127.0.0.1' : bind === '::' ? '::1' : bind;
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

/** .torrent for the seeder's own use: announces only to the internal (loopback) tracker URLs. */
export function buildInternalTorrent(info: Uint8Array, announce: string[]): Buffer {
  const head = bencode.encode({ announce: announce[0], 'announce-list': announce.map((a) => [a]) });
  return Buffer.concat([head.subarray(0, head.length - 1), Buffer.from('4:info'), info, Buffer.from('e')]);
}

export class Seeder {
  client: WtClient | undefined;
  private readonly entries = new Map<string, Entry>();
  private libraryReal = '';
  private readonly log;

  constructor(
    private readonly ctx: AppContext,
    private readonly shares: ShareStore,
    private readonly limiter: Limiter,
    private readonly opts: SeederOptions,
  ) {
    this.log = ctx.log.child({ mod: 'seeder' });
  }

  get peerId(): string | undefined {
    return this.client?.peerId;
  }

  /** Bound BitTorrent TCP/uTP port (useful when BT_PORT is 0 in tests). */
  get port(): number | undefined {
    return this.client?.address()?.port;
  }

  async start(): Promise<void> {
    if (this.client) return;
    this.libraryReal = await realpath(this.ctx.config.paths.library);
    // Answer WebRTC offers as soon as ICE gathering is complete (not after simple-peer's 5 s timer).
    installIceGatheringFix();
    const rtcConfig = {
      iceServers: this.opts.stunUrls.map((urls) => ({ urls })),
      portRangeBegin: this.opts.webrtcPort,
      portRangeEnd: this.opts.webrtcPort,
      enableIceUdpMux: true,
      bindAddress: this.opts.rtcBindAddress ?? '0.0.0.0',
    };
    const client = new WebTorrent({
      dht: false,
      lsd: false,
      utPex: false,
      natUpnp: false,
      natPmp: false,
      webSeeds: false,
      torrentPort: this.opts.btPort,
      // MSE/PE allowed with plaintext fallback. Without native RC4 (Node 22, no legacy provider) the JS
      // RC4 fallback measured ~455 MiB/s on one core — far above any home upload cap — so keep it on.
      secure: 1,
      // NOTE: keep seedOutgoingConnections at its default (true). WebRTC peers answered via the WS
      // tracker arrive through the same discovery 'peer' path, and `false` drops them for seeds.
      // The server still never dials out: numwant=0 means the tracker hands it no peers.
      tracker: { rtcConfig, getAnnounceOpts: () => ({ numwant: 0 }) },
    });
    // ONE bucket: replace WebTorrent's upload throttle group with the shared limiter group. Peers read
    // `client.throttleGroups` when they are created, so this must happen before any torrent is added.
    const own = client.throttleGroups.up as { destroy(): void };
    client.throttleGroups.up = this.limiter.group;
    own.destroy();
    client.on('error', (err: Error) => this.log.error({ err: scrub(err?.message) }, 'webtorrent client error'));
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error) => reject(err);
      client.once('error', onErr);
      client.once('listening', () => {
        client.removeListener('error', onErr);
        resolve();
      });
    });
    this.client = client;
    this.log.info({ btPort: this.port, webrtcPort: this.opts.webrtcPort }, 'seeder listening');
  }

  torrent(shareId: string): WtTorrent | undefined {
    return this.entries.get(shareId)?.torrent;
  }

  shareIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Make sure an active share is seeded with its current token version (re-add on change). */
  async ensure(row: ShareRow): Promise<void> {
    const client = this.client;
    if (!client) return;
    const cur = this.entries.get(row.id);
    if (cur && cur.tokenVersion === row.token_version) return;
    if (cur) await this.remove(row.id);
    const token = this.shares.token(row);
    const seg = `${token}~${this.opts.internalSecret}`;
    const announce = [`ws://${this.opts.internalHost}/tr/${seg}`, `http://${this.opts.internalHost}/tr/${seg}/announce`];
    const buf = buildInternalTorrent(row.info, announce);
    const shareId = row.id;
    const torrent = client.add(buf, {
      path: this.shares.seedRoot(shareId),
      skipVerify: true,
      store: ReadOnlyStore,
      storeOpts: { allowedRoot: this.libraryReal },
      storeCacheSlots: 0,
      uploads: this.opts.uploads ?? 64,
      private: true,
    });
    this.entries.set(shareId, { torrent, tokenVersion: row.token_version });
    torrent.on('upload', (n: number) => this.opts.onUpload(shareId, n));
    torrent.on('error', (err: Error) => {
      this.log.warn({ shareId, err: scrub(err?.message) }, 'seed torrent error');
      if (this.entries.get(shareId)?.torrent === torrent) this.entries.delete(shareId);
    });
    torrent.on('warning', (err: Error) => this.log.debug({ shareId, err: scrub(err?.message) }, 'seed torrent warning'));
    await new Promise<void>((resolve) => {
      if (torrent.ready) return resolve();
      torrent.once('ready', () => resolve());
      torrent.once('error', () => resolve());
      torrent.once('close', () => resolve());
    });
  }

  async remove(shareId: string): Promise<void> {
    const e = this.entries.get(shareId);
    if (!e) return;
    this.entries.delete(shareId);
    const client = this.client;
    if (!client || client.destroyed) return;
    await new Promise<void>((resolve) => {
      client.remove(e.torrent, { destroyStore: false }, () => resolve()).catch(() => resolve());
    });
  }

  /** Seed exactly `active` (add missing / re-add changed / remove the rest). */
  async sync(active: ShareRow[]): Promise<void> {
    const want = new Set(active.map((r) => r.id));
    for (const id of this.entries.keys()) if (!want.has(id)) await this.remove(id);
    for (const r of active) {
      try {
        await this.ensure(r);
      } catch (err) {
        this.log.warn({ shareId: r.id, err: scrub((err as Error).message) }, 'failed to seed share');
      }
    }
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.entries.clear();
    if (!client) return;
    await new Promise<void>((resolve) => client.destroy(() => resolve()));
  }
}
