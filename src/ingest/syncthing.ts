// Minimal Syncthing 2.x REST client (docs/ARCHITECTURE.md §4). Only the calls ingest needs.
// The API key is sent in the X-API-Key header and never logged or included in errors.
import type { Logger } from '../log.js';

export class SyncthingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface SyncthingFolderStatus {
  state: string;
  needFiles?: number;
  needBytes?: number;
  [k: string]: unknown;
}

export interface SyncthingCompletion {
  completion: number;
  needBytes?: number;
  needItems?: number;
  needDeletes?: number;
  remoteState?: string;
  [k: string]: unknown;
}

export interface SyncthingEvent {
  id: number;
  type: string;
  time?: string;
  data?: Record<string, unknown> | null;
}

export const INGEST_EVENT_TYPES = [
  'LocalIndexUpdated',
  'ItemFinished',
  'RemoteIndexUpdated',
  'FolderCompletion',
  'StateChanged',
] as const;

export interface SyncthingClientOptions {
  baseUrl: string;
  /** Lazily read so a missing secret file is a runtime (retryable) error, not a crash. */
  apiKey: () => string;
  /** Per-request timeout for normal calls (ms). */
  timeoutMs?: number;
}

const NEED_PAGE_SIZE = 1000;
const NEED_MAX_PAGES = 200; // 200k needed files: beyond that we simply report "not stable"

export class SyncthingClient {
  private readonly base: URL;
  private readonly timeoutMs: number;

  constructor(private readonly opts: SyncthingClientOptions) {
    this.base = new URL(opts.baseUrl);
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async get<T>(path: string, params: Record<string, string | number>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    let key: string;
    try {
      key = this.opts.apiKey();
    } catch {
      throw new SyncthingError('syncthing API key is not available');
    }
    const timeout = AbortSignal.timeout(timeoutMs ?? this.timeoutMs);
    const sig = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let res: Response;
    try {
      res = await fetch(url, { headers: { 'X-API-Key': key, Accept: 'application/json' }, signal: sig });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new SyncthingError(`syncthing request ${path} failed: ${(err as Error).name}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new SyncthingError(`syncthing request ${path} returned ${res.status}`, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      throw new SyncthingError(`syncthing request ${path} returned invalid JSON`);
    }
  }

  async folderStatus(folder: string, signal?: AbortSignal): Promise<SyncthingFolderStatus> {
    const s = await this.get<SyncthingFolderStatus>('/rest/db/status', { folder }, signal);
    if (!s || typeof s.state !== 'string') throw new SyncthingError('syncthing status has no state');
    return s;
  }

  async completion(folder: string, device: string, signal?: AbortSignal): Promise<SyncthingCompletion> {
    const c = await this.get<SyncthingCompletion>('/rest/db/completion', { folder, device }, signal);
    if (!c || typeof c.completion !== 'number') throw new SyncthingError('syncthing completion is malformed');
    return c;
  }

  /** All file names the local device still needs in `folder` (progress + queued + rest, all pages). */
  async neededNames(folder: string, signal?: AbortSignal): Promise<string[]> {
    const names: string[] = [];
    for (let page = 1; page <= NEED_MAX_PAGES; page++) {
      const r = await this.get<{ progress?: { name: string }[]; queued?: { name: string }[]; rest?: { name: string }[] }>(
        '/rest/db/need',
        { folder, page, perpage: NEED_PAGE_SIZE },
        signal,
        60_000,
      );
      let count = 0;
      for (const list of [r.progress, r.queued, r.rest]) {
        if (!Array.isArray(list)) continue;
        for (const f of list) {
          count++;
          if (f && typeof f.name === 'string') names.push(f.name);
        }
      }
      if (count < NEED_PAGE_SIZE) return names;
    }
    throw new SyncthingError('syncthing need list too long');
  }

  /** Long-poll for events with id > since. Returns [] on timeout. */
  async events(since: number, types: readonly string[], timeoutS: number, signal?: AbortSignal): Promise<SyncthingEvent[]> {
    const r = await this.get<SyncthingEvent[]>(
      '/rest/events',
      { since, events: types.join(','), timeout: timeoutS },
      signal,
      (timeoutS + 15) * 1000,
    );
    if (!Array.isArray(r)) throw new SyncthingError('syncthing events response is not an array');
    return r.filter((e) => e && typeof e.id === 'number' && typeof e.type === 'string');
  }
}

/** True if Syncthing file name `name` is `entry` itself or lies below it. */
export function isUnderEntry(name: string, entry: string): boolean {
  const n = name.replace(/\\/g, '/').normalize('NFC');
  const e = entry.normalize('NFC');
  return n === e || n.startsWith(e + '/');
}

export interface EventLoopOptions {
  client: SyncthingClient;
  types: readonly string[];
  signal: AbortSignal;
  log: Logger;
  onEvents: (events: SyncthingEvent[]) => void;
  onReachable?: (reachable: boolean) => void;
  /** Long-poll timeout in seconds (Syncthing caps it). */
  pollTimeoutS?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Runs the /rest/events long-poll until `signal` aborts. Reconnects with exponential backoff and
 * restarts from since=0 after an error (Syncthing restarts reset event ids).
 */
export async function runEventLoop(o: EventLoopOptions): Promise<void> {
  let since = 0;
  let backoff = o.minBackoffMs ?? 1000;
  const maxBackoff = o.maxBackoffMs ?? 60_000;
  let failing = false;
  while (!o.signal.aborted) {
    try {
      const events = await o.client.events(since, o.types, o.pollTimeoutS ?? 60, o.signal);
      if (failing) o.log.info('syncthing event stream reconnected');
      failing = false;
      backoff = o.minBackoffMs ?? 1000;
      o.onReachable?.(true);
      if (events.length > 0) {
        const maxId = Math.max(...events.map((e) => e.id));
        if (maxId < since) since = 0; // ids went backwards: Syncthing restarted
        else since = maxId;
        o.onEvents(events);
      }
    } catch (err) {
      if (o.signal.aborted) break;
      if (!failing) o.log.warn({ err: (err as Error).message }, 'syncthing event stream unavailable; falling back to rescans');
      failing = true;
      since = 0;
      o.onReachable?.(false);
      await sleep(backoff, o.signal);
      backoff = Math.min(maxBackoff, backoff * 2);
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
