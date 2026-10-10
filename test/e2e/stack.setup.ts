// Starts the real-app test stack (scripts/test-stack.sh) unless one is already running.
// FILESHARE_SYNCTHING=fake uses the fake Syncthing (no Docker needed for it).
import { test as setup } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { STACK_JSON } from '../helpers/stack.ts';

const repo = path.resolve(import.meta.dirname, '..', '..');

async function healthy(): Promise<boolean> {
  if (!existsSync(STACK_JSON)) return false;
  try {
    const { publicUrl } = JSON.parse(readFileSync(STACK_JSON, 'utf8')) as { publicUrl: string };
    return (await fetch(`${publicUrl}/healthz`, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}

setup('start the test stack', async () => {
  setup.setTimeout(600_000);
  if (await healthy()) return; // reuse a stack started by hand
  const args = ['start', '--syncthing', process.env.FILESHARE_SYNCTHING ?? 'real'];
  execFileSync(path.join(repo, 'scripts', 'test-stack.sh'), args, { stdio: 'inherit' });
  writeFileSync(path.join(path.dirname(STACK_JSON), 'started-by-playwright'), String(Date.now()));
});
