// Typed wrappers around untyped (JS-only) dependencies used by the p2p module.
// `@ts-ignore` (not `@ts-expect-error`) so this keeps compiling if another module adds ambient
// declarations for the same packages later.

// @ts-ignore untyped package
import bencodeImpl from 'bencode';
// @ts-ignore untyped package
import { Server as TrackerServerImpl } from 'bittorrent-tracker';
// @ts-ignore untyped package (transitive dep of webtorrent, pinned directly in package.json)
import { ThrottleGroup as ThrottleGroupImpl } from 'speed-limiter';

export type BValue = number | Uint8Array | string | BValue[] | { [k: string]: BValue };

export const bencode = bencodeImpl as {
  encode(value: unknown): Uint8Array;
  decode(data: Uint8Array): unknown;
};

/** `limiter` TokenBucket as used by speed-limiter's ThrottleGroup. */
export interface TokenBucket {
  bucketSize: number;
  tokensPerInterval: number;
  content: number;
  tryRemoveTokens(count: number): boolean;
  drip(): void;
}

/** speed-limiter ThrottleGroup — the same class WebTorrent uses for `client.throttleGroups.up`. */
export interface ThrottleGroup {
  bucket: TokenBucket;
  getEnabled(): boolean;
  getRate(): number;
  getChunksize(): number;
  setEnabled(enabled: boolean): void;
  setRate(rate: number, chunksize?: number): void;
  throttle(): unknown;
  destroy(): void;
}

export const ThrottleGroupCtor = ThrottleGroupImpl as new (opts: { rate: number; enabled: boolean }) => ThrottleGroup;

/** One peer entry inside a bittorrent-tracker swarm (in-memory only). */
export interface TrackerSwarmPeer {
  type: 'http' | 'ws';
  complete: boolean;
  peerId: string;
  ip: string;
  port: number;
  socket?: unknown;
}

export interface TrackerSwarm {
  infoHash: string;
  complete: number;
  incomplete: number;
  peers: { keys: string[]; peek(key: string): TrackerSwarmPeer | undefined };
}

/** Subset of bittorrent-tracker's announce params we rely on (see lib/server/parse-*.js). */
export interface TrackerParams {
  type: 'http' | 'ws';
  action: number;
  info_hash: string;
  peer_id: string;
  event?: string;
  left: number;
  uploaded?: number | string;
  downloaded?: number | string;
  ip?: string;
  port?: number;
  addr?: string;
  httpReq?: { fsCtx?: unknown };
  socket?: { fsCtx?: unknown };
}

export interface TrackerServer {
  torrents: Record<string, TrackerSwarm | undefined>;
  on(event: string, fn: (...args: any[]) => void): void;
  onHttpRequest(req: unknown, res: unknown, opts: { action: 'announce' }): void;
  onWebSocketConnection(socket: unknown): void;
  _onWebSocketRequest(socket: unknown, opts: unknown, raw: unknown): void;
  close(cb?: () => void): void;
}

export const TrackerServerCtor = TrackerServerImpl as new (opts: {
  http: false;
  udp: false;
  ws: false;
  stats: false;
  trustProxy: boolean;
  interval?: number;
  filter: (infoHash: string, params: TrackerParams, cb: (err: Error | null) => void) => void;
}) => TrackerServer;
