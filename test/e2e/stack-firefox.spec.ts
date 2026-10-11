// Real app, Firefox path (no showDirectoryPicker): unlock, download into browser storage, then
// per-file "Save" (WebTorrent service worker) and "Download all" (streamed zip). Hashes must match.
import { expect, test, type Page } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { storedZipHashes } from '../helpers/recipient-zip.ts';
import { createShare, seedItem } from '../helpers/stack.ts';

test.use({ acceptDownloads: true });
test.setTimeout(180_000);

type HookState = { done: boolean; saveMode: string; peerBytes: number; webseedBytes: number; error: string | null };
const hookState = (page: Page): Promise<HookState> =>
  page.evaluate(() => (window as unknown as { __fileshareTest: { state: () => HookState } }).__fileshareTest.state());

test('Firefox: per-file save and streamed zip from the real app', async ({ page }) => {
  const tag = randomBytes(4).toString('hex');
  const item = await seedItem(`firefox-${tag}`, [
    { path: 'clip one.bin', size: 6 * 1024 * 1024 + 3 },
    { path: 'nested/a/b/deep.bin', size: 2 * 1024 * 1024 },
    { path: 'nested/readme.txt', size: 1500 },
  ]);
  const password = `pw-${tag}`;
  const share = await createShare(item.id, { password });

  await page.addInitScript(() => {
    (window as unknown as { __fileshareTest: object }).__fileshareTest = {};
  });
  if (process.env.DEBUG_PAGE) page.on('console', (m) => console.log('[page]', m.type(), m.text()));
  await page.goto(share.url);
  await page.getByLabel('Your name').fill('Synthetic Sam');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: item.name })).toBeVisible();
  expect((await hookState(page)).saveMode).toBe('serviceworker');

  await page.getByRole('button', { name: 'Start download' }).click();
  await expect.poll(async () => (await hookState(page)).done, { timeout: 120_000, intervals: [1000] }).toBe(true);
  const st = await hookState(page);
  expect(st.error).toBeNull();
  console.log(`[firefox] peer bytes ${st.peerBytes}, webseed bytes ${st.webseedBytes}`);
  expect(st.peerBytes + st.webseedBytes).toBeGreaterThanOrEqual(item.totalBytes);

  for (const f of item.files) {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: `Save ${f.path}` }).click()]);
    expect(dl.suggestedFilename()).toBe(f.path.split('/').pop());
    expect(createHash('sha256').update(await readFile(await dl.path())).digest('hex')).toBe(f.sha256);
  }

  const [zipDl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByRole('button', { name: 'Download all (.zip)' }).click(),
  ]);
  expect(zipDl.suggestedFilename()).toBe(`${item.name}.zip`);
  expect(storedZipHashes(await readFile(await zipDl.path()))).toEqual(Object.fromEntries(item.files.map((f) => [f.path, f.sha256])));
});
