// Recipient page, Firefox path (no showDirectoryPicker): download into browser storage, then per-file
// "Save" through WebTorrent's service worker (file.streamURL) and "Download all" as a streamed zip.
import { type Page, expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { type RecipientMock, startRecipientMock } from '../helpers/recipient-mock.ts';
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
  // No password on this share: the page unlocks by itself.
  await expect(page.getByRole('heading', { name: mock.name })).toBeVisible();
  expect((await hookState(page)).saveMode).toBe('serviceworker');

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
});
