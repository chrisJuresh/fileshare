// Real app: ONE upload cap for all server egress. A webseed download and a BitTorrent (seeder) download
// run at the same time; their combined rate stays at the cap. The cap is then changed through the
// admin API and through the operator CLI, and the new rate applies live.
import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { SettingsDto, ShareDto, StatsDto, UnlockResponse } from '../../src/types.ts';
import { admin, cli, createShare, fmtMB, pub, SCRATCH, seedItem, setCap, sleep } from '../helpers/stack.ts';
import { startTorrentClient, type TorrentClient } from '../helpers/swarm.ts';

test.setTimeout(240_000);
const MiB = 1024 * 1024;

test('webseed + seeder together stay under the cap; cap changes apply live (API and CLI)', async () => {
  const tag = randomBytes(4).toString('hex');
  const item = await seedItem(`cap-${tag}`, [{ path: 'payload.bin', size: 320 * MiB }]);
  const share = await createShare(item.id);
  const u = (await pub<UnlockResponse>('POST', `/api/s/${share.id}/unlock`, {})).body;
  await setCap(4_000_000);

  // Consumer 1: plain HTTP webseed.
  const ctl = new AbortController();
  let webseedBytes = 0;
  const res = await fetch(`${u.webseed}${encodeURIComponent(item.name)}/payload.bin`, { signal: ctl.signal });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      webseedBytes += value.length;
    }
  })().catch(() => {});

  // Consumer 2: a torrent client served by the seeder (TCP).
  const torrentFile = Buffer.from((await pub('GET', `/api/s/${share.id}/torrent?t=${u.token}`)).text, 'latin1');
  const tc: TorrentClient = await startTorrentClient(torrentFile, path.join(SCRATCH, 'tmp', `cap-${tag}`), 28220);

  const serverBytes = async (): Promise<number> => {
    const d = ((await admin<ShareDto[]>('GET', '/api/admin/shares')).body as ShareDto[]).find((x) => x.id === share.id)!;
    return d.stats.serverBytesP2p + d.stats.serverBytesWebseed;
  };
  const samples: { at: number; bps: number; cap: number }[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const st = (await admin<StatsDto>('GET', '/api/admin/stats')).body;
      samples.push({ at: Date.now(), bps: st.upload.currentBps, cap: st.upload.capBps });
      await sleep(1000);
    }
  })();

  /** Server egress for this share over `ms`, plus each consumer's share of it. */
  const measure = async (ms: number) => {
    const s0 = await serverBytes();
    const w0 = webseedBytes;
    const t0 = tc.torrent.downloaded as number;
    const start = Date.now();
    await sleep(ms);
    const secs = (Date.now() - start) / 1000;
    return {
      server: (await serverBytes()) - s0,
      bps: ((await serverBytes()) - s0) / secs,
      webseedBps: (webseedBytes - w0) / secs,
      torrentBps: ((tc.torrent.downloaded as number) - t0) / secs,
    };
  };

  try {
    await sleep(3000); // both connected and flowing
    const a = await measure(12_000);
    const b0 = Date.now();
    await setCap(2_000_000);
    await sleep(2500);
    const b = await measure(10_000);
    const bWindow = [b0 + 2500, Date.now()];
    const c0 = Date.now();
    const r = cli(['settings', 'set-cap', '64']); // 64 Mbit/s = 8 MB/s
    expect(r.code, r.stderr).toBe(0);
    expect((await admin<SettingsDto>('GET', '/api/admin/settings')).body.uploadCapBps).toBe(8_000_000);
    // The app's settings watcher polls every 3 s.
    await expect.poll(async () => (await admin<StatsDto>('GET', '/api/admin/stats')).body.upload.currentBps, { timeout: 15_000 }).toBeGreaterThan(3_000_000);
    const applied = Date.now() - c0;
    const c = await measure(10_000);
    const fmt = (m: typeof a) => `${fmtMB(m.bps)}/s (webseed ${fmtMB(m.webseedBps)}/s + torrent ${fmtMB(m.torrentBps)}/s)`;
    console.log(`[cap] 4 MB/s: ${fmt(a)}; API→2 MB/s: ${fmt(b)}; CLI→8 MB/s (applied after ${applied} ms): ${fmt(c)}`);

    for (const [m, cap] of [[a, 4e6], [b, 2e6], [c, 8e6]] as const) {
      expect(m.bps).toBeLessThanOrEqual(cap * 1.1);
      expect(m.bps).toBeGreaterThan(cap * 0.6); // the cap is actually used
      expect(m.webseedBps).toBeGreaterThan(0); // both paths active at the same time
      expect(m.torrentBps).toBeGreaterThan(0);
      expect(m.webseedBps + m.torrentBps).toBeLessThanOrEqual(cap * 1.15);
    }
    // 2 s moving average reported by the app never above the cap in force (+ burst tolerance).
    const inB = samples.filter((x) => x.at >= bWindow[0]! && x.at <= bWindow[1]!);
    expect(inB.length).toBeGreaterThan(5);
    for (const x of inB) expect(x.bps).toBeLessThanOrEqual(2e6 * 1.15);
  } finally {
    sampling = false;
    await sampler;
    ctl.abort();
    await pump;
    await tc.destroy();
    await rm(tc.dir, { recursive: true, force: true });
    await setCap(10_000_000_000);
  }
});
