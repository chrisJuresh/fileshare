// Fixed TZ so local-time maths (pause window, Sunday slots, DST) is deterministic.
process.env.TZ = 'Europe/London';

import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  backupTrigger,
  inPause,
  lastWeeklyOccurrence,
  nextJob,
  startBlocked,
  weeklyDue,
  type ScheduleState,
} from './schedule.js';

const MIN = 60_000;
/** Local wall-clock time (Europe/London). month is 1-based. */
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0): number =>
  new Date(y, mo - 1, d, h, mi, s).getTime();

const W = { startMin: 3 * 60 + 45, endMin: 5 * 60 + 15 }; // 03:45-05:15
const cfg = { debounceMs: 120_000, pause: W };

// 2026-10-07 is a Wednesday; 2026-10-11 a Sunday.
const WED = (h: number, mi: number, s = 0): number => at(2026, 10, 7, h, mi, s);

function state(p: Partial<ScheduleState> & { now: number }): ScheduleState {
  return {
    pending: null,
    lastOkBackupStartedAt: p.now - 5 * MIN,
    lastForgetStartedAt: p.now - MIN,
    lastCheckStartedAt: p.now - MIN,
    firstRunAt: p.now - 30 * 24 * 60 * MIN,
    backupNotBefore: 0,
    ...p,
  };
}

describe('pause window', () => {
  it('blocks starts from 15 min before the window until its end', () => {
    expect(startBlocked(WED(3, 29, 59), W)).toBe(false);
    expect(startBlocked(WED(3, 30), W)).toBe(true);
    expect(startBlocked(WED(3, 45), W)).toBe(true);
    expect(startBlocked(WED(5, 14, 59), W)).toBe(true);
    expect(startBlocked(WED(5, 15), W)).toBe(false);
  });

  it('interrupts only inside [start, end)', () => {
    expect(inPause(WED(3, 44, 59), W)).toBe(false);
    expect(inPause(WED(3, 45), W)).toBe(true);
    expect(inPause(WED(5, 14), W)).toBe(true);
    expect(inPause(WED(5, 15), W)).toBe(false);
  });

  it('handles windows over midnight', () => {
    const w = { startMin: 23 * 60 + 50, endMin: 30 }; // 23:50-00:30
    expect(startBlocked(WED(23, 34), w)).toBe(false);
    expect(startBlocked(WED(23, 35), w)).toBe(true);
    expect(startBlocked(WED(0, 29), w)).toBe(true);
    expect(startBlocked(WED(0, 30), w)).toBe(false);
    expect(inPause(WED(23, 49), w)).toBe(false);
    expect(inPause(WED(0, 10), w)).toBe(true);
  });

  it('wraps the lead time before midnight for windows starting just after it', () => {
    const w = { startMin: 5, endMin: 60 }; // 00:05-01:00
    expect(startBlocked(WED(23, 49), w)).toBe(false);
    expect(startBlocked(WED(23, 50), w)).toBe(true);
    expect(startBlocked(WED(0, 59), w)).toBe(true);
    expect(startBlocked(WED(1, 0), w)).toBe(false);
  });

  it('starts nothing while blocked, even if everything is due', () => {
    const now = WED(3, 40);
    const s = state({ now, pending: { count: 3, oldestAt: now - 60 * MIN, newestAt: now - 30 * MIN, manual: true }, lastOkBackupStartedAt: null });
    expect(nextJob(s, cfg)).toBeNull();
    // …and runs the queued work right after the window.
    expect(nextJob({ ...s, now: WED(5, 15) }, cfg)).toEqual({ kind: 'backup', trigger: 'manual' });
  });
});

describe('backup triggers', () => {
  const now = WED(12, 0);

  it('debounces: waits until the newest request is SNAPSHOT_DEBOUNCE_SECONDS old', () => {
    const p = (newestAgo: number, oldestAgo = newestAgo) => ({ count: 2, oldestAt: now - oldestAgo, newestAt: now - newestAgo, manual: false });
    expect(backupTrigger(state({ now, pending: p(119_000) }), cfg)).toBeNull();
    expect(backupTrigger(state({ now, pending: p(120_000) }), cfg)).toBe('debounce');
  });

  it('runs once the oldest request is 10 min old, even if requests keep arriving', () => {
    const pending = { count: 9, oldestAt: now - 10 * MIN, newestAt: now - 5_000, manual: false };
    expect(backupTrigger(state({ now, pending }), cfg)).toBe('debounce');
    expect(backupTrigger(state({ now, pending: { ...pending, oldestAt: now - 10 * MIN + 1 } }), cfg)).toBeNull();
  });

  it('runs manual requests immediately', () => {
    const pending = { count: 1, oldestAt: now, newestAt: now, manual: true };
    expect(backupTrigger(state({ now, pending }), cfg)).toBe('manual');
  });

  it('runs hourly after the last successful backup, and at once if there was none', () => {
    expect(backupTrigger(state({ now, lastOkBackupStartedAt: now - 59 * MIN }), cfg)).toBeNull();
    expect(backupTrigger(state({ now, lastOkBackupStartedAt: now - 60 * MIN }), cfg)).toBe('hourly');
    expect(backupTrigger(state({ now, lastOkBackupStartedAt: null }), cfg)).toBe('hourly');
  });

  it('a manual request made after the last failure bypasses the back-off (once)', () => {
    const failedAt = now - 2 * MIN;
    const base = state({ now, backupNotBefore: now + 3 * MIN, lastBackupFailedAt: failedAt });
    const pending = (manualNewestAt?: number) => ({ count: 1, oldestAt: now - 3 * MIN, newestAt: now, manual: manualNewestAt !== undefined, manualNewestAt });
    expect(backupTrigger({ ...base, pending: pending(now - MIN) }, cfg)).toBe('manual');
    expect(backupTrigger({ ...base, pending: pending(failedAt) }, cfg)).toBeNull(); // the request that just failed
    expect(backupTrigger({ ...base, pending: pending(failedAt - MIN) }, cfg)).toBeNull();
    expect(backupTrigger({ ...base, pending: pending(undefined) }, cfg)).toBeNull(); // not manual
    // Still nothing inside the pause window.
    expect(nextJob({ ...base, now: WED(3, 50), pending: pending(WED(3, 49)), lastBackupFailedAt: WED(3, 0), backupNotBefore: WED(4, 0) }, cfg)).toBeNull();
  });

  it('respects the failure back-off', () => {
    const s = state({ now, lastOkBackupStartedAt: null, backupNotBefore: now + 1 });
    expect(backupTrigger(s, cfg)).toBeNull();
    expect(backupTrigger({ ...s, now: now + 1 }, cfg)).toBe('hourly');
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffMs(n) / MIN)).toEqual([5, 10, 20, 40, 60, 60]);
  });
});

describe('weekly forget / check', () => {
  const SUN = (h: number, mi: number) => at(2026, 10, 11, h, mi);
  const lastWeek = SUN(14, 0) - 7 * 24 * 60 * MIN;

  it('finds the most recent Sunday slot', () => {
    expect(lastWeeklyOccurrence(SUN(14, 0), 0, 14, 0)).toBe(SUN(14, 0));
    expect(lastWeeklyOccurrence(SUN(13, 59), 0, 14, 0)).toBe(lastWeek);
    expect(lastWeeklyOccurrence(WED(9, 0), 0, 14, 0)).toBe(at(2026, 10, 4, 14, 0));
  });

  it('is DST-safe (clocks go back on Sunday 2026-10-25 in Europe/London)', () => {
    const sundayAfter = at(2026, 10, 25, 14, 0);
    expect(lastWeeklyOccurrence(at(2026, 10, 26, 9, 0), 0, 14, 0)).toBe(sundayAfter);
    expect(new Date(lastWeeklyOccurrence(at(2026, 10, 30, 9, 0), 0, 15, 0)).getHours()).toBe(15);
  });

  it('runs forget on Sunday 14:00 and check at 15:00', () => {
    const base = { lastForgetStartedAt: lastWeek, lastCheckStartedAt: lastWeek + 60 * MIN };
    expect(nextJob(state({ now: SUN(13, 59), ...base }), cfg)).toBeNull();
    expect(nextJob(state({ now: SUN(14, 0), ...base }), cfg)).toEqual({ kind: 'forget', trigger: 'schedule' });
    const afterForget = { ...base, lastForgetStartedAt: SUN(14, 0) };
    expect(nextJob(state({ now: SUN(14, 30), ...afterForget }), cfg)).toBeNull();
    expect(nextJob(state({ now: SUN(15, 0), ...afterForget }), cfg)).toEqual({ kind: 'check', trigger: 'schedule' });
  });

  it('runs check right after a prune that overran 15:00', () => {
    const s = state({ now: SUN(15, 40), lastForgetStartedAt: SUN(14, 0), lastCheckStartedAt: lastWeek + 60 * MIN });
    expect(nextJob(s, cfg)).toEqual({ kind: 'check', trigger: 'schedule' });
  });

  it('catches up missed weekly jobs after downtime (forget first)', () => {
    // Down from Saturday until Monday 09:00.
    const s = state({ now: at(2026, 10, 12, 9, 0), lastForgetStartedAt: lastWeek, lastCheckStartedAt: lastWeek + 60 * MIN });
    expect(nextJob(s, cfg)).toEqual({ kind: 'forget', trigger: 'schedule' });
    expect(nextJob({ ...s, lastForgetStartedAt: s.now }, cfg)).toEqual({ kind: 'check', trigger: 'schedule' });
  });

  it('does not catch up inside the pause window', () => {
    const s = state({ now: at(2026, 10, 12, 4, 0), lastForgetStartedAt: lastWeek });
    expect(nextJob(s, cfg)).toBeNull();
    const after = at(2026, 10, 12, 5, 15);
    expect(nextJob({ ...s, now: after }, cfg)).toEqual({ kind: 'backup', trigger: 'hourly' });
    expect(nextJob({ ...s, now: after, lastOkBackupStartedAt: after }, cfg)).toEqual({ kind: 'forget', trigger: 'schedule' });
  });

  it('prefers a due backup over weekly maintenance', () => {
    const now = SUN(14, 0);
    const s = state({ now, lastForgetStartedAt: lastWeek, pending: { count: 1, oldestAt: now - 5 * MIN, newestAt: now - 5 * MIN, manual: false } });
    expect(nextJob(s, cfg)).toEqual({ kind: 'backup', trigger: 'debounce' });
  });

  it('does not prune/check a fresh install before its first Sunday', () => {
    const firstRunAt = WED(10, 0);
    expect(weeklyDue(WED(12, 0), { weekday: 0, hour: 14, minute: 0 }, null, firstRunAt)).toBe(false);
    expect(weeklyDue(SUN(14, 0), { weekday: 0, hour: 14, minute: 0 }, null, firstRunAt)).toBe(true);
    expect(weeklyDue(SUN(14, 0), { weekday: 0, hour: 14, minute: 0 }, null, null)).toBe(false);
  });
});
