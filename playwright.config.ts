// Playwright: recipient-page specs (against test/helpers/recipient-mock.ts) and end-to-end specs
// against the real app (scripts/test-stack.sh, started by the `stack` setup project).
//
//   npx playwright test                                  default suite (no @big tests)
//   FILESHARE_BIG=1 npx playwright test --grep @big      the big 6-peer run (FILESHARE_BIG_SIZE, default 10G)
//
// Large data, browser profiles and temp files go under FILESHARE_SCRATCH (default
// /srv/fileshare-scratch), never into the repo or /tmp.
import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const scratch = process.env.FILESHARE_SCRATCH ?? '/srv/fileshare-scratch';
const tmp = path.join(scratch, 'tmp');
try {
  mkdirSync(tmp, { recursive: true });
  // Browsers' temporary profiles and downloads follow TMPDIR.
  process.env.TMPDIR = tmp;
} catch {
  /* scratch not available: keep the default temp dir */
}

export default defineConfig({
  testDir: 'test/e2e',
  outputDir: path.join(scratch, 'playwright-results'),
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // One shared app stack; tests change global settings (upload cap), so run them one at a time.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  grepInvert: process.env.FILESHARE_BIG ? undefined : /@big/,
  use: { trace: 'off', video: 'off', screenshot: 'off' },
  projects: [
    { name: 'stack', testMatch: /stack\.setup\.ts$/, teardown: 'stack-teardown' },
    { name: 'stack-teardown', testMatch: /stack\.teardown\.ts$/ },
    {
      name: 'chromium',
      testIgnore: /firefox/,
      dependencies: ['stack'],
      use: { browserName: 'chromium', launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } },
    },
    {
      name: 'firefox',
      testMatch: /firefox\.spec\.ts$/,
      dependencies: ['stack'],
      use: { browserName: 'firefox', launchOptions: { firefoxUserPrefs: { 'media.peerconnection.ice.obfuscate_host_addresses': false } } },
    },
  ],
});
