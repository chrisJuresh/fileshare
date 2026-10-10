import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../config.js';
import { newId } from '../core/ids.js';
import { getSetting, openDb, type Db } from '../db/index.js';
import { runCli } from './cli.js';

let db: Db;
let config: Config;
let dir: string;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'fileshare-cli-test-'));
  config = loadConfig({
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://files.example.test',
    ADMIN_BASE_URL: 'https://files-admin.example.test',
    DATA_DIR: dir,
    STATE_DIR: dir,
    SECRETS_DIR: path.join(dir, 'no-secrets'),
  });
  db = openDb(':memory:');
  out = [];
  err = [];
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (...argv: string[]) => runCli(argv, { config, db, io: { out: (l) => out.push(l), err: (l) => err.push(l) } });

describe('cli', () => {
  it('records a speed test and sets the cap to 90 %', async () => {
    expect(await run('speedtest', 'record', '80')).toBe(0);
    expect(getSetting(db, 'upload.capacity_bps')).toBe(10_000_000);
    expect(getSetting(db, 'upload.cap_bps')).toBe(9_000_000);
    expect(typeof getSetting(db, 'upload.measured_at')).toBe('number');
    expect(await run('speedtest', 'record', '160', '--keep-cap')).toBe(0);
    expect(getSetting(db, 'upload.capacity_bps')).toBe(20_000_000);
    expect(getSetting(db, 'upload.cap_bps')).toBe(9_000_000);
  });

  it('sets and gets the cap with validation', async () => {
    expect(await run('settings', 'set-cap', '40')).toBe(0);
    expect(getSetting(db, 'upload.cap_bps')).toBe(5_000_000);
    expect(await run('settings', 'set-cap', 'abc')).toBe(1);
    expect(await run('settings', 'set-cap', '0.001')).toBe(1); // 125 B/s < 1 KiB/s
    expect(await run('settings', 'get', '--json')).toBe(0);
    expect(JSON.parse(out.at(-1)!)).toMatchObject({ uploadCapBps: 5_000_000 });
  });

  it('queues a manual snapshot', async () => {
    expect(await run('snapshot', 'request')).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM backup_requests WHERE reason = 'manual'`).get()).toEqual({ n: 1 });
  });

  it('lists items and shares', async () => {
    const id = newId();
    const now = Date.now();
    db.prepare(
      `INSERT INTO items (id, name, kind, source, source_name, status, created_at, updated_at) VALUES (?, 'synthetic item', 'dir', 'upload', 'x', 'ready', ?, ?)`,
    ).run(id, now, now);
    db.prepare(
      `INSERT INTO shares (id, item_id, info_hash, torrent_name, info, created_at, updated_at) VALUES ('AAAAAAAAAAAAAAAAAAAAAA', ?, 'ab', 'synthetic item', x'00', ?, ?)`,
    ).run(id, now, now);
    expect(await run('items')).toBe(0);
    expect(out.join('\n')).toContain('synthetic item');
    expect(await run('shares', '--json')).toBe(0);
    expect(JSON.parse(out.at(-1)!)[0]).toMatchObject({ url: 'https://files.example.test/s/AAAAAAAAAAAAAAAAAAAAAA', state: 'active', hasPassword: false });
  });

  it('refuses share create/revoke with a pointer to the dashboard', async () => {
    expect(await run('share', 'create', 'abc')).toBe(2);
    expect(err.join('\n')).toMatch(/dashboard/);
  });

  it('prints status without Syncthing secrets', async () => {
    expect(await run('status')).toBe(0);
    expect(out.join('\n')).toMatch(/Nightly backup disk: mounted only during the nightly backup/);
    expect(out.join('\n')).toMatch(/syncthing: unreachable/);
  });

  it('rejects unknown commands', async () => {
    expect(await run('frobnicate')).toBe(1);
  });
});
