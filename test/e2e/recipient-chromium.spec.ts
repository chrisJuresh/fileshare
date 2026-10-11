// Recipient page, Chromium path: unlock, untick a file, "Choose folder and download" (picker replaced by an
// OPFS directory through the test hook), then verify the written files' hashes.
import { type Page, expect, test } from '@playwright/test';
import { type RecipientMock, startRecipientMock } from '../helpers/recipient-mock.ts';

test.use({ browserName: 'chromium', launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } });
test.setTimeout(120_000);

const OUT_DIR = 'fileshare-e2e';

async function installHook(page: Page, extra: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript(
    ({ dir, extra }) => {
      (window as unknown as { __fileshareTest: object }).__fileshareTest = {
        ...extra,
        pickDirectory: async () => (await navigator.storage.getDirectory()).getDirectoryHandle(dir, { create: true }),
      };
    },
    { dir: OUT_DIR, extra },
  );
  if (process.env.DEBUG_PAGE) {
    page.on('console', (m) => console.log('[page]', m.type(), m.text()));
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  }
}

/** sha256 of every file under OPFS:/fileshare-e2e, keyed by path relative to that folder. */
async function opfsHashes(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async (dir) => {
    const out: Record<string, string> = {};
    const walk = async (h: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const [name, child] of (h as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const p = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'directory') await walk(child as FileSystemDirectoryHandle, p);
        else {
          const buf = await (await (child as FileSystemFileHandle).getFile()).arrayBuffer();
          const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
          out[p] = Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
        }
      }
    };
    await walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(dir), '');
    return out;
  }, OUT_DIR);
}

type HookState = { saved: boolean; done: boolean; peerBytes: number; webseedBytes: number; error: string | null; liveConnected: boolean };
const hookState = (page: Page): Promise<HookState> =>
  page.evaluate(() => (window as unknown as { __fileshareTest: { state: () => HookState } }).__fileshareTest.state());

async function unlockAndDownload(page: Page, mock: RecipientMock, untick: string | null): Promise<void> {
  await page.goto(mock.shareUrl);
  if (mock.password) {
    await page.getByLabel('Password').fill(mock.password);
    await page.getByRole('button', { name: 'Open' }).click();
  }
  await expect(page.getByRole('heading', { name: mock.name })).toBeVisible();
  if (untick) {
    const box = page.getByRole('checkbox', { name: untick, exact: true });
    await expect(box).toBeChecked();
    await box.uncheck();
    // The parent folder becomes partly selected.
    const folder = untick.split('/').slice(0, -1).join('/');
    if (folder) {
      expect(await page.getByRole('checkbox', { name: `Folder ${folder}`, exact: true }).evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
    }
  }
  await page.getByRole('button', { name: 'Choose folder and download' }).click();
}

test.describe('P2P from the seeder', () => {
  let mock: RecipientMock;
  test.beforeAll(async () => {
    mock = await startRecipientMock({ password: 'synthetic-pass' });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test('unlock, untick one file, download the rest into the picked folder', async ({ page }) => {
    await installHook(page);
    const skipped = 'docs/b.bin';
    await unlockAndDownload(page, mock, skipped);

    const t0 = Date.now();
    await expect
      .poll(
        async () => {
          const s = await hookState(page);
          if (process.env.DEBUG_PAGE) console.log(Date.now() - t0, JSON.stringify(s));
          return s.saved;
        },
        { timeout: 60_000, intervals: [500] },
      )
      .toBe(true);
    const st = await hookState(page);
    expect(st.error).toBeNull();
    expect(st.done).toBe(true);
    expect(st.peerBytes).toBeGreaterThan(0); // came over WebRTC from the Node seeder
    expect(st.webseedBytes).toBe(0);

    const hashes = await opfsHashes(page);
    const expected = Object.fromEntries(mock.files.filter((f) => f.path !== skipped).map((f) => [`${mock.name}/${f.path}`, f.sha256]));
    expect(hashes).toEqual(expected);

    await expect(page.getByRole('heading', { name: 'All done' })).toBeVisible();
    await expect(page.getByText('Everything is saved in the folder you chose.')).toBeVisible();
    await expect(page.getByText(/You've shared .* with friends/)).toBeVisible();
    // Live table shows us.
    await expect(page.locator('table.swarm tr.you')).toBeVisible();
    await expect.poll(() => mock.stats.live.some((c) => c.stats?.done === true && c.stats.progress === 1)).toBe(true);

    // Nickname goes to the live socket and is remembered in localStorage (not the token).
    await page.getByLabel('Nickname (optional, up to 24 characters)').fill('Synthetic Sam');
    await page.getByRole('button', { name: 'Set' }).click();
    await expect.poll(() => mock.stats.live.map((c) => c.nick)).toContain('Synthetic Sam');
    await expect(page.locator('table.swarm tr.you')).toContainText('Synthetic Sam');
    expect(await page.evaluate(() => localStorage.getItem('fileshare.nick'))).toBe('Synthetic Sam');
  });

  test('reopening the link after a finished download seeds it again without a click', async ({ page }) => {
    await installHook(page);
    await unlockAndDownload(page, mock, null);
    await expect.poll(async () => (await hookState(page)).saved, { timeout: 60_000, intervals: [500] }).toBe(true);

    // Same tab (the unlock is kept in sessionStorage): straight back to seeding from the stored pieces.
    await page.reload();
    await expect(page.getByText('You downloaded these files on an earlier visit.')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole('heading', { name: 'All done' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose folder and download' })).toHaveCount(0);
    const st = await hookState(page);
    expect(st.done).toBe(true);
    expect(st.peerBytes + st.webseedBytes).toBe(0); // nothing fetched again
    await expect.poll(() => mock.stats.live.some((c) => c.stats?.done === true && c.stats.resumed === true)).toBe(true);

    // Pieces gone (e.g. browser storage cleared): the normal screen, and nothing downloads by itself.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of (root as unknown as { keys(): AsyncIterable<string> }).keys()) {
        if (/ - [0-9a-f]{8}$/.test(name)) await root.removeEntry(name, { recursive: true });
      }
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Choose folder and download' })).toBeEnabled();
    expect((await hookState(page)).done).toBe(false);
    expect(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('fileshare.seeding.')))).toEqual([]);
  });
});

test.describe('webseed fallback (no seeder)', () => {
  let mock: RecipientMock;
  test.beforeAll(async () => {
    mock = await startRecipientMock({ password: null, seed: false });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test('falls back to the webseed after the no-peer-data delay', async ({ page }) => {
    await installHook(page, { webseedAfterMs: 2_000 });
    await unlockAndDownload(page, mock, null);
    await expect.poll(async () => (await hookState(page)).saved, { timeout: 60_000 }).toBe(true);
    const st = await hookState(page);
    expect(st.webseedBytes).toBeGreaterThan(0);
    expect(st.peerBytes).toBe(0);
    const hashes = await opfsHashes(page);
    expect(hashes).toEqual(Object.fromEntries(mock.files.map((f) => [`${mock.name}/${f.path}`, f.sha256])));
  });
});

test.describe('single-file item', () => {
  let mock: RecipientMock;
  test.beforeAll(async () => {
    mock = await startRecipientMock({ password: null, seed: false, name: 'lonely.bin', files: [{ path: 'lonely.bin', size: 400_000 }] });
  });
  test.afterAll(async () => {
    await mock?.close();
  });

  test('saves the single file straight into the folder (webseed URL without a trailing path)', async ({ page }) => {
    await installHook(page, { webseedAfterMs: 0 });
    await unlockAndDownload(page, mock, null);
    await expect.poll(async () => (await hookState(page)).saved, { timeout: 60_000 }).toBe(true);
    expect(await opfsHashes(page)).toEqual({ 'lonely.bin': mock.files[0]!.sha256 });
  });
});
