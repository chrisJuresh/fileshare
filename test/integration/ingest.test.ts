// Ingest pipeline end-to-end against a fake Syncthing REST server and a fake restic runner.
// Synthetic random data only; quiet period 2 s.
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ItemRow } from '../../src/db/index.js';
import { createIngest, OUTBOX_CHANGED_ERROR, type IngestService } from '../../src/ingest/index.js';
import { makeTestEnv, runFakeBackup, sleep, startFakeSyncthing, waitFor, type FakeSyncthing, type TestEnv } from '../helpers/ingest-fakes.js';

const KiB = 1024;
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('ingest pipeline (outbox)', () => {
  let fake: FakeSyncthing;
  let env: TestEnv;
  let ingest: IngestService;
  let p2p: { revokeAllForItem: ReturnType<typeof vi.fn>; repointItem: ReturnType<typeof vi.fn> };
  let transitions: { itemId: string; status: string; at: number }[];
  let outbox: string;
  let library: string;

  const item = (sourceName: string): ItemRow | undefined =>
    env.ctx.db.prepare('SELECT * FROM items WHERE source_name = ? ORDER BY created_at DESC LIMIT 1').get(sourceName) as ItemRow | undefined;
  const itemById = (id: string): ItemRow => env.ctx.db.prepare('SELECT * FROM items WHERE id = ?').get(id) as ItemRow;
  const waitStatus = (sourceName: string, status: string, timeoutMs = 15_000): Promise<ItemRow> =>
    waitFor(() => {
      const r = item(sourceName);
      return r?.status === status ? r : undefined;
    }, timeoutMs);
  const newIngest = (): IngestService =>
    createIngest(env.ctx, { p2p }, { tickMs: 150, snapshotPollMs: 150, eventPollTimeoutS: 1, snapshotRerequestMs: 200 });

  beforeEach(async () => {
    const apiKey = randomBytes(24).toString('hex');
    fake = await startFakeSyncthing(apiKey);
    env = makeTestEnv({ SYNCTHING_API_URL: fake.url }, apiKey);
    p2p = { revokeAllForItem: vi.fn(async () => undefined), repointItem: vi.fn(async () => undefined) };
    transitions = [];
    env.ctx.events.on('item.status', (e) => transitions.push({ ...e, at: Date.now() }));
    outbox = env.ctx.config.paths.outbox;
    library = env.ctx.config.paths.library;
    // Syncthing folder markers must never become items.
    mkdirSync(path.join(outbox, '.stfolder'));
    writeFileSync(path.join(outbox, '.stignore'), '');
    ingest = newIngest();
    await ingest.start();
  });

  afterEach(async () => {
    await ingest.stop();
    await fake.close();
    env.cleanup();
  });

  it('slow copy: nothing placed until stable; outbox kept until a covering snapshot; then removed and ready', async () => {
    const entry = path.join(outbox, 'Album');
    mkdirSync(entry);
    const big = path.join(entry, 'big.bin');
    writeFileSync(big, randomBytes(256 * KiB));
    // A second file arriving the Syncthing way: temp file, renamed at the end.
    const tmp = path.join(entry, '.syncthing.photo.jpg.tmp');
    writeFileSync(tmp, randomBytes(64 * KiB));
    await waitStatus('Album', 'stabilising', 3000); // found by the periodic rescan
    // Grow the file in chunks for ~3.5 s (longer than the 2 s quiet period, each gap shorter).
    for (let i = 0; i < 7; i++) {
      await sleep(500);
      appendFileSync(big, randomBytes(256 * KiB));
      if (i === 3) renameSync(tmp, path.join(entry, 'photo.jpg'));
      // (a) not placed or hashed while still changing
      expect(existsSync(path.join(library, 'Album'))).toBe(false);
      expect(item('Album')?.status).toBe('stabilising');
      expect(ingest.progress()).toEqual({});
    }
    const lastWrite = Date.now();
    const snap = await waitStatus('Album', 'snapshotting');
    const hashingAt = transitions.find((t) => t.itemId === snap.id && t.status === 'hashing')!.at;
    expect(hashingAt - lastWrite).toBeGreaterThanOrEqual(1900);
    expect(transitions.filter((t) => t.itemId === snap.id).map((t) => t.status)).toEqual(['incoming', 'stabilising', 'hashing', 'snapshotting']);
    // the gate asked Syncthing for need/completion/status
    expect(fake.requests.some((r) => r.path === '/rest/db/need')).toBe(true);
    expect(fake.requests.find((r) => r.path === '/rest/db/completion')?.query.get('device')).toBe(env.ctx.config.env.SYNCTHING_PC_DEVICE_ID);

    // hard-linked, same inode, info stored, snapshot requested
    for (const f of ['big.bin', 'photo.jpg']) {
      expect(statSync(path.join(library, 'Album', f)).ino).toBe(statSync(path.join(entry, f)).ino);
    }
    expect(snap.library_at).not.toBeNull();
    expect(snap.info).not.toBeNull();
    expect(snap.file_count).toBe(2);
    expect(snap.total_bytes).toBe(8 * 256 * KiB + 64 * KiB);
    expect(snap.piece_length).toBe(1024 * KiB);
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM backup_requests WHERE reason = 'ingest' AND item_id = ?").get(snap.id)).toEqual({ n: 1 });

    // (b) no covering snapshot yet → outbox entry stays
    await sleep(800);
    expect(existsSync(big)).toBe(true);
    expect(item('Album')!.status).toBe('snapshotting');
    // a failed run does not count either
    runFakeBackup(env.ctx.db, library, 'failed');
    await sleep(800);
    expect(existsSync(big)).toBe(true);
    expect(item('Album')!.status).toBe('snapshotting');
    // ...and the item re-requested a snapshot after the failure
    await waitFor(() => env.ctx.db.prepare("SELECT 1 FROM backup_requests WHERE item_id = ? AND run_id IS NULL").get(snap.id));

    // (c) covering run → outbox entry removed, item ready, library intact
    const data = readFileSync(path.join(library, 'Album', 'big.bin'));
    const runId = runFakeBackup(env.ctx.db, library, 'ok');
    const ready = await waitStatus('Album', 'ready');
    expect(ready.snapshot_run_id).toBe(runId);
    expect(ready.ready_at).not.toBeNull();
    expect(existsSync(entry)).toBe(false);
    expect(sha(readFileSync(path.join(library, 'Album', 'big.bin')))).toBe(sha(data));
    expect(existsSync(path.join(outbox, '.stfolder'))).toBe(true);
    // marker files never became items
    expect(env.ctx.db.prepare('SELECT COUNT(*) AS n FROM items').get()).toEqual({ n: 1 });
  });

  it('(d) an outbox file modified after hard-linking is never deleted', async () => {
    const entry = path.join(outbox, 'Docs');
    mkdirSync(entry);
    writeFileSync(path.join(entry, 'a.txt'), randomBytes(1000));
    writeFileSync(path.join(entry, 'b.txt'), randomBytes(1000));
    const snap = await waitStatus('Docs', 'snapshotting');
    // PC edits a.txt: Syncthing writes a temp file and renames it over the original (new inode).
    const fresh = randomBytes(1200);
    writeFileSync(path.join(entry, '.syncthing.a.txt.tmp'), fresh);
    renameSync(path.join(entry, '.syncthing.a.txt.tmp'), path.join(entry, 'a.txt'));
    runFakeBackup(env.ctx.db, library, 'ok');
    const failed = await waitFor(() => {
      const r = itemById(snap.id);
      return r.status === 'error' ? r : undefined;
    });
    expect(failed.error).toBe(OUTBOX_CHANGED_ERROR);
    expect(readFileSync(path.join(entry, 'a.txt')).equals(fresh)).toBe(true);
    expect(existsSync(path.join(entry, 'b.txt'))).toBe(true);
    expect(statSync(path.join(library, 'Docs', 'a.txt')).size).toBe(1000); // library keeps the ingested version
    // retry re-verifies and fails again without deleting anything
    await ingest.retry(snap.id);
    await waitFor(() => itemById(snap.id).status === 'error');
    expect(readFileSync(path.join(entry, 'a.txt')).equals(fresh)).toBe(true);
    expect(existsSync(path.join(env.ctx.config.paths.data, '.ingest-trash', snap.id))).toBe(false);
  });

  it('waits for positive Syncthing confirmation (need, folder state, completion, reachability)', async () => {
    fake.state.need = ['Gate/x.bin'];
    const entry = path.join(outbox, 'Gate');
    mkdirSync(entry);
    writeFileSync(path.join(entry, 'x.bin'), randomBytes(5000));
    await sleep(3000);
    expect(item('Gate')!.status).toBe('stabilising');
    fake.state.need = ['Other/y.bin']; // needed files elsewhere don't block this entry...
    fake.state.folderState = 'syncing'; // ...but the folder must be idle
    await sleep(2600);
    expect(item('Gate')!.status).toBe('stabilising');
    fake.state.folderState = 'idle';
    fake.state.completion = 99.5;
    await sleep(2600);
    expect(item('Gate')!.status).toBe('stabilising');
    fake.state.completion = 100;
    fake.state.reachable = false;
    await sleep(2600);
    expect(item('Gate')!.status).toBe('stabilising');
    expect(existsSync(path.join(library, 'Gate'))).toBe(false);
    fake.state.reachable = true;
    await waitStatus('Gate', 'snapshotting');
  }, 30_000);

  it('resumes after a restart and handles disappearing entries', async () => {
    mkdirSync(path.join(outbox, 'Gone'));
    writeFileSync(path.join(outbox, 'Gone', 'f.bin'), randomBytes(10));
    writeFileSync(path.join(outbox, 'single.bin'), randomBytes(3000));
    const gone = await waitStatus('Gone', 'stabilising');
    const { rmSync } = await import('node:fs');
    rmSync(path.join(outbox, 'Gone'), { recursive: true });
    const deleted = await waitFor(() => (itemById(gone.id).status === 'deleted' ? itemById(gone.id) : undefined));
    expect(deleted.deleted_at).not.toBeNull();

    const snap = await waitStatus('single.bin', 'snapshotting');
    expect(snap.kind).toBe('file');
    await ingest.stop();
    ingest = newIngest();
    await ingest.start();
    runFakeBackup(env.ctx.db, library, 'ok');
    await waitStatus('single.bin', 'ready');
    expect(existsSync(path.join(outbox, 'single.bin'))).toBe(false);
    expect(statSync(path.join(library, 'single.bin')).size).toBe(3000);
  });

  it('renames and deletes ready items', async () => {
    writeFileSync(path.join(outbox, 'clip.bin'), randomBytes(4000));
    const snap = await waitStatus('clip.bin', 'snapshotting');
    runFakeBackup(env.ctx.db, library, 'ok');
    await waitStatus('clip.bin', 'ready');

    await expect(ingest.renameItem(snap.id, '../evil')).rejects.toMatchObject({ statusCode: 400 });
    await expect(ingest.renameItem(snap.id, 'bad#name')).rejects.toMatchObject({ statusCode: 400 });
    mkdirSync(path.join(library, 'Taken'));
    await expect(ingest.renameItem(snap.id, 'Taken')).rejects.toMatchObject({ statusCode: 409 });

    const renamed: unknown[] = [];
    env.ctx.events.on('item.renamed', (e) => renamed.push(e));
    await ingest.renameItem(snap.id, 'Clip renamed.bin');
    const r = itemById(snap.id);
    expect(r.name).toBe('Clip renamed.bin');
    expect(existsSync(path.join(library, 'Clip renamed.bin'))).toBe(true);
    expect(existsSync(path.join(library, 'clip.bin'))).toBe(false);
    expect(Buffer.from(r.info!).includes(Buffer.from('16:Clip renamed.bin'))).toBe(true);
    expect(p2p.repointItem).toHaveBeenCalledWith(snap.id);
    expect(renamed).toEqual([{ itemId: snap.id, oldName: 'clip.bin', newName: 'Clip renamed.bin' }]);
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM backup_requests WHERE reason = 'rename'").get()).toEqual({ n: 1 });

    await ingest.deleteItem(snap.id);
    expect(p2p.revokeAllForItem).toHaveBeenCalledWith(snap.id);
    const d = itemById(snap.id);
    expect(d.status).toBe('deleted');
    expect(d.deleted_at).not.toBeNull();
    expect(existsSync(path.join(library, 'Clip renamed.bin'))).toBe(false);
    expect(env.ctx.db.prepare("SELECT COUNT(*) AS n FROM backup_requests WHERE reason = 'delete'").get()).toEqual({ n: 1 });
    await expect(ingest.deleteItem(snap.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(ingest.retry('nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a deleted item frees its name for new items and renames', async () => {
    writeFileSync(path.join(outbox, 'reuse.bin'), randomBytes(2000));
    const first = await waitStatus('reuse.bin', 'snapshotting');
    runFakeBackup(env.ctx.db, library, 'ok');
    await waitStatus('reuse.bin', 'ready');
    await ingest.deleteItem(first.id);
    expect(itemById(first.id).name).toBe(`reuse.bin [deleted ${first.id}]`);

    // Same name arrives again: it gets the plain name, not a timestamp suffix.
    writeFileSync(path.join(outbox, 'reuse.bin'), randomBytes(2100));
    const second = await waitFor(() => {
      const r = item('reuse.bin');
      return r && r.id !== first.id && r.status === 'snapshotting' ? r : undefined;
    });
    expect(second.name).toBe('reuse.bin');
    runFakeBackup(env.ctx.db, library, 'ok');
    await waitFor(() => itemById(second.id).status === 'ready');
    await ingest.renameItem(second.id, 'other.bin');
    await ingest.deleteItem(second.id);
    // …and a rename may take a deleted item's name too.
    writeFileSync(path.join(outbox, 'third.bin'), randomBytes(500));
    const third = await waitStatus('third.bin', 'snapshotting');
    runFakeBackup(env.ctx.db, library, 'ok');
    await waitStatus('third.bin', 'ready');
    await ingest.renameItem(third.id, 'reuse.bin');
    expect(itemById(third.id).name).toBe('reuse.bin');
  });
});

describe('ingest without a PC device id', () => {
  it('keeps outbox items in stabilising', async () => {
    const apiKey = randomBytes(24).toString('hex');
    const fake = await startFakeSyncthing(apiKey);
    const env = makeTestEnv({ SYNCTHING_API_URL: fake.url, SYNCTHING_PC_DEVICE_ID: '' }, apiKey);
    const ingest = createIngest(env.ctx, { p2p: { revokeAllForItem: async () => undefined, repointItem: async () => undefined } }, { tickMs: 150 });
    try {
      await ingest.start();
      writeFileSync(path.join(env.ctx.config.paths.outbox, 'x.bin'), randomBytes(100));
      await sleep(3500);
      const r = env.ctx.db.prepare("SELECT status FROM items WHERE source_name = 'x.bin'").get() as { status: string };
      expect(r.status).toBe('stabilising');
      expect(fake.requests.some((q) => q.path === '/rest/db/need')).toBe(false);
    } finally {
      await ingest.stop();
      await fake.close();
      env.cleanup();
    }
  });
});
