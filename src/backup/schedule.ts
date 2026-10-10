// Pure scheduling decisions for the restic runner (docs/ARCHITECTURE.md §5). No I/O here: the
// runner gathers a ScheduleState from SQLite and asks `nextJob()` what to do. All times are ms
// since the epoch; "local" means the process TZ (the container's `TZ`).
import { inWindow, localMinutes } from '../core/time.js';

export interface PauseWindow {
  /** Minutes since local midnight. */
  startMin: number;
  endMin: number;
}

/** No job may start this many minutes before the pause window opens. */
export const PAUSE_LEAD_MIN = 15;
/** Run a backup when the oldest unconsumed request is at least this old, even if requests keep coming. */
export const MAX_REQUEST_WAIT_MS = 10 * 60_000;
/** Run a backup when the last successful one started at least this long ago. */
export const HOURLY_MS = 60 * 60_000;
/** Back-off after a failed backup: 5, 10, 20, 40, 60, 60 … minutes. */
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;

/** Weekly jobs: Sunday (0) at these local times. */
export const WEEKLY = {
  forget: { weekday: 0, hour: 14, minute: 0 },
  check: { weekday: 0, hour: 15, minute: 0 },
} as const;

export type BackupTrigger = 'debounce' | 'hourly' | 'manual';
export type Job =
  | { kind: 'backup'; trigger: BackupTrigger }
  | { kind: 'forget'; trigger: 'schedule' }
  | { kind: 'check'; trigger: 'schedule' };

export interface PendingRequests {
  count: number;
  oldestAt: number;
  newestAt: number;
  /** At least one request has reason 'manual' (runs without waiting for the debounce). */
  manual: boolean;
}

export interface ScheduleState {
  now: number;
  pending: PendingRequests | null;
  /** started_at of the latest backup with status 'ok'. */
  lastOkBackupStartedAt: number | null;
  /** started_at of the latest forget / check that finished (ok or failed; interrupted ones don't count). */
  lastForgetStartedAt: number | null;
  lastCheckStartedAt: number | null;
  /** Earliest backup_runs.started_at of any kind (or null if the table is empty). Baseline for weekly jobs. */
  firstRunAt: number | null;
  /** No backup may start before this (failure back-off). */
  backupNotBefore: number;
}

export interface ScheduleConfig {
  debounceMs: number;
  pause: PauseWindow;
}

/** True when no job may start: inside [pause_start − 15 min, pause_end). */
export function startBlocked(now: number, pause: PauseWindow): boolean {
  const lead = (pause.startMin - PAUSE_LEAD_MIN + 1440) % 1440;
  return inWindow(localMinutes(new Date(now)), lead, pause.endMin);
}

/** True inside [pause_start, pause_end): a running job must be interrupted. */
export function inPause(now: number, pause: PauseWindow): boolean {
  return inWindow(localMinutes(new Date(now)), pause.startMin, pause.endMin);
}

/** The most recent local `weekday hour:minute` at or before `now`. DST-safe (uses local date maths). */
export function lastWeeklyOccurrence(now: number, weekday: number, hour: number, minute: number): number {
  const d = new Date(now);
  const back = (d.getDay() - weekday + 7) % 7;
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back, hour, minute, 0, 0);
  if (t.getTime() > now) {
    return new Date(t.getFullYear(), t.getMonth(), t.getDate() - 7, hour, minute, 0, 0).getTime();
  }
  return t.getTime();
}

/** A weekly job is due if its most recent slot passed after the last time it ran (catch-up included). */
export function weeklyDue(
  now: number,
  slot: { weekday: number; hour: number; minute: number },
  lastStartedAt: number | null,
  firstRunAt: number | null,
): boolean {
  const occurrence = lastWeeklyOccurrence(now, slot.weekday, slot.hour, slot.minute);
  // Never run before: only due once a slot has passed since the runner first did anything, so a
  // fresh install doesn't prune/check immediately.
  const baseline = lastStartedAt ?? firstRunAt;
  if (baseline === null) return false;
  return occurrence > baseline;
}

export function backupTrigger(s: ScheduleState, cfg: ScheduleConfig): BackupTrigger | null {
  if (s.now < s.backupNotBefore) return null;
  if (s.pending) {
    if (s.pending.manual) return 'manual';
    if (s.now - s.pending.newestAt >= cfg.debounceMs || s.now - s.pending.oldestAt >= MAX_REQUEST_WAIT_MS) {
      return 'debounce';
    }
  }
  if (s.lastOkBackupStartedAt === null || s.now - s.lastOkBackupStartedAt >= HOURLY_MS) return 'hourly';
  return null;
}

/** What to start now, if anything. Priority: backup > forget > check. */
export function nextJob(s: ScheduleState, cfg: ScheduleConfig): Job | null {
  if (startBlocked(s.now, cfg.pause)) return null;
  const trigger = backupTrigger(s, cfg);
  if (trigger) return { kind: 'backup', trigger };
  if (weeklyDue(s.now, WEEKLY.forget, s.lastForgetStartedAt, s.firstRunAt)) return { kind: 'forget', trigger: 'schedule' };
  if (weeklyDue(s.now, WEEKLY.check, s.lastCheckStartedAt, s.firstRunAt)) return { kind: 'check', trigger: 'schedule' };
  return null;
}

/** Back-off delay after `consecutiveFailures` failed backups (≥ 1). */
export function backoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1));
}
