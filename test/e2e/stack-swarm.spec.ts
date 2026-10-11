// Real app: 3 Chromium peers + a plain torrent client in one share's swarm, with the server's upload
// capped so peers must trade pieces. Checks hashes, peer exchange, server bytes < delivered bytes,
// the cap, the live swarm tables (recipient + admin) and that no message carries an IP address.
import { expect, test } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ServerMsg, ShareDto, StatsDto } from '../../src/types.ts';
import { admin, createShare, findIps, fmtMB, pub, SCRATCH, seedItem, setCap, sha256File, sleep, stack, stripConfigured, worstCapEnvelope, type RateSample } from '../helpers/stack.ts';
import {
  closePeers,
  hookState,
  launchPeer,
  openAdminLive,
  opfsHashesInPage,
  startDownload,
  startTorrentClient,
  swarmMessages,
  type BrowserPeer,
  type TorrentClient,
} from '../helpers/swarm.ts';

test.setTimeout(300_000);

const MiB = 1024 * 1024;
const CAP = 6_000_000; // bytes/s for ALL server upload

test('3 browsers and a torrent client share one capped swarm; live tables; no IPs', async () => {
  const s = stack();
  const tag = randomBytes(4).toString('hex');
  const item = await seedItem(`swarm-${tag}`, [
    { path: 'big.bin', size: 40 * MiB },
    { path: 'nested/a/b/one.bin', size: 6 * MiB },
    { path: 'nested/a/b/two.bin', size: 3 * MiB + 12345 },
    { path: 'nested/a/c.bin', size: 1 * MiB + 7 },
    { path: 'top.txt', size: 2000 },
  ]);
  await setCap(CAP);
  const password = `pw-${tag}`;
  const share = await createShare(item.id, { password });
  const live = await openAdminLive();
  const profiles = path.join(SCRATCH, 'profiles', `swarm-${tag}`);
  const peers: BrowserPeer[] = [];
  let tc: TorrentClient | undefined;
  const samples: RateSample[] = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const [r, sh] = await Promise.all([admin<StatsDto>('GET', '/api/admin/stats'), admin<ShareDto[]>('GET', '/api/admin/shares')]);
      const st = (sh.body as ShareDto[]).find((d) => d.id === share.id)!.stats;
      samples.push({ at: Date.now(), bps: r.body.upload.currentBps, serverBytes: st.serverBytesP2p + st.serverBytesWebseed });
      await sleep(1000);
    }
  })();
  const t0 = Date.now();
  try {
    for (let i = 0; i < 3; i++) peers.push(await launchPeer(i, profiles, { webseedAfterMs: 600_000 }));
    await Promise.all(peers.map((p) => startDownload(p, share.url, password)));

    // A torrent client joins with the .torrent a named recipient got from the page (recipient token).
    const { token } = (await pub<{ token: string }>('POST', `/api/s/${share.id}/unlock`, { password, name: 'Synthetic Torrent' })).body;
    const torrentRes = await pub('GET', `/api/s/${share.id}/torrent?t=${token}`);
    expect(torrentRes.status).toBe(200);
    tc = await startTorrentClient(Buffer.from(torrentRes.text, 'latin1'), path.join(SCRATCH, 'tmp', `tc-${tag}`));

    // The client appears in the recipients' table under that recipient's name.
    await expect
      .poll(() => peers.some((p) => swarmMessages(p).some((m) => m.peers.some((r) => r.kind === 'client' && r.label === 'Synthetic Torrent'))), {
        timeout: 60_000,
      })
      .toBe(true);

    await expect
      .poll(async () => (await Promise.all(peers.map((p) => hookState(p.page)))).every((st) => st.saved), { timeout: 240_000, intervals: [1000] })
      .toBe(true);
    await tc.done;
    const duration = Date.now() - t0;

    // Hashes: browsers (OPFS) and the torrent client (disk).
    const expected = Object.fromEntries(item.files.map((f) => [`${item.name}/${f.path}`, f.sha256]));
    for (const p of peers) expect(await opfsHashesInPage(p.page)).toEqual(expected);
    for (const f of item.files) expect(await sha256File(path.join(tc.dir, item.name, f.path))).toBe(f.sha256);

    const states = await Promise.all(peers.map((p) => hookState(p.page)));
    for (const st of states) {
      expect(st.error).toBeNull();
      // big.bin (40 MiB) ends exactly on a piece boundary: the page must still reach 100 %.
      expect(st.progress).toBe(1);
    }
    const peerUploaded = states.reduce((a, st) => a + st.uploaded, 0);
    const webseedBytes = states.reduce((a, st) => a + st.webseedBytes, 0);
    await sleep(2500); // last stats messages
    const dto = (await admin<ShareDto>('GET', '/api/admin/shares')).body as unknown as ShareDto[];
    const st = dto.find((d) => d.id === share.id)!.stats;
    const serverBytes = st.serverBytesP2p + st.serverBytesWebseed;
    const delivered = item.totalBytes * (peers.length + 1);
    console.log(
      `[swarm] ${peers.length} browsers + 1 client, ${fmtMB(item.totalBytes)} each, ${(duration / 1000).toFixed(1)} s; ` +
        `server ${fmtMB(serverBytes)} (p2p ${fmtMB(st.serverBytesP2p)}, webseed ${fmtMB(st.serverBytesWebseed)}), ` +
        `browsers uploaded ${fmtMB(peerUploaded)} (share_stats peer_bytes ${fmtMB(st.peerBytes)}), browser webseed ${fmtMB(webseedBytes)}, ` +
        `delivered ${fmtMB(delivered)}, saved ${((1 - serverBytes / delivered) * 100).toFixed(1)} %, max 2 s server rate ${fmtMB(Math.max(...samples.map((x) => x.bps)))}/s, cap envelope ${(worstCapEnvelope(samples, CAP) * 100).toFixed(0)} %`,
    );
    expect(peerUploaded).toBeGreaterThan(item.totalBytes / 2);
    expect(serverBytes).toBeLessThan(delivered);
    expect(st.completedDownloads).toBeGreaterThanOrEqual(peers.length);
    expect(worstCapEnvelope(samples, CAP)).toBeLessThanOrEqual(1.05);
    expect(Math.max(...samples.map((x) => x.bps))).toBeLessThanOrEqual(CAP * 1.5);

    // Live tables: recipients see the server row + every browser (with progress) + the client.
    const all = peers.flatMap((p) => swarmMessages(p));
    expect(all.some((m) => m.peers.some((r) => r.id === 'srv' && r.kind === 'server' && r.label === 'Server'))).toBe(true);
    expect(all.some((m) => m.peers.filter((r) => r.kind === 'browser').length >= peers.length)).toBe(true);
    expect(all.some((m) => m.peers.some((r) => r.kind === 'browser' && r.progress > 0 && r.progress < 1))).toBe(true);
    for (const m of all) for (const r of m.peers) expect(r.id).toMatch(/^(srv|p\d+)$/);
    // Admin live stream has the same swarm.
    const adminSwarms = live.messages().map((m) => m.shares[share.id]).filter(Boolean);
    expect(adminSwarms.some((w) => w!.peers.some((r) => r.kind === 'server') && w!.peers.filter((r) => r.kind === 'browser').length >= peers.length)).toBe(true);
    expect(adminSwarms.some((w) => w!.peers.some((r) => r.kind === 'client'))).toBe(true);

    // A recipient reloading comes back with a new peer id. Its old row goes at once (the old page's
    // live socket closes with 1001) instead of lingering 30 s next to the new one, WebRTC wire included.
    const browsers = (m: ServerMsg) => m.peers.filter((r) => r.kind === 'browser');
    const reloadedRow = (m: ServerMsg | undefined) => m && browsers(m).find((r) => r.label === 'Synthetic Peer 2');
    const oldId = reloadedRow(swarmMessages(peers[0]!).at(-1))!.id;
    const from = swarmMessages(peers[0]!).length;
    const since = () => swarmMessages(peers[0]!).slice(from);
    await peers[2]!.page.reload();
    await expect(peers[2]!.page.getByText('You downloaded these files on an earlier visit.')).toBeVisible({ timeout: 30_000 });
    // The new page joins (new row id) well inside the 30 s linger, and the table never shows both.
    const newId = () => reloadedRow(since().at(-1))?.id;
    await expect.poll(() => newId() !== undefined && newId() !== oldId, { timeout: 15_000 }).toBe(true);
    await sleep(3000);
    expect(Math.max(...since().map((m) => browsers(m).length))).toBe(peers.length);
    expect(since().at(-1)!.peers.some((r) => r.id === oldId)).toBe(false);
    // The torrent app (its own peer id) keeps its row through a browser leaving.
    expect(since().every((m) => m.peers.some((r) => r.kind === 'client' && r.label === 'Synthetic Torrent'))).toBe(true);

    // No IP address in any live frame, admin frame, public API response or info-level app log line.
    const texts = [
      ...peers.flatMap((p) => p.liveFrames),
      ...live.frames,
      ...peers.flatMap((p) => p.apiBodies.map((b) => b.body)),
      JSON.stringify(dto),
      (await admin('GET', '/api/admin/stats')).text,
      ...(await readFile(s.paths.appLog, 'utf8')).split('\n').filter((l) => /"level":(30|40|50|60)/.test(l)),
    ];
    const leaks = texts.flatMap((t) => findIps(stripConfigured(t)).map((ip) => `${ip} in ${t.slice(0, 160)}`));
    expect(leaks).toEqual([]);
    expect(peers.flatMap((p) => p.pageErrors)).toEqual([]);
  } finally {
    sampling = false;
    await sampler;
    live.close();
    await tc?.destroy();
    await closePeers(peers);
    if (tc) await rm(tc.dir, { recursive: true, force: true });
    await setCap(10_000_000_000);
  }
});
