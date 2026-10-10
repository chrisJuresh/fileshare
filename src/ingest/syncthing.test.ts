import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeSyncthing, waitFor, type FakeSyncthing } from '../../test/helpers/ingest-fakes.js';
import { createLogger } from '../log.js';
import { INGEST_EVENT_TYPES, isUnderEntry, runEventLoop, SyncthingClient, SyncthingError, type SyncthingEvent } from './syncthing.js';

describe('SyncthingClient', () => {
  let fake: FakeSyncthing;
  let client: SyncthingClient;
  beforeEach(async () => {
    fake = await startFakeSyncthing(randomBytes(16).toString('hex'));
    client = new SyncthingClient({ baseUrl: fake.url, apiKey: () => fake.apiKey });
  });
  afterEach(() => fake.close());

  it('sends the API key and reads status / completion', async () => {
    fake.state.folderState = 'syncing';
    fake.state.completion = 42.5;
    expect((await client.folderStatus('fileshare-outbox')).state).toBe('syncing');
    expect((await client.completion('fileshare-outbox', 'DEV')).completion).toBe(42.5);
    expect(fake.requests.every((r) => r.apiKey === fake.apiKey)).toBe(true);
    const comp = fake.requests.find((r) => r.path === '/rest/db/completion')!;
    expect(comp.query.get('device')).toBe('DEV');
  });

  it('pages through the need list', async () => {
    fake.state.need = Array.from({ length: 1005 }, (_, i) => `dir/file-${i}`);
    const names = await client.neededNames('fileshare-outbox');
    expect(names).toHaveLength(1005);
    expect(fake.requests.filter((r) => r.path === '/rest/db/need')).toHaveLength(2);
  });

  it('errors never contain the key', async () => {
    const bad = new SyncthingClient({ baseUrl: fake.url, apiKey: () => 'wrong-key-value' });
    const err = await bad.folderStatus('fileshare-outbox').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncthingError);
    expect((err as Error).message).not.toContain('wrong-key-value');
    expect((err as SyncthingError).status).toBe(403);
    fake.state.reachable = false;
    const err2 = await client.folderStatus('fileshare-outbox').catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(SyncthingError);
    expect((err2 as Error).message).not.toContain(fake.apiKey);
  });

  it('long-polls events and reconnects after an outage', async () => {
    const got: SyncthingEvent[] = [];
    const reach: boolean[] = [];
    const ctl = new AbortController();
    fake.state.reachable = false;
    const loop = runEventLoop({
      client,
      types: INGEST_EVENT_TYPES,
      signal: ctl.signal,
      log: createLogger('silent'),
      pollTimeoutS: 1,
      minBackoffMs: 50,
      maxBackoffMs: 100,
      onEvents: (e) => got.push(...e),
      onReachable: (r) => reach.push(r),
    });
    await waitFor(() => reach.includes(false));
    fake.state.reachable = true;
    fake.pushEvent('ItemFinished', { folder: 'fileshare-outbox', item: 'Album/a.bin' });
    await waitFor(() => got.length === 1);
    fake.pushEvent('LocalIndexUpdated', { folder: 'fileshare-outbox', filenames: ['Album/b.bin'] });
    await waitFor(() => got.length === 2);
    expect(got.map((e) => e.type)).toEqual(['ItemFinished', 'LocalIndexUpdated']);
    const evReq = fake.requests.filter((r) => r.path === '/rest/events').at(-1)!;
    expect(evReq.query.get('events')).toBe(INGEST_EVENT_TYPES.join(','));
    ctl.abort();
    await loop;
  });

  it('matches names under an entry', () => {
    expect(isUnderEntry('Album', 'Album')).toBe(true);
    expect(isUnderEntry('Album/x/y', 'Album')).toBe(true);
    expect(isUnderEntry('Album2/x', 'Album')).toBe(false);
    expect(isUnderEntry('Albu', 'Album')).toBe(false);
    expect(isUnderEntry('Café/x', 'Café')).toBe(true); // NFD vs NFC
  });
});
