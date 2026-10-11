// Public share API (docs/ARCHITECTURE.md §7.1) + per-tab session storage of the unlock result.
// The token lives only in memory and sessionStorage (this tab), never in localStorage or the URL.
import type { ShareStatusResponse, UnlockResponse } from '../../src/types.ts';

const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** `/s/<id>` → id, or null if the path doesn't look like a share link. */
export function shareIdFromLocation(pathname: string): string | null {
  const m = /^\/s\/([^/]+)\/?$/.exec(pathname);
  if (!m || !m[1]) return null;
  return SHARE_ID_RE.test(m[1]) ? m[1] : null;
}

const base = (id: string): string => `/api/s/${encodeURIComponent(id)}`;

const fetchOpts: RequestInit = { cache: 'no-store', credentials: 'same-origin', referrerPolicy: 'no-referrer' };

export async function getShareStatus(id: string): Promise<ShareStatusResponse> {
  const res = await fetch(base(id), fetchOpts);
  if (res.status === 404) return { status: 'gone', passwordRequired: false };
  if (!res.ok) throw new Error(`status ${res.status}`);
  const body = (await res.json()) as Partial<ShareStatusResponse>;
  if (body.status !== 'locked' && body.status !== 'open' && body.status !== 'gone') throw new Error('bad response');
  return { status: body.status, passwordRequired: body.passwordRequired === true };
}

export type UnlockResult =
  | { ok: true; data: UnlockResponse }
  | { ok: false; reason: 'bad_password' | 'gone' | 'error' }
  | { ok: false; reason: 'rate_limited'; retryAfter: number };

/** `name` is the recipient's self-chosen name; the server records it with the share's activity. */
export async function unlock(id: string, name: string, password?: string): Promise<UnlockResult> {
  let res: Response;
  try {
    res = await fetch(`${base(id)}/unlock`, {
      ...fetchOpts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(password === undefined ? { name } : { name, password }),
    });
  } catch {
    return { ok: false, reason: 'error' };
  }
  if (res.status === 401) return { ok: false, reason: 'bad_password' };
  if (res.status === 404) return { ok: false, reason: 'gone' };
  if (res.status === 429) {
    let retryAfter = Number(res.headers.get('Retry-After'));
    try {
      const body = (await res.json()) as { retryAfter?: unknown };
      if (typeof body.retryAfter === 'number' && Number.isFinite(body.retryAfter)) retryAfter = body.retryAfter;
    } catch {
      /* ignore */
    }
    if (!Number.isFinite(retryAfter) || retryAfter <= 0) retryAfter = 60;
    return { ok: false, reason: 'rate_limited', retryAfter: Math.min(Math.ceil(retryAfter), 3600) };
  }
  if (!res.ok) return { ok: false, reason: 'error' };
  try {
    const data = (await res.json()) as UnlockResponse;
    if (!isUnlockResponse(data)) return { ok: false, reason: 'error' };
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'error' };
  }
}

function isUnlockResponse(d: unknown): d is UnlockResponse {
  if (!d || typeof d !== 'object') return false;
  const u = d as Record<string, unknown>;
  return (
    typeof u.token === 'string' &&
    typeof u.infoHash === 'string' &&
    typeof u.name === 'string' &&
    typeof u.totalBytes === 'number' &&
    Array.isArray(u.files) &&
    (u.files as unknown[]).every(
      (f) => !!f && typeof (f as { path?: unknown }).path === 'string' && typeof (f as { length?: unknown }).length === 'number',
    ) &&
    typeof u.torrentUrl === 'string' &&
    typeof u.webseed === 'string' &&
    !!u.announce &&
    typeof (u.announce as { ws?: unknown }).ws === 'string' &&
    Array.isArray(u.iceServers)
  );
}

/** Fetches the .torrent bytes (same origin, token in the query string of this request only). */
export async function fetchTorrent(torrentUrl: string): Promise<Uint8Array> {
  const url = new URL(torrentUrl, location.href);
  if (url.origin !== location.origin) throw new Error('unexpected torrent origin');
  const res = await fetch(url, fetchOpts);
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new AccessError(res.status);
  if (!res.ok) throw new Error(`torrent ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

export class AccessError extends Error {
  constructor(readonly status: number) {
    super(`access ${status}`);
  }
}

// --- session (per tab) ---
const key = (id: string): string => `fileshare.unlock.${id}`;

export function loadSession(id: string): UnlockResponse | null {
  try {
    const raw = sessionStorage.getItem(key(id));
    if (!raw) return null;
    const data = JSON.parse(raw) as unknown;
    if (!isUnlockResponse(data)) return null;
    if (data.expiresAt !== null && data.expiresAt <= Date.now()) {
      clearSession(id);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function saveSession(id: string, data: UnlockResponse): void {
  try {
    sessionStorage.setItem(key(id), JSON.stringify(data));
  } catch {
    /* storage disabled: keep it in memory only */
  }
}

export function clearSession(id: string): void {
  try {
    sessionStorage.removeItem(key(id));
  } catch {
    /* ignore */
  }
}

// --- name (asked before downloading; remembered across visits on this browser) ---
const NICK_KEY = 'fileshare.nick';

export function cleanNick(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 24);
}

export function loadNick(): string {
  try {
    return cleanNick(localStorage.getItem(NICK_KEY) ?? '');
  } catch {
    return '';
  }
}

export function saveNick(nick: string): void {
  try {
    if (nick) localStorage.setItem(NICK_KEY, nick);
    else localStorage.removeItem(NICK_KEY);
  } catch {
    /* ignore */
  }
}
