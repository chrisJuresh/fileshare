import { describe, expect, it } from 'vitest';
import { AppEvents } from '../core/events.js';
import { openDb, setSetting } from '../db/index.js';
import { KEY_CAP, KEY_CAPACITY, effectiveCapBps, mbpsToBps, readSettings, recordCapacity, writeCap } from './settings.js';
import { SettingsWatcher } from './settings-watch.js';
import { DISK_WARN_FRACTION, diskFromNumbers, resticDisk, resticStatus, savedFraction, statDisk } from './stats.js';

describe('disks', () => {
  it('warns at >= 85% used', () => {
    expect(DISK_WARN_FRACTION).toBe(0.85);
    expect(diskFromNumbers('d', '/x', 100, 16).warn).toBe(false); // 84%
    expect(diskFromNumbers('d', '/x', 100, 15).warn).toBe(true); // 85%
    expect(diskFromNumbers('d', '/x', 100, 1).warn).toBe(true);
    expect(diskFromNumbers('d', '/x', 0, 0)).toMatchObject({ usedFraction: 0, warn: false });
  });

  it('uses df semantics when used is given (reserved blocks excluded)', () => {
    // total 100, used 80, available 10 (10 reserved) → 80 / 90
    expect(diskFromNumbers('d', '/x', 100, 10, 80).usedFraction).toBeCloseTo(80 / 90);
  });

  it('stats a real directory and tolerates a missing one', async () => {
    const ok = await statDisk('tmp', '/tmp');
    expect(ok.mounted).toBe(true);
    expect(ok.total).toBeGreaterThan(0);
    const missing = await statDisk('nope', '/definitely/not/here');
    expect(missing).toMatchObject({ mounted: false, warn: false });
  });

  it('reads the restic disk from settings', () => {
    const db = openDb(':memory:');
    expect(resticDisk(db)).toMatchObject({ mounted: false });
    setSetting(db, 'status.disk.restic', { total: 1000, free: 500, path: '/restic', at: 1 });
    expect(resticDisk(db)).toMatchObject({ mounted: true, usedFraction: 0.5, warn: false, path: '/restic' });
  });
});

describe('restic status', () => {
  it('falls back to backup_runs and counts pending requests', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO backup_runs (kind, trigger, started_at, finished_at, status, snapshot_id) VALUES ('backup','manual',10,20,'ok','s1')`).run();
    db.prepare(`INSERT INTO backup_runs (kind, trigger, started_at, finished_at, status) VALUES ('check','schedule',30,40,'failed')`).run();
    db.prepare(`INSERT INTO backup_requests (reason, requested_at) VALUES ('manual', 50)`).run();
    expect(resticStatus(db)).toEqual({
      repoInitialised: false,
      lastBackupAt: 20,
      lastSnapshotId: 's1',
      lastBackupOk: true,
      lastCheckAt: 40,
      lastCheckOk: false,
      lastForgetAt: null,
      paused: false,
      pendingRequests: 1,
    });
  });
});

describe('saved fraction', () => {
  it('is peer / (peer + server), 0 when nothing moved', () => {
    expect(savedFraction(0, 0)).toBe(0);
    expect(savedFraction(3, 1)).toBe(0.75);
  });
});

describe('upload settings', () => {
  it('defaults the cap to 90% of capacity, else 0', () => {
    const db = openDb(':memory:');
    expect(effectiveCapBps(db)).toBe(0);
    setSetting(db, KEY_CAPACITY, 1001);
    expect(effectiveCapBps(db)).toBe(900);
    writeCap(db, 5000);
    expect(effectiveCapBps(db)).toBe(5000);
    expect(() => writeCap(db, 10)).toThrow(RangeError);
  });

  it('records a speed test and sets the cap unless keepCap', () => {
    const db = openDb(':memory:');
    recordCapacity(db, mbpsToBps(100), { at: 42 });
    expect(readSettings(db)).toEqual({ uploadCapBps: 11_250_000, uploadCapacityBps: 12_500_000, uploadMeasuredAt: 42 });
    writeCap(db, 2048);
    recordCapacity(db, mbpsToBps(200), { keepCap: true, at: 43 });
    expect(readSettings(db)).toEqual({ uploadCapBps: 2048, uploadCapacityBps: 25_000_000, uploadMeasuredAt: 43 });
  });
});

describe('settings watcher', () => {
  it('emits settings.changed for rows written out of process, once', async () => {
    const db = openDb(':memory:');
    const events = new AppEvents();
    const seen: string[] = [];
    events.on('settings.changed', (e) => seen.push(e.key));
    setSetting(db, KEY_CAP, 4096); // existed before the watcher started → not a change
    const w = new SettingsWatcher(db, events);
    expect(w.poll()).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    setSetting(db, KEY_CAP, 8192);
    setSetting(db, 'unrelated.key', 1);
    expect(w.poll()).toEqual([KEY_CAP]);
    expect(w.poll()).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    setSetting(db, KEY_CAP, 9000);
    w.markSeen(KEY_CAP); // in-process write already emitted
    expect(w.poll()).toEqual([]);
    expect(seen).toEqual([KEY_CAP]);
  });
});
