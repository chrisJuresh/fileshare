// Minimal typings for the parts of WebTorrent 3.0.21 (prebuilt /vendor/webtorrent.min.js) that we use.
// Verified against node_modules/webtorrent/{index.js,lib/torrent.js,lib/file.js,lib/server.js}.

export interface WtEmitter {
  on(event: string, cb: (...args: any[]) => void): unknown;
  once(event: string, cb: (...args: any[]) => void): unknown;
  removeListener(event: string, cb: (...args: any[]) => void): unknown;
}

export interface WtBitField {
  get(index: number): boolean;
}

export interface WtWire extends WtEmitter {
  /** 'webrtc' | 'tcpIncoming' | ... | 'webSeed' */
  type: string;
  downloaded: number;
  uploaded: number;
  peerPieces: WtBitField;
}

export interface WtFile extends WtEmitter {
  name: string;
  /** `<torrent name>/<rel path>` for multi-file torrents, `<name>` for single-file torrents. */
  path: string;
  length: number;
  done: boolean;
  readonly downloaded: number;
  readonly progress: number;
  readonly streamURL: string;
  _startPiece: number;
  _endPiece: number;
  select(priority?: number): void;
  deselect(): void;
  stream(opts?: { start?: number; end?: number }): ReadableStream<Uint8Array>;
}

export interface WtTorrent extends WtEmitter {
  infoHash: string;
  name: string;
  ready: boolean;
  done: boolean;
  destroyed: boolean;
  files: WtFile[];
  wires: WtWire[];
  pieces: unknown[];
  bitfield: WtBitField | null;
  pieceLength: number;
  length: number;
  readonly downloadSpeed: number;
  readonly uploadSpeed: number;
  readonly downloaded: number;
  uploaded: number;
  received: number;
  readonly numPeers: number;
  addWebSeed(url: string): void;
  removePeer(id: string): void;
  destroy(opts?: { destroyStore?: boolean }, cb?: (err?: Error) => void): void;
}

export interface WtAddOptions {
  announce?: string[];
  strategy?: 'rarest' | 'sequential';
  deselect?: boolean;
  maxWebConns?: number;
  storeCacheSlots?: number;
}

export interface WtClient extends WtEmitter {
  peerId: string;
  destroyed: boolean;
  readonly downloadSpeed: number;
  readonly uploadSpeed: number;
  add(id: Uint8Array | string, opts: WtAddOptions, onTorrent?: (t: WtTorrent) => void): WtTorrent;
  createServer(opts: { controller: ServiceWorkerRegistration; origin?: string | false }): unknown;
  destroy(cb?: (err?: Error) => void): void;
}

export interface WtClientOptions {
  tracker?: { rtcConfig?: RTCConfiguration };
  webSeeds?: boolean;
  dht?: boolean;
  lsd?: boolean;
  utPex?: boolean;
}

export type WebTorrentCtor = new (opts?: WtClientOptions) => WtClient;

/** Loads WebTorrent's own ESM bundle at runtime (kept external by esbuild; served by /vendor/*). */
export async function loadWebTorrent(): Promise<WebTorrentCtor> {
  const url = '/vendor/webtorrent.min.js';
  const mod = (await import(/* webpackIgnore: true */ url)) as { default: WebTorrentCtor };
  return mod.default;
}
