// Recipient page: screens before unlock must reveal nothing; password, rate-limit and revocation states.
import { expect, test } from '@playwright/test';
import { type RecipientMock, startRecipientMock } from '../helpers/recipient-mock.ts';
import { openBrowserDownload } from '../helpers/recipient-page.ts';

test.use({ browserName: 'chromium', launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } });

let mock: RecipientMock;

test.beforeAll(async () => {
  mock = await startRecipientMock({ password: 'synthetic-pass', seed: false, name: 'Secret Synthetic Folder' });
});
test.afterAll(async () => {
  await mock?.close();
});

function sensitiveStrings(m: RecipientMock): string[] {
  return [m.name, ...m.files.flatMap((f) => f.path.split('/'))];
}

test('unknown link shows the neutral gone page and reveals nothing', async ({ page }) => {
  await page.goto(mock.goneUrl);
  await expect(page.getByRole('heading', { name: "This link isn't available" })).toBeVisible();
  const html = await page.content();
  for (const s of sensitiveStrings(mock)) expect(html).not.toContain(s);
  await expect(page.getByLabel('Password')).toHaveCount(0);
});

test('open share asks for a name first and reveals nothing before it', async ({ page }) => {
  const open = await startRecipientMock({ password: null, seed: false, name: 'Open Synthetic Folder' });
  try {
    await page.goto(open.shareUrl);
    await expect(page.getByRole('heading', { name: "What's your name?" })).toBeVisible();
    expect(await page.content()).not.toContain(open.name);
    expect(open.stats.unlockNames).toHaveLength(0);
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await page.getByLabel('Your name').fill('   ');
    await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await page.getByLabel('Your name').fill('Synthetic Sam');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: open.name })).toBeVisible();
    // The torrent app comes first; the in-browser download is collapsed until opened.
    await expect(page.getByRole('link', { name: 'Download .torrent file' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Choose folder and download' })).toBeHidden();
    await page.getByText('Download in your browser', { exact: true }).click();
    await expect(page.getByRole('button', { name: 'Choose folder and download' })).toBeVisible();
    expect(open.stats.unlockNames).toEqual(['Synthetic Sam']);
    // Remembered on this browser: the next visit goes straight to the files.
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.getByRole('heading', { name: open.name })).toBeVisible();
    expect(open.stats.unlockNames).toEqual(['Synthetic Sam', 'Synthetic Sam']);
  } finally {
    await open.close();
  }
});

test('locked share shows only a name and password form; wrong password and rate limit are handled', async ({ page }) => {
  const responses: string[] = [];
  page.on('response', async (r) => {
    if (r.url().includes('/api/s/') && r.request().method() === 'GET') responses.push(await r.text().catch(() => ''));
  });
  await page.goto(mock.shareUrl);
  await expect(page.getByRole('heading', { name: 'Enter your name and the password' })).toBeVisible();
  await page.getByLabel('Your name').fill('Synthetic Sam');
  let html = await page.content();
  for (const s of sensitiveStrings(mock)) expect(html).not.toContain(s);
  for (const body of responses) for (const s of sensitiveStrings(mock)) expect(body).not.toContain(s);
  expect(await page.title()).toBe('fileshare');

  await page.getByLabel('Password').fill('wrong');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('alert')).toContainText("That password isn't right");
  html = await page.content();
  for (const s of sensitiveStrings(mock)) expect(html).not.toContain(s);

  // Exhaust the mock's limit (5 failures) → 429 with retryAfter.
  for (let i = 0; i < 5; i++) {
    await page.getByLabel('Password').fill(`wrong-${i}`);
    await page.getByRole('button', { name: 'Open' }).click();
    await expect(page.getByRole('button', { name: /Open|Checking/ })).toBeVisible();
  }
  await expect(page.getByRole('alert')).toContainText('Too many attempts');
  await expect(page.getByRole('alert')).toContainText(/Try again in \d+ s/);
  await expect(page.getByRole('button', { name: 'Open' })).toBeDisabled();
});

test('token is kept per tab: reload does not re-prompt; never in localStorage or the URL', async ({ page }) => {
  mock.stats.unlockFailures = 0;
  await page.goto(mock.shareUrl);
  await page.getByLabel('Your name').fill('Synthetic Sam');
  await page.getByLabel('Password').fill('synthetic-pass');
  await page.getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: mock.name })).toBeVisible();
  expect(page.url()).not.toContain(mock.token);
  const local = await page.evaluate(() => JSON.stringify(localStorage));
  expect(local).not.toContain(mock.token);
  await page.reload();
  await expect(page.getByRole('heading', { name: mock.name })).toBeVisible();
  await expect(page.getByLabel('Password')).toHaveCount(0);
});

test('revocation mid-download stops and explains', async ({ page }) => {
  test.setTimeout(90_000);
  if (process.env.DEBUG_PAGE) page.on('console', (m) => console.log('[page]', m.type(), m.text()));
  if (process.env.DEBUG_PAGE) page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  // No seeder and a very slow webseed → the download is still running when we revoke.
  const slow = await startRecipientMock({ password: null, seed: false, webseedBps: 20_000 });
  try {
    await page.addInitScript(() => {
      localStorage.setItem('fileshare.nick', 'Synthetic Sam');
      (window as unknown as { __fileshareTest: object }).__fileshareTest = {
        webseedAfterMs: 500,
        pickDirectory: async () => (await navigator.storage.getDirectory()).getDirectoryHandle('revoke-test', { create: true }),
      };
    });
    await page.goto(slow.shareUrl);
    await expect(page.getByRole('heading', { name: slow.name })).toBeVisible();
    await openBrowserDownload(page);
    await page.getByRole('button', { name: 'Choose folder and download' }).click();
    await expect(page.getByRole('heading', { name: 'Downloading' })).toBeVisible();
    await expect.poll(() => slow.stats.webseedBytes, { timeout: 20_000 }).toBeGreaterThan(0);
    slow.revoke();
    await expect(page.getByRole('heading', { name: "This link isn't available any more" })).toBeVisible();
    await expect(page.getByText('the download has stopped')).toBeVisible();
    const state = await page.evaluate(() => sessionStorage.length);
    expect(state).toBe(0);
  } finally {
    await slow.close();
  }
});
