// Stats (share_stats totals, upload now vs cap) and health status (disks, restic, Syncthing).
import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import { latestRuns, pendingRequestCount } from '../backup/queue.js';
import type { Config } from '../config.js';
import type { Db, ShareStatsRow } from '../db/index.js';
import { getSetting } from '../db/index.js';
import type { DiskStatus, RecipientActivityDto, ResticStatus, StatsDto, StatusDto } from '../types.js';
import { effectiveCapBps, readSettings } from './settings.js';

export const DISK_WARN_FRACTION = 0.85;

// ---------------------------------------------------------------- stats

export function savedFraction(peerBytes: number, serverBytes: number): number {
  const total = peerBytes + serverBytes;
  return total > 0 ? peerBytes / total : 0;
}

/** share_events.detail JSON → object (null when absent or unreadable). */
export function parseEventDetail(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** The recipient's self-chosen name stored on an `unlocked` / `completed` event, if any. */
export function eventName(detail: unknown): string | null {
  const name = detail && typeof detail === 'object' ? (detail as { name?: unknown }).name : undefined;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

export const RECENT_ACTIVITY_LIMIT = 50;

export function recentActivity(db: Db, limit = RECENT_ACTIVITY_LIMIT): RecipientActivityDto[] {
  const rows = db
    .prepare(
      `SELECT e.at, e.share_id, e.type, e.detail, i.name AS item_name FROM share_events e
       JOIN shares s ON s.id = e.share_id JOIN items i ON i.id = s.item_id
       WHERE e.type IN ('unlocked', 'completed')
       ORDER BY e.at DESC, e.id DESC LIMIT ?`,
    )
    .all(limit) as { at: number; share_id: string; type: 'unlocked' | 'completed'; detail: string | null; item_name: string }[];
  return rows.map((r) => ({ at: r.at, shareId: r.share_id, itemName: r.item_name, type: r.type, name: eventName(parseEventDetail(r.detail)) }));
}

export function buildStats(db: Db, currentBps: number): StatsDto {
  const rows = db
    .prepare(
      `SELECT st.*, i.name AS item_name FROM share_stats st
       JOIN shares s ON s.id = st.share_id JOIN items i ON i.id = s.item_id
       ORDER BY s.created_at DESC`,
    )
    .all() as (ShareStatsRow & { item_name: string })[];
  let serverBytes = 0;
  let peerBytes = 0;
  let completedDownloads = 0;
  const shares = rows.map((r) => {
    serverBytes += r.server_bytes_webseed + r.server_bytes_p2p;
    peerBytes += r.peer_bytes;
    completedDownloads += r.completed_downloads;
    return {
      shareId: r.share_id,
      itemName: r.item_name,
      serverBytesWebseed: r.server_bytes_webseed,
      serverBytesP2p: r.server_bytes_p2p,
      peerBytes: r.peer_bytes,
      completedDownloads: r.completed_downloads,
      peakSwarm: r.peak_swarm,
      lastActivityAt: r.last_activity_at,
    };
  });
  const s = readSettings(db);
  return {
    upload: { capBps: effectiveCapBps(db), capacityBps: s.uploadCapacityBps, currentBps: Number.isFinite(currentBps) ? currentBps : 0 },
    totals: { serverBytes, peerBytes, savedFraction: savedFraction(peerBytes, serverBytes), completedDownloads },
    shares,
    recent: recentActivity(db),
  };
}

// ---------------------------------------------------------------- disks

export function diskFromNumbers(label: string, p: string, total: number, free: number, used?: number): DiskStatus {
  const u = used ?? Math.max(0, total - free);
  const denom = u + free;
  const usedFraction = denom > 0 ? u / denom : 0;
  return { label, path: p, mounted: true, total, free, usedFraction, warn: usedFraction >= DISK_WARN_FRACTION };
}

export async function statDisk(label: string, p: string): Promise<DiskStatus> {
  try {
    const s = await statfs(p);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize; // available to unprivileged users, like df
    const used = (s.blocks - s.bfree) * s.bsize;
    return diskFromNumbers(label, p, total, free, used);
  } catch {
    return { label, path: p, mounted: false, total: 0, free: 0, usedFraction: 0, warn: false, note: 'not reachable' };
  }
}

interface ResticDiskSetting { total?: number; free?: number; used?: number; path?: string; at?: number }

export function resticDisk(db: Db): DiskStatus {
  const d = getSetting<ResticDiskSetting>(db, 'status.disk.restic');
  if (!d || typeof d.total !== 'number' || typeof d.free !== 'number') {
    return { label: 'Snapshot repository', path: '', mounted: false, total: 0, free: 0, usedFraction: 0, warn: false, note: 'not reported yet by the snapshot runner' };
  }
  const disk = diskFromNumbers('Snapshot repository', typeof d.path === 'string' ? d.path : '', d.total, d.free, typeof d.used === 'number' ? d.used : undefined);
  if (typeof d.at === 'number') disk.note = `reported ${new Date(d.at).toISOString()}`;
  return disk;
}

export const NIGHTLY_DISK: DiskStatus = {
  label: 'Nightly backup disk',
  path: '',
  mounted: false,
  total: 0,
  free: 0,
  usedFraction: 0,
  warn: false,
  note: 'mounted only during the nightly backup; not monitored',
};

// ---------------------------------------------------------------- restic

interface ResticSetting {
  repoInitialised?: boolean;
  lastBackupAt?: number | null;
  lastSnapshotId?: string | null;
  lastCheckAt?: number | null;
  lastCheckOk?: boolean | null;
  lastForgetAt?: number | null;
  paused?: boolean;
}

const nOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const okOf = (status: string | undefined): boolean | null => (status === 'ok' ? true : status === 'failed' || status === 'interrupted' ? false : null);

export function resticStatus(db: Db): ResticStatus {
  const s = getSetting<ResticSetting>(db, 'status.restic') ?? {};
  const runs = latestRuns(db);
  const backup = runs.backup;
  const check = runs.check;
  return {
    repoInitialised: s.repoInitialised === true,
    lastBackupAt: nOrNull(s.lastBackupAt) ?? (backup?.status === 'ok' ? (backup.finished_at ?? backup.started_at) : null),
    lastSnapshotId: typeof s.lastSnapshotId === 'string' ? s.lastSnapshotId : (backup?.status === 'ok' ? backup.snapshot_id : null),
    lastBackupOk: okOf(backup?.status),
    lastCheckAt: nOrNull(s.lastCheckAt) ?? (check?.finished_at ?? null),
    lastCheckOk: typeof s.lastCheckOk === 'boolean' ? s.lastCheckOk : okOf(check?.status),
    lastForgetAt: nOrNull(s.lastForgetAt) ?? (runs.forget?.finished_at ?? null),
    paused: s.paused === true,
    pendingRequests: pendingRequestCount(db),
  };
}

// ---------------------------------------------------------------- syncthing

export type SyncthingStatus = StatusDto['syncthing'];

export async function syncthingStatus(config: Config, fetchImpl: typeof fetch = fetch): Promise<SyncthingStatus> {
  let apiKey: string;
  try {
    apiKey = config.secret('syncthing-api-key');
  } catch {
    return { reachable: false, pcConnected: null, folderState: null };
  }
  const base = config.env.SYNCTHING_API_URL.replace(/\/+$/, '');
  const get = async (p: string): Promise<unknown> => {
    const res = await fetchImpl(base + p, { headers: { 'X-API-Key': apiKey }, signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`syncthing ${res.status}`);
    return res.json();
  };
  const [conns, folder] = await Promise.allSettled([
    get('/rest/system/connections'),
    get(`/rest/db/status?folder=${encodeURIComponent(config.env.SYNCTHING_FOLDER_ID)}`),
  ]);
  const reachable = conns.status === 'fulfilled' || folder.status === 'fulfilled';
  let pcConnected: boolean | null = null;
  const pcId = config.env.SYNCTHING_PC_DEVICE_ID;
  if (conns.status === 'fulfilled' && pcId) {
    const c = (conns.value as { connections?: Record<string, { connected?: boolean }> }).connections ?? {};
    pcConnected = c[pcId]?.connected === true;
  }
  const state = folder.status === 'fulfilled' ? (folder.value as { state?: unknown }).state : undefined;
  return { reachable, pcConnected, folderState: typeof state === 'string' ? state : null };
}

// ---------------------------------------------------------------- status

let cachedVersion: string | undefined;
export function appVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
    cachedVersion = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

export async function buildStatus(config: Config, db: Db, fetchImpl?: typeof fetch): Promise<StatusDto> {
  const [data, syncthing] = await Promise.all([statDisk('Data', config.paths.data), syncthingStatus(config, fetchImpl)]);
  return {
    disks: [data, resticDisk(db), { ...NIGHTLY_DISK }],
    restic: resticStatus(db),
    syncthing,
    version: appVersion(),
  };
}
