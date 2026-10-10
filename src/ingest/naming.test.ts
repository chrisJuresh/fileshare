import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateSegment } from '../core/paths.js';
import { openDb } from '../db/index.js';
import { chooseName, isNameTaken, timestampSuffix, tombstoneName } from './naming.js';

describe('isNameTaken / tombstones', () => {
  const insert = (db: ReturnType<typeof openDb>, id: string, name: string, status: string) =>
    db
      .prepare(`INSERT INTO items (id, name, kind, source, source_name, status, created_at, updated_at) VALUES (?, ?, 'file', 'upload', ?, ?, 1, 1)`)
      .run(id, name, id, status);

  it('live rows and library entries block a name; tombstoned deleted rows and the item itself do not', async () => {
    const lib = mkdtempSync(path.join(os.tmpdir(), 'fileshare-naming-'));
    const db = openDb(':memory:');
    try {
      insert(db, 'a'.repeat(26), 'Live', 'ready');
      insert(db, 'b'.repeat(26), tombstoneName('Gone', 'b'.repeat(26)), 'deleted');
      mkdirSync(path.join(lib, 'OnDisk'));
      expect(await isNameTaken(db, lib, 'Live')).toBe(true);
      expect(await isNameTaken(db, lib, 'Live', 'a'.repeat(26))).toBe(false);
      expect(await isNameTaken(db, lib, 'Gone')).toBe(false);
      expect(await isNameTaken(db, lib, 'OnDisk')).toBe(true);
      expect(await isNameTaken(db, lib, 'Free')).toBe(false);
    } finally {
      db.close();
      rmSync(lib, { recursive: true, force: true });
    }
  });

  it('migration 005 tombstones rows deleted before the change (idempotently)', () => {
    const db = openDb(':memory:');
    insert(db, 'c'.repeat(26), 'Old', 'deleted');
    insert(db, 'd'.repeat(26), tombstoneName('Done', 'd'.repeat(26)), 'deleted');
    insert(db, 'e'.repeat(26), 'Kept', 'ready');
    const sql = readFileSync(path.join(import.meta.dirname, '..', 'db', 'migrations', '005_item_name_tombstones.sql'), 'utf8');
    db.exec(sql);
    db.exec(sql);
    const names = (db.prepare('SELECT name FROM items ORDER BY id').all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual([tombstoneName('Old', 'c'.repeat(26)), tombstoneName('Done', 'd'.repeat(26)), 'Kept']);
    db.close();
  });
});

describe('chooseName', () => {
  const at = new Date(2026, 9, 10, 9, 5); // local time 2026-10-10 09:05

  it('uses the entry name when free', async () => {
    expect(await chooseName('Holiday', () => false, at)).toBe('Holiday');
  });

  it('adds a timestamp suffix, then (n)', async () => {
    expect(timestampSuffix(at)).toBe(' (2026-10-10 0905)');
    const taken = new Set(['Holiday']);
    expect(await chooseName('Holiday', (n) => taken.has(n), at)).toBe('Holiday (2026-10-10 0905)');
    taken.add('Holiday (2026-10-10 0905)');
    expect(await chooseName('Holiday', (n) => taken.has(n), at)).toBe('Holiday (2026-10-10 0905) (2)');
    taken.add('Holiday (2026-10-10 0905) (2)');
    expect(await chooseName('Holiday', async (n) => taken.has(n), at)).toBe('Holiday (2026-10-10 0905) (3)');
  });

  it('keeps suffixed names within 200 bytes and valid', async () => {
    const base = 'é'.repeat(100); // 200 bytes
    const name = await chooseName(base, (n) => n === base, at);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.endsWith(' (2026-10-10 0905)')).toBe(true);
    expect(validateSegment(name)).toBe(name);
  });
});
