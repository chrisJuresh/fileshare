// Stops the test stack if the setup project started it (FILESHARE_KEEP_STACK=1 keeps it running).
import { test as teardown } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { STACK_JSON } from '../helpers/stack.ts';

teardown('stop the test stack', async () => {
  teardown.setTimeout(300_000);
  const marker = path.join(path.dirname(STACK_JSON), 'started-by-playwright');
  if (!existsSync(marker) || process.env.FILESHARE_KEEP_STACK) return;
  rmSync(marker);
  execFileSync(path.resolve(import.meta.dirname, '..', '..', 'scripts', 'test-stack.sh'), ['stop'], { stdio: 'inherit' });
});
