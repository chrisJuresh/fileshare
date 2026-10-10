import { afterEach, describe, expect, it } from 'vitest';
import { makeEnv, type TestEnv } from '../../test/integration/p2p-helpers.js';
import { buildStats } from '../admin/stats.js';
import { setSetting } from '../db/index.js';
import { createP2P, type P2P } from '../p2p/index.js';
import { effectiveCapBps, KEY_CAP, KEY_CAPACITY } from './upload-cap.js';

describe('effective upload cap: the limiter enforces what the dashboard shows', () => {
  let env: TestEnv;
  let p2p: P2P | undefined;
  afterEach(async () => {
    await p2p?.stop();
    p2p = undefined;
    await env.cleanup();
  });

  it('unlimited → 90 % of capacity → explicit cap, applied live', async () => {
    env = await makeEnv();
    const { db, events } = env.ctx;
    p2p = createP2P(env.ctx, { seeder: false });
    await p2p.start();
    expect(effectiveCapBps(db)).toBe(0);
    expect(p2p.uploadCapBps()).toBeNull(); // unlimited

    setSetting(db, KEY_CAPACITY, 1_000_001);
    events.emit('settings.changed', { key: KEY_CAPACITY });
    expect(p2p.uploadCapBps()).toBe(900_000);
    expect(buildStats(db, 0).upload.capBps).toBe(900_000);

    setSetting(db, KEY_CAP, 500_000);
    events.emit('settings.changed', { key: KEY_CAP });
    expect(p2p.uploadCapBps()).toBe(500_000);
    expect(buildStats(db, 0).upload.capBps).toBe(500_000);
  });

  it('applies a capacity-only setting at start', async () => {
    env = await makeEnv();
    setSetting(env.ctx.db, KEY_CAPACITY, 2000);
    p2p = createP2P(env.ctx, { seeder: false });
    await p2p.start();
    expect(p2p.uploadCapBps()).toBe(1800);
  });
});
