// @big — 6 Chromium peers download one share at the same time from the real app: a large random file
// (FILESHARE_BIG_SIZE, default 10G) plus a nested multi-file folder, all files selected, saved through
// the pickDirectory hook into each peer's OPFS. The server's upload is capped (FILESHARE_BIG_CAP,
// default 50 MB/s) so it cannot serve everyone quickly; the webseed fallback is pushed out of the way.
// Asserts: every peer completes; every file's SHA-256 (computed in Node from the bytes the browser
// wrote) matches; peers uploaded to each other; server bytes < bytes delivered; the server's upload
// rate stayed at the cap; live tables (recipient + admin) show the server row and the browsers with
// progress; no IP address in any captured message.
//
//   FILESHARE_BIG=1 FILESHARE_BIG_SIZE=1G npx playwright test --grep @big
import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rm, statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ShareDto, StatsDto } from '../../src/types.ts';
import { admin, createShare, findIps, fmtMB, SCRATCH, seedItem, setCap, sleep, stack, startHashSink, stripConfigured, worstCapEnvelope, type RateSample } from '../helpers/stack.ts';
import { closePeers, cpuProfileTop, hookState, launchPeer, opfsHashesViaSink, openAdminLive, startDownload, swarmMessages, wtDiag, type BrowserPeer, type HookState } from '../helpers/swarm.ts';

const DIAG = !!process.env.FILESHARE_DIAG;

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const PEERS = Number(process.env.FILESHARE_BIG_PEERS ?? 6);
const CAP = Number(process.env.FILESHARE_BIG_CAP ?? 50_000_000);

function parseSize(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([KMG]?)i?B?$/i.exec(s.trim());
  if (!m) throw new Error(`bad FILESHARE_BIG_SIZE: ${s}`);
  const mult = { '': 1, K: 1024, M: MiB, G: GiB }[m[2]!.toUpperCase() as '' | 'K' | 'M' | 'G'];
  return Math.round(Number(m[1]) * mult);
}
const BIG = parseSize(process.env.FILESHARE_BIG_SIZE ?? '10G');

test('@big 6 Chromium peers, one big share, capped server', async () => {
  test.setTimeout(6 * 3600_000);
  const s = stack();
  const tag = randomBytes(4).toString('hex');
  const profiles = path.join(SCRATCH, 'profiles', `big-${tag}`);
  const free = await statfs(SCRATCH);
  expect(free.bavail * free.bsize, 'scratch space').toBeGreaterThan(BIG * (2 * PEERS + 2));

  // A 10 GiB library item must not be snapshotted mid-test: pause the restic runner.
  const stackScript = path.join(s.repoDir, 'scripts', 'test-stack.sh');
  if (s.restic) execFileSync(stackScript, ['restic', 'stop'], { stdio: 'inherit' });

  const peers: BrowserPeer[] = [];
  let itemId: string | undefined;
  let live: Awaited<ReturnType<typeof openAdminLive>> | undefined;
  const t = { seed: 0, download: 0, verify: 0 };
  const samples: RateSample[] = [];
  let sampling = false;
  let sampler: Promise<void> | undefined;
  try {
    let t0 = Date.now();
    const item = await seedItem(`big-${tag}`, [
      { path: 'big.bin', size: BIG },
      { path: 'nested/a/b/one.bin', size: 1 * MiB },
      { path: 'nested/a/b/two.bin', size: 7 * MiB + 3 },
      { path: 'nested/a/b/three.bin', size: 23 * MiB },
      { path: 'nested/a/c/four.bin', size: 50 * MiB },
      { path: 'nested/top.bin', size: 13 * MiB + 1 },
    ]);
    itemId = item.id;
    t.seed = Date.now() - t0;
    console.log(`[big] seeded ${fmtMB(item.totalBytes)} (${item.files.length} files) in ${(t.seed / 1000).toFixed(0)} s`);

    await setCap(CAP);
    const share = await createShare(item.id);
    live = await openAdminLive();
    const shareStats = async (): Promise<ShareDto['stats']> =>
      ((await admin<ShareDto[]>('GET', '/api/admin/shares')).body as ShareDto[]).find((d) => d.id === share.id)!.stats;
    sampling = true;
    sampler = (async () => {
      while (sampling) {
        const [st, ss] = await Promise.all([admin<StatsDto>('GET', '/api/admin/stats'), shareStats()]);
        samples.push({ at: Date.now(), bps: st.body.upload.currentBps, serverBytes: ss.serverBytesP2p + ss.serverBytesWebseed });
        await sleep(1000);
      }
    })();

    for (let i = 0; i < PEERS; i++) peers.push(await launchPeer(i, profiles, { webseedAfterMs: 24 * 3600_000, spy: DIAG }));
    t0 = Date.now();
    await Promise.all(peers.map((p) => startDownload(p, share.url)));

    // Wait for every peer to finish saving; progress line every 30 s.
    let lastLog = 0;
    let lastDiag = 0;
    const lastMove = peers.map(() => ({ progress: -1, at: Date.now(), profiled: false }));
    const stallMs = Number(process.env.FILESHARE_BIG_STALL_MIN ?? 20) * 60_000;
    let swarmProgress = { sum: -1, at: Date.now() };
    let states: HookState[] = [];
    for (;;) {
      states = await Promise.all(peers.map((p) => hookState(p.page)));
      const errs = states.filter((x) => x.error);
      if (errs.length) throw new Error(`peer error: ${errs.map((x) => x.error).join('; ')}`);
      if (states.every((x) => x.saved)) break;
      const sum = states.reduce((a, x) => a + x.progress + (x.saved ? 1 : 0), 0);
      // Once every byte is downloaded only the disk-bound saving remains (not visible in the hook).
      if (sum > swarmProgress.sum + 0.001 || states.every((x) => x.progress === 1)) swarmProgress = { sum, at: Date.now() };
      else if (Date.now() - swarmProgress.at > stallMs) {
        throw new Error(
          `no progress for ${stallMs / 60_000} min after ${((Date.now() - t0) / 1000).toFixed(0)} s: ` +
            states.map((x) => `${(x.progress * 100).toFixed(1)}%${x.saved ? ' saved' : ''} (${x.numPeers} conns)`).join(', '),
        );
      }
      if (Date.now() - lastLog > 30_000) {
        lastLog = Date.now();
        const last = samples.at(-1);
        console.log(
          `[big] ${((Date.now() - t0) / 1000).toFixed(0)} s: progress ${states.map((x) => `${(x.progress * 100).toFixed(0)}%${x.saved ? '✓' : ''}`).join(' ')}; ` +
            `peers/conn ${states.map((x) => x.numPeers).join(',')}; up ${states.map((x) => fmtMB(x.uploaded)).join(', ')}; ` +
            `server ${fmtMB(last?.serverBytes ?? 0)} @ ${fmtMB(last?.bps ?? 0)}/s; free RAM ${(os.freemem() / GiB).toFixed(1)} GiB`,
        );
      }
      if (DIAG) {
        for (const [i, x] of states.entries()) {
          const m = lastMove[i]!;
          if (x.progress !== m.progress) Object.assign(m, { progress: x.progress, at: Date.now() });
          else if (!x.saved && !m.profiled && Date.now() - m.at > 60_000) {
            m.profiled = true;
            console.log(`[diag ${i}] stalled at ${(x.progress * 100).toFixed(1)} % for 60 s; wt:`, JSON.stringify(await wtDiag(peers[i]!.page)));
            console.log(`[diag ${i}] CPU profile:\n  ${(await cpuProfileTop(peers[i]!.page)).join('\n  ')}`);
          }
        }
      }
      if (DIAG && Date.now() - lastDiag > 60_000) {
        lastDiag = Date.now();
        for (const p of peers) console.log(`[diag ${p.index}]`, JSON.stringify(await wtDiag(p.page)));
        const w = live.messages().at(-1)?.shares[share.id];
        console.log('[diag server]', JSON.stringify(w?.peers.map((r) => [r.id, r.kind, r.progress.toFixed(3), r.up, r.down])));
      }
      if (os.freemem() < 0.7 * GiB) throw new Error(`host RAM nearly exhausted (${(os.freemem() / MiB).toFixed(0)} MiB free)`);
      await sleep(2000);
    }
    t.download = Date.now() - t0;
    await sleep(3000); // last stats + live messages
    sampling = false;
    await sampler;
    const st = await shareStats();
    states = await Promise.all(peers.map((p) => hookState(p.page)));

    // ---- numbers
    const serverBytes = st.serverBytesP2p + st.serverBytesWebseed;
    const delivered = item.totalBytes * PEERS;
    const peerUploaded = states.reduce((a, x) => a + x.uploaded, 0);
    const peerWebseed = states.reduce((a, x) => a + x.webseedBytes, 0);
    // Per-second server rate from share_stats deltas (independent of the app's own 2 s average).
    const perSec: number[] = [];
    for (let i = 1; i < samples.length; i++) {
      const dt = (samples[i]!.at - samples[i - 1]!.at) / 1000;
      if (dt > 0.5) perSec.push((samples[i]!.serverBytes - samples[i - 1]!.serverBytes) / dt);
    }
    const windowed: number[] = []; // 5 s windows (stats flush granularity smooths 1 s deltas)
    for (let i = 5; i < samples.length; i++) {
      windowed.push((samples[i]!.serverBytes - samples[i - 5]!.serverBytes) / ((samples[i]!.at - samples[i - 5]!.at) / 1000));
    }
    console.log(
      `[big] ${PEERS} peers × ${fmtMB(item.totalBytes)}: download ${(t.download / 1000).toFixed(0)} s; server ${fmtMB(serverBytes)} ` +
        `(p2p ${fmtMB(st.serverBytesP2p)}, webseed ${fmtMB(st.serverBytesWebseed)}); peers uploaded ${fmtMB(peerUploaded)} ` +
        `(share_stats peer_bytes ${fmtMB(st.peerBytes)}); browser webseed ${fmtMB(peerWebseed)}; delivered ${fmtMB(delivered)}; ` +
        `saved ${((1 - serverBytes / delivered) * 100).toFixed(1)} %; server avg ${fmtMB(serverBytes / (t.download / 1000))}/s, ` +
        `max 2 s avg ${fmtMB(Math.max(...samples.map((x) => x.bps)))}/s, max 5 s window ${fmtMB(Math.max(...windowed))}/s; ` +
        `completed ${st.completedDownloads}, peak swarm ${st.peakSwarm}`,
    );
    for (const x of states) expect(x.saved && x.done && x.error === null && x.progress === 1).toBe(true);
    expect(peerUploaded).toBeGreaterThan(item.totalBytes); // peers served each other at least one full copy
    expect(serverBytes).toBeLessThan(delivered);
    expect(st.completedDownloads).toBeGreaterThanOrEqual(PEERS);
    // Token bucket with 1 s of tokens: ≤ cap × (T + 1) over any window (see worstCapEnvelope).
    const worst = worstCapEnvelope(samples, CAP);
    console.log(`[big] worst window vs token-bucket envelope cap×(T+1): ${(worst * 100).toFixed(1)} %`);
    expect(worst).toBeLessThanOrEqual(1.05);
    expect(Math.max(...samples.map((x) => x.bps))).toBeLessThanOrEqual(CAP * 1.5); // 2 s average: ≤ (2 s + 1 s burst) / 2 s

    // ---- swarm tables (g)
    const msgs = peers.flatMap((p) => swarmMessages(p));
    expect(msgs.some((m) => m.peers.some((r) => r.id === 'srv' && r.kind === 'server'))).toBe(true);
    expect(msgs.some((m) => m.peers.filter((r) => r.kind === 'browser').length >= PEERS)).toBe(true);
    expect(msgs.some((m) => m.peers.filter((r) => r.kind === 'browser' && r.progress > 0 && r.progress < 1).length >= 2)).toBe(true);
    const adm = live.messages().map((m) => m.shares[share.id]).filter(Boolean);
    expect(adm.some((w) => w!.peers.some((r) => r.kind === 'server') && w!.peers.filter((r) => r.kind === 'browser').length >= PEERS)).toBe(true);
    const texts = [
      ...peers.flatMap((p) => p.liveFrames),
      ...live.frames,
      ...peers.flatMap((p) => p.apiBodies.map((b) => b.body)),
      ...(await readFile(s.paths.appLog, 'utf8')).split('\n').filter((l) => /"level":(30|40|50|60)/.test(l)),
    ];
    expect(texts.flatMap((x) => findIps(stripConfigured(x)).map((ip) => `${ip} in ${x.slice(0, 120)}`))).toEqual([]);
    live.close();
    live = undefined;

    // ---- hashes, computed in Node from what each browser wrote (relaunch with bypassCSP so the
    // page may POST its OPFS files to the loopback hash sink; CSP was enforced during the download).
    await closePeers(peers, false);
    t0 = Date.now();
    const sink = await startHashSink();
    try {
      const expected = Object.fromEntries(item.files.map((f) => [`${item.name}/${f.path}`, { sha256: f.sha256, bytes: f.length }]));
      for (let i = 0; i < PEERS; i++) {
        const v = await launchPeer(i, profiles, { bypassCSP: true });
        peers[i] = v;
        await v.page.goto(`${s.publicUrl}/healthz`);
        expect(await opfsHashesViaSink(v.page, sink.url), `peer ${i}`).toEqual(expected);
        await v.context.close();
        await rm(v.profile, { recursive: true, force: true });
      }
    } finally {
      await sink.close();
    }
    t.verify = Date.now() - t0;
    console.log(`[big] verified ${PEERS} × ${item.files.length} files (SHA-256 in Node) in ${(t.verify / 1000).toFixed(0)} s`);
  } finally {
    sampling = false;
    await sampler;
    live?.close();
    await closePeers(peers);
    await rm(profiles, { recursive: true, force: true });
    if (itemId) await admin('DELETE', `/api/admin/items/${itemId}`, {}); // revokes the share, removes the library copy
    await setCap(10_000_000_000);
    if (s.restic) execFileSync(stackScript, ['restic', 'start'], { stdio: 'inherit' });
  }
});
