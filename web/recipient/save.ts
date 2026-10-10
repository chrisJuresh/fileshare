// Saving downloaded files without ever holding a whole file in memory.
//  - Chromium: user-picked folder; each file is piped from `file.stream()` into a
//    FileSystemWritableFileStream as pieces arrive (stream yields in order, with backpressure).
//  - Firefox/Safari: WebTorrent's service worker serves `file.streamURL` (per-file "Save"), and our own
//    small service worker (/vendor/fs-zip-sw.js, scope /vendor/fszip/) streams a client-zip archive.
import { makeZip, predictLength } from 'client-zip';
import type { WtClient, WtFile } from './wt-types.ts';

export type FileSaveState = 'waiting' | 'writing' | 'saved' | 'error';

export interface DirectorySaveJob {
  index: number;
  /** Path relative to the item root, '/'-separated. */
  path: string;
  length: number;
  file: WtFile;
}

const MAX_PARALLEL_WRITES = 3;

/** Picks a name that doesn't exist yet in `dir` ("name", "name (2)", …). */
async function freeName(dir: FileSystemDirectoryHandle, name: string, isDir: boolean): Promise<string> {
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? name : `${stem} (${n})${ext}`;
    if (!(await exists(dir, candidate))) return candidate;
  }
  throw new Error('Too many existing copies in that folder');
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    /* not a file */
  }
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

function safeSegments(path: string): string[] {
  const parts = path.split('/');
  for (const p of parts) {
    if (!p || p === '.' || p === '..' || p.includes('\\') || p.includes('\0')) throw new Error('Unsafe file name');
  }
  return parts;
}

/**
 * Writes the selected files into `root`. Multi-file items get a top-level folder named after the item
 * (made unique if it already exists); a single file is written directly (also made unique).
 */
export async function saveToDirectory(
  root: FileSystemDirectoryHandle,
  itemName: string,
  multiFile: boolean,
  jobs: DirectorySaveJob[],
  onState: (index: number, state: FileSaveState, error?: string) => void,
  signal: AbortSignal,
): Promise<boolean> {
  let base = root;
  if (multiFile) {
    const [top] = safeSegments(itemName);
    base = await root.getDirectoryHandle(await freeName(root, top as string, true), { create: true });
  }

  const queue = [...jobs];
  let ok = true;
  const worker = async (): Promise<void> => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      if (signal.aborted) return;
      onState(job.index, 'writing');
      try {
        await writeOne(base, multiFile, job, signal);
        onState(job.index, 'saved');
      } catch (err) {
        ok = false;
        onState(job.index, 'error', err instanceof Error ? err.message : String(err));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL_WRITES, jobs.length) }, worker));
  return ok && !signal.aborted;
}

async function writeOne(base: FileSystemDirectoryHandle, multiFile: boolean, job: DirectorySaveJob, signal: AbortSignal): Promise<void> {
  const parts = safeSegments(job.path);
  let dir = base;
  for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
  let name = parts[parts.length - 1] as string;
  if (!multiFile) name = await freeName(dir, name, false);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  if (job.length === 0) {
    await writable.close();
    return;
  }
  // pipeTo closes the writable when the stream ends and aborts it (discarding the partial file) on error.
  await job.file.stream().pipeTo(writable, { signal });
}

// --- service worker paths --------------------------------------------------------------------------

/** Registers WebTorrent's SW (scope /) and returns the registration once it is active. */
export async function registerWebTorrentSW(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/sw.min.js', { scope: '/' });
  await waitActive(reg);
  return reg;
}

const ZIP_SCOPE = '/vendor/fszip/';

export async function registerZipSW(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register('/vendor/fs-zip-sw.js', { scope: ZIP_SCOPE });
  await waitActive(reg);
  return reg;
}

function waitActive(reg: ServiceWorkerRegistration): Promise<void> {
  if (reg.active) return Promise.resolve();
  const sw = reg.installing ?? reg.waiting;
  if (!sw) return Promise.reject(new Error('Service worker failed to install'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Service worker did not start')), 15_000);
    sw.addEventListener('statechange', () => {
      if (sw.state === 'activated' || sw.state === 'activating') {
        clearTimeout(timer);
        resolve();
      } else if (sw.state === 'redundant') {
        clearTimeout(timer);
        reject(new Error('Service worker failed to install'));
      }
    });
  });
}

/** Creates WebTorrent's SW-backed server so `file.streamURL` works. */
export function attachStreamServer(client: WtClient, reg: ServiceWorkerRegistration): void {
  client.createServer({ controller: reg, origin: false });
}

/** Triggers a browser download of `url` (same origin) via a temporary anchor with `download`. */
export function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.hidden = true;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 1000);
}

export interface ZipEntry {
  /** Path inside the zip ('/'-separated). */
  name: string;
  length: number;
  file: WtFile;
}

interface PendingZip {
  name: string;
  entries: ZipEntry[];
  onDone: (ok: boolean) => void;
}

const pendingZips = new Map<string, PendingZip>();
let zipListenerInstalled = false;

function installZipListener(): void {
  if (zipListenerInstalled) return;
  zipListenerInstalled = true;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: unknown; id?: unknown } | null;
    if (!data || data.type !== 'fileshare-zip' || typeof data.id !== 'string') return;
    const port = event.ports[0];
    if (!port) return;
    const job = pendingZips.get(data.id);
    if (!job) {
      // Another tab may own it; stay silent so its answer wins.
      return;
    }
    pendingZips.delete(data.id);
    serveZip(job, port);
  });
  navigator.serviceWorker.startMessages?.();
}

function serveZip(job: PendingZip, port: MessagePort): void {
  const meta = job.entries.map((e) => ({ name: e.name, size: e.length }));
  const size = predictLength(meta);
  const stream = makeZip(
    (async function* () {
      for (const e of job.entries) {
        yield { name: e.name, size: e.length, lastModified: new Date(), input: e.length === 0 ? new Uint8Array(0) : e.file.stream() };
      }
    })(),
  );
  const reader = stream.getReader();
  let finished = false;
  const finish = (ok: boolean): void => {
    if (finished) return;
    finished = true;
    port.onmessage = null;
    job.onDone(ok);
  };
  port.onmessage = async (ev: MessageEvent) => {
    if (ev.data === 'pull') {
      try {
        const { value, done } = await reader.read();
        if (done || !value) {
          port.postMessage(null);
          finish(true);
        } else {
          // Copy into a fresh buffer we can transfer (the source may be a view on a shared buffer).
          const chunk = value.slice();
          port.postMessage(chunk, [chunk.buffer]);
        }
      } catch {
        port.postMessage({ error: true });
        finish(false);
      }
    } else if (ev.data === 'cancel') {
      void reader.cancel().catch(() => {});
      finish(false);
    }
  };
  port.postMessage({ ok: true, name: job.name, size: size.toString() });
}

/**
 * Streams a zip of `entries` to the user's downloads via the zip service worker. Resolves once the
 * archive has been fully handed to the browser (or failed).
 */
export async function downloadZip(reg: ServiceWorkerRegistration, zipName: string, entries: ZipEntry[]): Promise<boolean> {
  installZipListener();
  const id = crypto.randomUUID();
  const result = new Promise<boolean>((resolve) => {
    pendingZips.set(id, { name: zipName, entries, onDone: resolve });
  });
  // Keep the zip worker alive while it streams (Firefox may stop idle service workers).
  const keepAlive = setInterval(() => reg.active?.postMessage({ type: 'keepalive' }), 5000);
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.title = 'download';
  frame.src = `${ZIP_SCOPE}${id}/${encodeURIComponent(zipName)}`;
  document.body.appendChild(frame);
  const startTimeout = setTimeout(() => {
    if (pendingZips.delete(id)) resolveFailed();
  }, 30_000);
  let resolveFailed = (): void => {};
  const ok = await Promise.race([
    result,
    new Promise<boolean>((resolve) => {
      resolveFailed = () => resolve(false);
    }),
  ]);
  clearTimeout(startTimeout);
  clearInterval(keepAlive);
  setTimeout(() => frame.remove(), 5000);
  return ok;
}
