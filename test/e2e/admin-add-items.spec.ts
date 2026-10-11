// Admin dashboard: drag library items onto a folder row or a share row (§4 "add items"), and the
// keyboard path ("Add from library"). Serves the built dashboard (dist/web/admin) with a mocked
// /api/admin, so no stack is needed:
//   npx playwright test --project chromium --no-deps test/e2e/admin-add-items.spec.ts
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ItemDto, ShareDto } from '../../src/types.ts';

const ORIGIN = 'http://admin.test';
const webRoot = path.resolve(import.meta.dirname, '..', '..', 'dist', 'web', 'admin');
const now = Date.now();

const item = (id: string, name: string, kind: 'file' | 'dir', activeShares = 0): ItemDto => ({
  id,
  name,
  kind,
  source: 'upload',
  status: 'ready',
  error: null,
  totalBytes: 1234,
  fileCount: kind === 'dir' ? 2 : 1,
  createdAt: now,
  readyAt: now,
  progress: null,
  activeShares,
});

const ITEMS = [item('folder', 'Synthetic Folder', 'dir', 1), item('one', 'one.bin', 'file'), item('two', 'two.bin', 'file', 1)];
const SHARE: ShareDto = {
  id: 'share1',
  itemId: 'folder',
  itemName: 'Synthetic Folder',
  torrentName: 'Synthetic Folder',
  infoHash: 'a'.repeat(40),
  url: 'https://share.example.test/s/share1',
  hasPassword: false,
  expiresAt: null,
  revokedAt: null,
  createdAt: now,
  state: 'active',
  stats: { serverBytesWebseed: 0, serverBytesP2p: 0, peerBytes: 0, completedDownloads: 0, peakSwarm: 0, lastActivityAt: null },
};

/** Serve the dashboard + a mocked API; returns the add-items requests it received. */
async function serve(page: Page): Promise<{ target: string; itemIds: string[] }[]> {
  const calls: { target: string; itemIds: string[] }[] = [];
  await page.route(`${ORIGIN}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/admin/items') return json(ITEMS);
    if (url.pathname === '/api/admin/shares') return json([SHARE]);
    const add = /^\/api\/admin\/items\/([^/]+)\/add-items$/.exec(url.pathname);
    if (add && req.method() === 'POST') {
      const { itemIds } = req.postDataJSON() as { itemIds: string[] };
      calls.push({ target: add[1]!, itemIds });
      return json({ removed: itemIds.filter((i) => i !== 'two'), kept: itemIds.filter((i) => i === 'two') });
    }
    if (url.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const abs = path.join(webRoot, file);
    if (!abs.startsWith(webRoot + path.sep)) return route.fulfill({ status: 404 });
    try {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ status: 200, contentType: type, body: await readFile(abs) });
    } catch {
      return route.fulfill({ status: 404 });
    }
  });
  await page.goto(`${ORIGIN}/`);
  await expect(page.getByRole('cell', { name: 'one.bin', exact: true })).toBeVisible();
  return calls;
}

const row = (page: Page, name: string) => page.locator('#panel-library tbody tr', { hasText: name });

test('drag a library item onto a folder row', async ({ page }) => {
  const calls = await serve(page);
  await row(page, 'one.bin').dragTo(row(page, 'Synthetic Folder'));
  const dialog = page.getByRole('dialog', { name: 'Add to “Synthetic Folder”' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox', { name: /one\.bin/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /two\.bin/ })).not.toBeChecked();
  await expect(dialog).toContainText('leave the library as separate items');
  // Ticking an item with its own link explains that it stays.
  await dialog.getByRole('checkbox', { name: /two\.bin/ }).check();
  await expect(dialog).toContainText('“two.bin” has a link of its own');
  await dialog.getByRole('button', { name: 'Add 2 items' }).click();
  await expect(dialog).toBeHidden();
  expect(calls).toEqual([{ target: 'folder', itemIds: ['one', 'two'] }]);
  await expect(page.getByText(/Adding 2 items to “Synthetic Folder”.*“two\.bin” also stays/)).toBeVisible();
});

test('dropping a folder onto itself or onto a file does nothing', async ({ page }) => {
  await serve(page);
  await row(page, 'Synthetic Folder').dragTo(row(page, 'Synthetic Folder'), { targetPosition: { x: 5, y: 5 } });
  await row(page, 'Synthetic Folder').dragTo(row(page, 'one.bin'));
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('drag a library item over the Shares tab and onto a share row', async ({ page }) => {
  const calls = await serve(page);
  await row(page, 'one.bin').hover();
  await page.mouse.down();
  const tab = await page.getByRole('tab', { name: /Shares/ }).boundingBox();
  await page.mouse.move(tab!.x + tab!.width / 2, tab!.y + tab!.height / 2, { steps: 5 });
  const shareRow = page.locator('#panel-shares tbody tr', { hasText: 'Synthetic Folder' });
  await expect(shareRow).toBeVisible();
  const box = await shareRow.boundingBox();
  await page.mouse.move(box!.x + 40, box!.y + box!.height / 2, { steps: 5 });
  await page.mouse.up();
  const dialog = page.getByRole('dialog', { name: 'Add to “Synthetic Folder”' });
  await expect(dialog.getByRole('checkbox', { name: /one\.bin/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Add 1 item' }).click();
  expect(calls).toEqual([{ target: 'folder', itemIds: ['one'] }]);
});

test('keyboard: "Add from library" on a share row', async ({ page }) => {
  const calls = await serve(page);
  await page.getByRole('tab', { name: /Shares/ }).click();
  await page.getByRole('button', { name: 'Add library items to Synthetic Folder' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add to “Synthetic Folder”' });
  await expect(dialog.getByRole('button', { name: 'Add', exact: true })).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /one\.bin/ }).press('Space');
  await dialog.getByRole('button', { name: 'Add 1 item' }).press('Enter');
  await expect(dialog).toBeHidden();
  expect(calls).toEqual([{ target: 'folder', itemIds: ['one'] }]);
});
