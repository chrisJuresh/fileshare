// Recipient page, Firefox path (no showDirectoryPicker): download into browser storage, then per-file
// "Save" through WebTorrent's service worker (file.streamURL) and "Download all" as a streamed zip.
import { type Page, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type RecipientMock, startRecipientMock } from '../helpers/recipient-mock.ts';
import { openBrowserDownload } from '../helpers/recipient-page.ts';
import { storedZipHashes } from '../helpers/recipient-zip.ts';

test.use({
  browserName: 'firefox',
  launchOptions: { firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false } },
  acceptDownloads: true,
});
test.setTimeout(120_000);

type HookState = { done: boolean; saveMode: string; peerBytes: number; webseedBytes: number; error: string | null };
const hookState = (page: Page): Promise<HookState> =>
  page.evaluate(() => (window as unknown as { __fileshareTest: { state: () => HookState } }).__fileshareTest.state());

let mock: RecipientMock;
test.beforeAll(async () => {
  mock = await startRecipientMock({ password: null });
});
test.afterAll(async () => {
  await mock?.close();
});

test('per-file save via the service worker and a streamed zip of everything', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __fileshareTest: object }).__fileshareTest = {};
  });
  if (process.env.DEBUG_PAGE) {
    page.on('console', (m) => console.log('[page]', m.type(), m.text()));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  }
  await page.goto(mock.shareUrl);
  // No password on this share: only the name is asked.
  await page.getByLabel('Your name').fill('Synthetic Sam');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: mock.name })).toBeVisible();
  await expect.poll(async () => (await hookState(page)).saveMode).toBe('serviceworker'); // hook is installed after mount

  await openBrowserDownload(page);
  await page.getByRole('button', { name: 'Start download' }).click();
  const t0 = Date.now();
  await expect
    .poll(
      async () => {
        const s = await hookState(page);
        if (process.env.DEBUG_PAGE) console.log(Date.now() - t0, JSON.stringify(s));
        return s.done;
      },
      { timeout: 60_000, intervals: [1000] },
    )
    .toBe(true);
  const st = await hookState(page);
  expect(st.error).toBeNull();
  if (process.env.DEBUG_PAGE) console.log('firefox transfer', JSON.stringify(st));
  expect(st.peerBytes + st.webseedBytes).toBeGreaterThan(0);

  // Per-file save (anchor with download attribute → SW streamURL).
  const target = mock.files.find((f) => f.path === 'media/clip one.bin')!;
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: `Save ${target.path}` }).click()]);
  expect(dl.suggestedFilename()).toBe('clip one.bin');
  const savedPath = await dl.path();
  const got = createHash('sha256').update(await readFile(savedPath)).digest('hex');
  expect(got).toBe(target.sha256);

  // Download all → zip streamed through /vendor/fs-zip-sw.js.
  const [zipDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Download all (.zip)' }).click(),
  ]);
  expect(zipDl.suggestedFilename()).toBe(`${mock.name}.zip`);
  const zip = await readFile(await zipDl.path());
  expect(storedZipHashes(zip)).toEqual(Object.fromEntries(mock.files.map((f) => [f.path, f.sha256])));

  // Reopened: seeding again from browser storage straight away, and Save still works.
  await page.reload();
  await expect(page.getByText('You downloaded these files on an earlier visit.')).toBeVisible({ timeout: 30_000 });
  const again = await hookState(page);
  expect(again.done).toBe(true);
  expect(again.peerBytes + again.webseedBytes).toBe(0);
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: `Save ${target.path}` }).click()]);
  expect(createHash('sha256').update(await readFile(await dl2.path())).digest('hex')).toBe(target.sha256);
});

test('storage check frees stale stores and counts the pieces this share already has', async ({ page }) => {
  // Browser storage holds another share's leftover store and a partial store of this share. With a
  // quota that only fits once the leftover is removed and the partial store is reused, no warning shows.
  const stale = 1024 * 1024;
  const own = 16 * 1024;
  const quota = mock.files.reduce((s, f) => s + f.length, 0) + 64 * 1024 * 1024 + own / 2;
  await page.addInitScript((q) => {
    (window as unknown as { __fileshareTest: object }).__fileshareTest = {};
    const walk = async (dir: FileSystemDirectoryHandle): Promise<number> => {
      let n = 0;
      for await (const h of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        n += h.kind === 'file' ? (await (h as FileSystemFileHandle).getFile()).size : await walk(h as FileSystemDirectoryHandle);
      }
      return n;
    };
    StorageManager.prototype.estimate = async () => ({ quota: q, usage: await walk(await navigator.storage.getDirectory()) });
  }, quota);
  await page.goto(mock.shareUrl);
  await page.getByLabel('Your name').fill('Synthetic Sam');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: mock.name })).toBeVisible();
  await page.evaluate(
    async ({ staleDir, ownDir, stale, own }) => {
      const root = await navigator.storage.getDirectory();
      const put = async (dir: string, size: number): Promise<void> => {
        const f = await (await root.getDirectoryHandle(dir, { create: true })).getFileHandle('0', { create: true });
        const w = await f.createWritable();
        await w.write(new Uint8Array(size));
        await w.close();
      };
      await put(staleDir, stale);
      await put(ownDir, own);
    },
    { staleDir: 'Old share - deadbeef', ownDir: `${mock.name} - ${mock.infoHash.slice(0, 8)}`, stale, own },
  );

  await openBrowserDownload(page);
  await page.getByRole('button', { name: 'Start download' }).click();
  await expect.poll(async () => (await hookState(page)).done, { timeout: 60_000, intervals: [1000] }).toBe(true);
  await expect(page.getByText('Not enough browser storage')).toHaveCount(0);
  const left = await page.evaluate(async () => {
    const names: string[] = [];
    for await (const n of ((await navigator.storage.getDirectory()) as unknown as { keys(): AsyncIterable<string> }).keys()) names.push(n);
    return names;
  });
  expect(left).not.toContain('Old share - deadbeef');
});
