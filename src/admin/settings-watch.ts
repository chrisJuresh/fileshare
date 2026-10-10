// Cross-process settings notification. The CLI (and the restic runner) write `settings` rows
// directly in SQLite; they cannot emit in-process events. This watcher polls `settings.updated_at`
// for the upload keys and emits `settings.changed` in the app when a row changes.
import type { AppEvents } from '../core/events.js';
import type { Db } from '../db/index.js';
import { KEY_CAP, KEY_CAPACITY } from './settings.js';

export const WATCHED_KEYS = [KEY_CAP, KEY_CAPACITY] as const;

export class SettingsWatcher {
  private seen = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly events: AppEvents,
    private readonly keys: readonly string[] = WATCHED_KEYS,
  ) {
    for (const [k, at] of this.read()) this.seen.set(k, at);
  }

  private read(): Map<string, number> {
    const q = this.db.prepare(`SELECT key, updated_at FROM settings WHERE key IN (${this.keys.map(() => '?').join(',')})`);
    const rows = q.all(...this.keys) as { key: string; updated_at: number }[];
    return new Map(rows.map((r) => [r.key, r.updated_at]));
  }

  /** Record the current stamp of `key` (call after an in-process write that already emitted). */
  markSeen(key: string): void {
    const at = this.read().get(key);
    if (at !== undefined) this.seen.set(key, at);
  }

  /** One poll; returns the keys that changed (and emits for each). */
  poll(): string[] {
    const changed: string[] = [];
    for (const [k, at] of this.read()) {
      if (this.seen.get(k) !== at) {
        this.seen.set(k, at);
        changed.push(k);
      }
    }
    for (const key of changed) this.events.emit('settings.changed', { key });
    return changed;
  }

  start(intervalMs = 3000): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        this.poll();
      } catch {
        /* DB busy etc.; try again next tick */
      }
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
