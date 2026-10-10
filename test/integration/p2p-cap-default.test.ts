// The limiter enforces the same cap the admin settings report (docs/ARCHITECTURE.md §3):
// `upload.cap_bps`, else floor(0.9 × `upload.capacity_bps`), else unlimited.
import { afterEach, describe, expect, it } from 'vitest';
import { readSettings, recordCapacity, writeCap } from '../../src/admin/settings.js';
import { createP2P, type P2P } from '../../src/p2p/index.js';
import { makeEnv, type TestEnv } from './p2p-helpers.js';

let env: TestEnv | undefined;
let p2p: P2P | undefined;
afterEach(async () => {
  await p2p?.stop();
  await env?.cleanup();
  p2p = undefined;
  env = undefined;
});

describe('upload cap applied by the limiter', () => {
  it('follows the measured capacity when no explicit cap is set, and the explicit cap otherwise', async () => {
    env = await makeEnv();
    p2p = createP2P(env.ctx, { seeder: false });
    await p2p.start();
    expect(p2p.uploadCapBps()).toBeNull(); // nothing configured: unlimited

    // `speedtest record … --keep-cap` on a fresh install: only the capacity is stored.
    recordCapacity(env.ctx.db, 10_000_000, { keepCap: true });
    env.ctx.events.emit('settings.changed', { key: 'upload.capacity_bps' });
    expect(readSettings(env.ctx.db).uploadCapBps).toBe(9_000_000);
    expect(p2p.uploadCapBps()).toBe(9_000_000);

    writeCap(env.ctx.db, 4_000_000);
    env.ctx.events.emit('settings.changed', { key: 'upload.cap_bps' });
    expect(p2p.uploadCapBps()).toBe(4_000_000);
  });

  it('applies a capacity-derived cap that already exists at start', async () => {
    env = await makeEnv();
    recordCapacity(env.ctx.db, 20_000_000, { keepCap: true });
    p2p = createP2P(env.ctx, { seeder: false });
    await p2p.start();
    expect(p2p.uploadCapBps()).toBe(18_000_000);
  });
});
