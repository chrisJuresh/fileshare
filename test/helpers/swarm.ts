// Browser peers (Chromium persistent contexts, one profile dir each under the scratch dir), the
// recipient page's test hook, live-socket capture, and a Node "torrent client" (TCP, no WebRTC).
import { type BrowserContext, chromium, type Page } from '@playwright/test';
import parseTorrent from 'parse-torrent';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import WebTorrent from 'webtorrent';
import WebSocket from 'ws';
import type { AdminLiveMsg, ServerMsg } from '../../src/types.ts';
import { adminToken, stack } from './stack.ts';

export const OUT_DIR = 'fileshare-e2e';

export interface HookState {
  phase: string;
  peerId: string | null;
  progress: number;
  done: boolean;
  saved: boolean;
  uploaded: number;
  downloaded: number;
  peerBytes: number;
  webseedBytes: number;
  webseedActive: boolean;
  numPeers: number;
  liveConnected: boolean;
  error: string | null;
}

export interface BrowserPeer {
  index: number;
  context: BrowserContext;
  page: Page;
  profile: string;
  /** Text frames of the page's /api/s/:id/live socket (both directions). */
  liveFrames: string[];
  /** Bodies of /api/* responses the page received (text; binary as latin1). */
  apiBodies: { url: string; body: string }[];
  pageErrors: string[];
}

export interface PeerOptions {
  /** Delay before the webseed fallback (test hook). Large = effectively off. */
  webseedAfterMs?: number;
  bypassCSP?: boolean;
  /** Extra Chromium args. */
  args?: string[];
  /** Diagnostics: keep the page's WebTorrent clients in `globalThis.__wt` (see wtDiag). */
  spy?: boolean;
}

export async function launchPeer(index: number, profileRoot: string, o: PeerOptions = {}): Promise<BrowserPeer> {
  const profile = path.join(profileRoot, `peer-${index}`);
  await mkdir(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    bypassCSP: o.bypassCSP ?? false,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', ...(o.args ?? [])],
  });
  await context.addInitScript(
    ({ dir, webseedAfterMs, name }) => {
      // The page asks for a name before downloading; a remembered one skips that step.
      localStorage.setItem('fileshare.nick', name);
      (window as unknown as { __fileshareTest: object }).__fileshareTest = {
        ...(typeof webseedAfterMs === 'number' ? { webseedAfterMs } : {}),
        pickDirectory: async () => (await navigator.storage.getDirectory()).getDirectoryHandle(dir, { create: true }),
      };
    },
    { dir: OUT_DIR, webseedAfterMs: o.webseedAfterMs, name: `Synthetic Peer ${index}` },
  );
  if (o.spy) {
    // Serve the same bundle with its default export wrapped so client instances are reachable.
    await context.route('**/vendor/webtorrent.min.js', async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(
        'export{i as default};',
        'const __W=class extends i{constructor(...a){super(...a);(globalThis.__wt||=[]).push(this)}};export{__W as default};',
      );
      await route.fulfill({ response: res, body });
    });
  }
  const page = context.pages()[0] ?? (await context.newPage());
  const peer: BrowserPeer = { index, context, page, profile, liveFrames: [], apiBodies: [], pageErrors: [] };
  page.on('websocket', (ws) => {
    if (!/\/api\/s\/[^/]+\/live$/.test(ws.url())) return;
    ws.on('framereceived', (f) => peer.liveFrames.push(String(f.payload)));
    ws.on('framesent', (f) => peer.liveFrames.push(String(f.payload)));
  });
  page.on('response', async (r) => {
    if (!new URL(r.url()).pathname.startsWith('/api/')) return;
    try {
      peer.apiBodies.push({ url: r.url(), body: (await r.body()).toString('latin1') });
    } catch {
      /* body unavailable (redirect / aborted) */
    }
  });
  page.on('pageerror', (e) => peer.pageErrors.push(e.message));
  if (process.env.DEBUG_PAGE) page.on('console', (m) => console.log(`[peer ${index}]`, m.type(), m.text()));
  return peer;
}

/** Opens the share page, unlocks if needed, and starts "Choose folder and download". */
export async function startDownload(peer: BrowserPeer, shareUrl: string, password?: string): Promise<void> {
  const { page } = peer;
  await page.goto(shareUrl);
  if (password) {
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: 'Open' }).click();
  }
  const btn = page.getByRole('button', { name: 'Choose folder and download' });
  await btn.waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(() => !(document.querySelector('button.primary.big') as HTMLButtonElement | null)?.disabled, null, { timeout: 30_000 });
  await btn.click();
}

export async function hookState(page: Page): Promise<HookState> {
  return page.evaluate(() => (window as unknown as { __fileshareTest: { state: () => HookState } }).__fileshareTest.state());
}

/** Diagnostics for a page launched with `spy`: piece/wire state of its torrent. */
export async function wtDiag(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const c = (globalThis as unknown as { __wt?: any[] }).__wt?.at(-1);
    const t = c?.torrents?.[0];
    if (!t) return null;
    const n = t.pieces.length;
    const missing: number[] = [];
    for (let i = 0; i < n; i++) if (!t.bitfield.get(i)) missing.push(i);
    return {
      progress: t.progress,
      pieces: n,
      missing: missing.length,
      firstMissing: missing.slice(0, 8),
      reserved: missing.slice(0, 8).map((i: number) => (t._reservations?.[i] ?? []).filter(Boolean).length),
      selections: t._selections?.length,
      wires: t.wires.map((w: any) => ({
        type: w.type,
        peerChoking: w.peerChoking,
        amChoking: w.amChoking,
        amInterested: w.amInterested,
        peerInterested: w.peerInterested,
        requests: w.requests.length,
        peerRequests: w.peerRequests.length,
        hasMissing: missing.filter((i) => w.peerPieces.get(i)).length,
        down: Math.round(w.downloadSpeed()),
        up: Math.round(w.uploadSpeed()),
      })),
    };
  });
}

/** Diagnostics: CPU-profile the page for `ms` and return the top self-time functions. */
export async function cpuProfileTop(page: Page, ms = 5000, top = 15): Promise<string[]> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
    await new Promise((r) => setTimeout(r, ms));
    const { profile } = (await cdp.send('Profiler.stop')) as unknown as {
      profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; hitCount?: number }[] };
    };
    const total = profile.nodes.reduce((a, n) => a + (n.hitCount ?? 0), 0) || 1;
    const byFn = new Map<string, number>();
    for (const n of profile.nodes) {
      const f = n.callFrame;
      const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber + 1}:${f.columnNumber + 1}`;
      byFn.set(key, (byFn.get(key) ?? 0) + (n.hitCount ?? 0));
    }
    return [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => `${((v / total) * 100).toFixed(1)}% ${k}`);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** sha256 of every file under OPFS:/fileshare-e2e via WebCrypto (fine for small files only). */
export async function opfsHashesInPage(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async (dir) => {
    const out: Record<string, string> = {};
    const walk = async (h: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, child] of (h as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'directory') await walk(child as FileSystemDirectoryHandle, p);
        else {
          const buf = await (await (child as FileSystemFileHandle).getFile()).arrayBuffer();
          const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
          out[p] = Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
        }
      }
    };
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(dir), '');
    return out;
  }, OUT_DIR);
}

/**
 * sha256 of every file under OPFS:/fileshare-e2e, computed in Node: the page POSTs each File (a
 * disk-backed Blob, streamed by the browser) to the hash sink. Needs a context with bypassCSP
 * (the app's CSP rightly forbids connecting to another port).
 */
export async function opfsHashesViaSink(page: Page, sinkUrl: string): Promise<Record<string, { sha256: string; bytes: number }>> {
  return page.evaluate(
    async ({ dir, sinkUrl }) => {
      const out: Record<string, { sha256: string; bytes: number }> = {};
      const walk = async (h: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
        for await (const [name, child] of (h as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          const p = prefix ? `${prefix}/${name}` : name;
          if (child.kind === 'directory') await walk(child as FileSystemDirectoryHandle, p);
          else {
            const file = await (child as FileSystemFileHandle).getFile();
            const res = await fetch(sinkUrl, { method: 'POST', body: file });
            out[p] = (await res.json()) as { sha256: string; bytes: number };
          }
        }
      };
      await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(dir), '');
      return out;
    },
    { dir: OUT_DIR, sinkUrl },
  );
}

export async function closePeers(peers: BrowserPeer[], removeProfiles = true): Promise<void> {
  await Promise.allSettled(peers.map((p) => p.context.close()));
  if (removeProfiles) await Promise.allSettled(peers.map((p) => rm(p.profile, { recursive: true, force: true })));
}

/** Last parsed `swarm` messages a peer received. */
export function swarmMessages(peer: BrowserPeer): ServerMsg[] {
  const out: ServerMsg[] = [];
  for (const f of peer.liveFrames) {
    try {
      const m = JSON.parse(f) as ServerMsg;
      if (m.t === 'swarm') out.push(m);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

// ------------------------------------------------------------------------------ admin live

export interface AdminLive {
  frames: string[];
  messages(): AdminLiveMsg[];
  close(): void;
}

export async function openAdminLive(): Promise<AdminLive> {
  const s = stack();
  const ws = new WebSocket(`${s.adminUrl.replace(/^http/, 'ws')}/api/admin/live`, {
    headers: { 'Cf-Access-Jwt-Assertion': await adminToken(), Origin: s.adminUrl },
  });
  const frames: string[] = [];
  ws.on('message', (d) => frames.push(String(d)));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`admin live: HTTP ${res.statusCode}`)));
  });
  return {
    frames,
    messages: () => frames.map((f) => JSON.parse(f) as AdminLiveMsg),
    close: () => ws.close(),
  };
}

// ------------------------------------------------------------------------------ torrent client

export interface TorrentClient {
  client: InstanceType<typeof WebTorrent>;
  torrent: any;
  dir: string;
  done: Promise<void>;
  destroy(): Promise<void>;
}

/**
 * A plain BitTorrent client (Node WebTorrent over TCP/uTP, HTTP tracker only, no WebRTC, no webseed),
 * like qBittorrent using the share's .torrent. Listens on a 28xxx port.
 */
export async function startTorrentClient(torrentFile: Buffer, dir: string, port = 28210): Promise<TorrentClient> {
  await mkdir(dir, { recursive: true });
  const parsed = (await parseTorrent(torrentFile)) as { announce: string[]; urlList: string[] };
  parsed.announce = parsed.announce.filter((u) => /^https?:/.test(u));
  parsed.urlList = [];
  const client = new WebTorrent({ dht: false, lsd: false, utPex: false, natUpnp: false, natPmp: false, webSeeds: false, torrentPort: port });
  client.on('error', () => {});
  const torrent = client.add(parsed, { path: dir });
  torrent.on('warning', () => {});
  const done = new Promise<void>((resolve, reject) => {
    torrent.once('done', () => resolve());
    torrent.once('error', reject);
  });
  done.catch(() => {});
  return {
    client,
    torrent,
    dir,
    done,
    destroy: () => new Promise<void>((r) => client.destroy(() => r())),
  };
}
