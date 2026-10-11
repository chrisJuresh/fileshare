// Shared steps on the recipient share page (Playwright).
import type { Page } from '@playwright/test';

/** Opens the collapsed "Download in your browser" section (no-op when it is already open). */
export async function openBrowserDownload(page: Page): Promise<void> {
  await page.locator('details.browser-dl').evaluate((el) => {
    (el as HTMLDetailsElement).open = true;
  });
}
