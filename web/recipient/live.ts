// Live swarm socket (docs/ARCHITECTURE.md §8): hello → stats every 1.5 s; renders server `swarm` messages.
import type { ClientMsg, ServerMsg, SwarmPeer } from '../../src/types.ts';

export interface LiveStats {
  progress: number;
  down: number;
  up: number;
  uploaded: number;
  downloaded: number;
  done: boolean;
}

export interface SwarmView {
  you: string;
  peers: SwarmPeer[];
}

export interface LiveOptions {
  shareId: string;
  token: string;
  peerId: string;
  nick: () => string;
  stats: () => LiveStats;
  onSwarm: (s: SwarmView) => void;
  onConnection: (connected: boolean) => void;
  /** 4401 (token no longer valid) or 4404 (share gone): no reconnect. */
  onFatal: (code: 4401 | 4404) => void;
}

const STATS_INTERVAL_MS = 1500;
const MAX_BACKOFF_MS = 30_000;

export function liveUrl(shareId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/s/${encodeURIComponent(shareId)}/live`;
}

export class LiveSocket {
  private ws: WebSocket | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = false;

  constructor(private readonly opts: LiveOptions) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.clearStats();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
    this.opts.onConnection(false);
  }

  setNick(nick: string): void {
    this.send({ t: 'nick', nick });
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(liveUrl(this.opts.shareId));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      const nick = this.opts.nick();
      this.send({ t: 'hello', token: this.opts.token, peerId: this.opts.peerId, ...(nick ? { nick } : {}) });
      this.sendStats();
      this.clearStats();
      this.statsTimer = setInterval(() => this.sendStats(), STATS_INTERVAL_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string' || ev.data.length > 256 * 1024) return;
      let msg: unknown;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const m = msg as Partial<ServerMsg>;
      if (m.t !== 'swarm' || !Array.isArray(m.peers)) return;
      this.attempt = 0;
      this.opts.onConnection(true);
      this.opts.onSwarm({ you: typeof m.you === 'string' ? m.you : '', peers: m.peers.filter(isPeer) });
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearStats();
      this.opts.onConnection(false);
      if (ev.code === 4401 || ev.code === 4404) {
        this.stopped = true;
        this.opts.onFatal(ev.code);
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 10);
    const delay = base / 2 + Math.random() * (base / 2);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private clearStats(): void {
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
  }

  private sendStats(): void {
    const s = this.opts.stats();
    const n = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0);
    this.send({
      t: 'stats',
      progress: Math.min(1, n(s.progress)),
      down: Math.round(n(s.down)),
      up: Math.round(n(s.up)),
      uploaded: Math.round(n(s.uploaded)),
      downloaded: Math.round(n(s.downloaded)),
      done: s.done,
    });
  }

  private send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

function isPeer(p: unknown): p is SwarmPeer {
  if (!p || typeof p !== 'object') return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    typeof o.label === 'string' &&
    (o.kind === 'server' || o.kind === 'browser' || o.kind === 'client') &&
    typeof o.progress === 'number' &&
    typeof o.down === 'number' &&
    typeof o.up === 'number' &&
    typeof o.uploaded === 'number'
  );
}
