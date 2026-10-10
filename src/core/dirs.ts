// Directories the app needs before any service starts (docs/ARCHITECTURE.md §2). Created with
// mode 0750 if missing; existing directories are left as they are.
import type { Config } from '../config.js';
import { mkdirp0750 } from '../ingest/placement.js';

export function requiredDirs(paths: Config['paths']): string[] {
  return [paths.library, paths.outbox, paths.staging, paths.uploads, paths.seedlinks];
}

/** Create every required directory (mkdir -p, 0750). Call once at startup, before p2p/ingest start. */
export async function ensureDirs(paths: Config['paths']): Promise<void> {
  for (const d of requiredDirs(paths)) await mkdirp0750(d);
}
