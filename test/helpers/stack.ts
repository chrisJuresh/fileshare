// Helpers for e2e tests against the real app started by scripts/test-stack.sh (reads stack.json).
// Synthetic random data only. Admin calls are signed with the stack's throwaway JWKS key.
import Database from 'better-sqlite3';
import { importJWK, SignJWT } from 'jose';
import { spawnSync } from 'node:child_process';
import { createHash, randomFill } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import { newId } from '../../src/core/ids.ts';
import { buildInfoDict, hashPieces, pieceLengthFor } from '../../src/ingest/torrent.ts';
import { scanTree } from '../../src/ingest/tree.ts';
import type { ShareDto, UnlockResponse } from '../../src/types.ts';

export interface StackInfo {
  stackDir: string;
  repoDir: string;
  publicUrl: string;
  adminUrl: string;
  ports: { public: number; admin: number; jwks: number; bt: number; webrtc: number; syncthingServer: number; syncthingPc: number };
  paths: {
    data: string;
    outbox: string;
    library: string;
    state: string;
    db: string;
    secrets: string;
    pcFolder: string;
    resticRepo: string;
    logs: string;
    appLog: string;
    envFile: string;
    composeEnv: string;
    jwk: string;
  };
  access: { issuer: string; audience: string; email: string };
  syncthing: { mode: 'real' | 'fake'; folderId: string; serverDeviceId: string; pcDeviceId: string; serverApi: string; pcApi: string };
  compose: { project: string; file: string; envFile: string; image: string };
  ingestQuietSeconds: number;
  restic: boolean;
}

export const SCRATCH = process.env.FILESHARE_SCRATCH ?? '/srv/fileshare-scratch';
export const STACK_JSON = process.env.FILESHARE_STACK_JSON ?? path.join(process.env.STACK_DIR ?? path.join(SCRATCH, 'stack'), 'stack.json');

let cached: StackInfo | undefined;
export function stack(): StackInfo {
  cached ??= JSON.parse(readFileSync(STACK_JSON, 'utf8')) as StackInfo;
  return cached;
}

// ------------------------------------------------------------------------------ admin API

export async function adminToken(o: { audience?: string; email?: string; expSeconds?: number } = {}): Promise<string> {
  const s = stack();
  const jwk = JSON.parse(readFileSync(s.paths.jwk, 'utf8')) as { kid: string };
  const key = await importJWK(jwk, 'RS256');
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: o.email ?? s.access.email, type: 'app' })
    .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
    .setIssuer(s.access.issuer)
    .setAudience(o.audience ?? s.access.audience)
    .setSubject('synthetic-admin')
    .setIssuedAt(now - 5)
    .setExpirationTime(now + (o.expSeconds ?? 600))
    .sign(key);
}

export interface HttpResult<T = unknown> {
  status: number;
  body: T;
  text: string;
  headers: Headers;
}

export async function admin<T = unknown>(
  method: string,
  p: string,
  body?: unknown,
  o: { token?: string | null; origin?: string | null; contentType?: string | null } = {},
): Promise<HttpResult<T>> {
  const s = stack();
  const headers: Record<string, string> = {};
  const token = o.token === undefined ? await adminToken() : o.token;
  if (token) headers['Cf-Access-Jwt-Assertion'] = token;
  const origin = o.origin === undefined ? s.adminUrl : o.origin;
  if (origin && method !== 'GET') headers.Origin = origin;
  if (body !== undefined) headers['Content-Type'] = o.contentType === undefined ? 'application/json' : (o.contentType ?? '');
  const res = await fetch(s.adminUrl + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T, text, headers: res.headers };
}

export async function pub<T = unknown>(method: string, p: string, body?: unknown): Promise<HttpResult<T>> {
  const res = await fetch(stack().publicUrl + p, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('latin1');
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: parsed as T, text, headers: res.headers };
}

export async function createShare(itemId: string, o: { password?: string; expiresAt?: number } = {}): Promise<ShareDto> {
  const r = await admin<ShareDto>('POST', '/api/admin/shares', { itemId, ...o });
  if (r.status !== 201) throw new Error(`create share: ${r.status} ${r.text}`);
  return r.body;
}

export async function unlock(shareId: string, password?: string): Promise<UnlockResponse> {
  const r = await pub<UnlockResponse>('POST', `/api/s/${shareId}/unlock`, password === undefined ? {} : { password });
  if (r.status !== 200) throw new Error(`unlock: ${r.status} ${r.text}`);
  return r.body;
}

export async function setCap(bytesPerSec: number): Promise<void> {
  const r = await admin('PUT', '/api/admin/settings', { uploadCapBps: bytesPerSec });
  if (r.status !== 200) throw new Error(`set cap: ${r.status} ${r.text}`);
}

/** Runs the operator CLI (`node dist/cli.js …`) with the stack's environment, like `docker compose exec app`. */
export function cli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  const s = stack();
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp' };
  for (const line of readFileSync(s.paths.envFile, 'utf8').split('\n')) {
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!;
  }
  const r = spawnSync(process.execPath, [path.join(s.repoDir, 'dist', 'cli.js'), ...args], { env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

// ------------------------------------------------------------------------------ DB

export function openStackDb(readonly = true): Database.Database {
  const db = new Database(stack().paths.db, { readonly, fileMustExist: true });
  db.pragma('busy_timeout = 5000');
  return db;
}

// ------------------------------------------------------------------------------ data

const randomFillP = promisify(randomFill) as (buf: Buffer) => Promise<Buffer>;
const CHUNK = 8 * 1024 * 1024;

/** Writes `size` random bytes to `file` and returns its sha256. */
export async function writeRandomFile(file: string, size: number): Promise<string> {
  await mkdir(path.dirname(file), { recursive: true });
  const fh = await open(file, 'wx', 0o640);
  const h = createHash('sha256');
  try {
    let a = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(size, 1)));
    let b = Buffer.allocUnsafe(a.length);
    let left = size;
    let next = left > 0 ? randomFillP(a.subarray(0, Math.min(a.length, left))) : undefined;
    while (left > 0) {
      const cur = await next!;
      left -= cur.length;
      // Generate the next chunk while this one is written.
      [a, b] = [b, a];
      next = left > 0 ? randomFillP(a.subarray(0, Math.min(a.length, left))) : undefined;
      h.update(cur);
      let off = 0;
      while (off < cur.length) off += (await fh.write(cur, off, cur.length - off)).bytesWritten;
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: CHUNK })) h.update(chunk as Buffer);
  return h.digest('hex');
}

export interface SeedFile {
  path: string;
  size: number;
}

export interface SeededItem {
  id: string;
  name: string;
  dir: string;
  files: { path: string; length: number; sha256: string }[];
  totalBytes: number;
}

/**
 * Creates a READY library item the way ingest leaves it: random files under library/<name>, the
 * info dict built with the app's own hashing code (src/ingest/torrent.ts), and an `items` row.
 * Skips placement/snapshot (tests for those go through Syncthing). `single` makes a single-file item.
 */
export async function seedItem(name: string, files: SeedFile[], o: { single?: boolean } = {}): Promise<SeededItem> {
  const s = stack();
  const root = path.join(s.paths.library, name);
  if (existsSync(root)) throw new Error(`library entry exists: ${name}`);
  const out: SeededItem['files'] = [];
  if (o.single) {
    if (files.length !== 1) throw new Error('single needs one file');
    out.push({ path: name, length: files[0]!.size, sha256: await writeRandomFile(root, files[0]!.size) });
  } else {
    for (const f of files) out.push({ path: f.path, length: f.size, sha256: await writeRandomFile(path.join(root, ...f.path.split('/')), f.size) });
  }
  const scan = await scanTree(root);
  const total = scan.files.reduce((a, f) => a + f.size, 0);
  const pieceLength = pieceLengthFor(total);
  const { pieces } = await hashPieces(
    scan.files.map((f) => ({ path: scan.kind === 'file' ? root : path.join(root, ...f.segs), size: f.size, mtimeMs: f.mtimeMs })),
    pieceLength,
  );
  const info = buildInfoDict({
    name,
    kind: scan.kind as 'file' | 'dir',
    files: scan.files.map((f) => ({ segs: f.segs, length: f.size })),
    pieceLength,
    pieces,
  });
  const id = newId();
  const now = Date.now();
  const db = openStackDb(false);
  try {
    db.prepare(
      `INSERT INTO items (id, name, kind, source, source_name, upload_batch_id, status, total_bytes, file_count, piece_length, info,
                          library_at, created_at, updated_at, ready_at)
       VALUES (?, ?, ?, 'upload', ?, NULL, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, scan.kind, name, total, scan.files.length, pieceLength, info, now, now, now, now);
  } finally {
    db.close();
  }
  return { id, name, dir: root, files: out, totalBytes: total };
}

export async function removeLibraryEntry(name: string): Promise<void> {
  const s = stack();
  if (!name || name.includes('/') || name.startsWith('.')) throw new Error('bad name');
  await rm(path.join(s.paths.library, name), { recursive: true, force: true });
}

// ------------------------------------------------------------------------------ IP scan

const IPV4 = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g;
const IPV6 = /(?<![0-9a-f:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,6}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})|::ffff:[\d.]+)(?![0-9a-f:])/gi;

/** IPv4 / IPv6 address literals found in `text`. */
export function findIps(text: string): string[] {
  return [...(text.match(IPV4) ?? []), ...(text.match(IPV6) ?? [])];
}

/** Text with the configured base URLs / bind addresses removed (those are config, not peer IPs). */
export function stripConfigured(text: string): string {
  const s = stack();
  const ports = [s.ports.public, s.ports.admin, s.ports.syncthingServer, s.ports.syncthingPc, s.ports.jwks].join('|');
  // Plain and URL-encoded (magnet links) forms.
  return text.replace(new RegExp(`127\\.0\\.0\\.1(?::|%3A)(?:${ports})(?!\\d)`, 'gi'), '<configured>');
}

// ------------------------------------------------------------------------------ hash sink

export interface HashSink {
  url: string;
  close(): Promise<void>;
}

/**
 * A loopback HTTP endpoint (28xxx) that streams POSTed bodies through SHA-256, so files a browser
 * wrote (e.g. into OPFS) can be hashed in Node without holding them in memory: the page posts the
 * File (a disk-backed Blob) and gets `{sha256, bytes}` back.
 */
export async function startHashSink(): Promise<HashSink> {
  const server: Server = createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    if (req.method !== 'POST') return void res.writeHead(405).end();
    const h = createHash('sha256');
    let bytes = 0;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      h.update(c);
    });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ sha256: h.digest('hex'), bytes }));
    });
  });
  for (let port = 28100; port < 28200; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) {
      return {
        url: `http://127.0.0.1:${port}/`,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      };
    }
  }
  throw new Error('no free port for the hash sink');
}

export interface RateSample {
  at: number;
  /** The app's 2 s moving average (`/api/admin/stats` upload.currentBps). */
  bps: number;
  /** Server bytes (p2p + webseed) of the share under test so far. */
  serverBytes: number;
}

/**
 * The upload limiter is a token bucket holding 1 s worth of tokens, so over any window of T seconds the
 * server may send at most cap × (T + 1). Returns the worst ratio (bytes sent / that envelope) over all
 * windows of ≥ 2 samples; ≤ 1 (+ sampling jitter) means the cap held.
 */
export function worstCapEnvelope(samples: RateSample[], cap: number): number {
  let worst = 0;
  for (let i = 0; i < samples.length; i++) {
    for (let j = i + 2; j < samples.length; j++) {
      const T = (samples[j]!.at - samples[i]!.at) / 1000;
      worst = Math.max(worst, (samples[j]!.serverBytes - samples[i]!.serverBytes) / (cap * (T + 1)));
    }
  }
  return worst;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const fmtMB = (n: number): string => `${(n / 1e6).toFixed(1)} MB`;
