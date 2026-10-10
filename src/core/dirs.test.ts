import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { ensureDirs, requiredDirs } from './dirs.js';

describe('ensureDirs', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('creates library, outbox, staging, uploads and seedlinks with mode 0750', async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'fileshare-dirs-'));
    const config = loadConfig({
      NODE_ENV: 'test',
      PUBLIC_BASE_URL: 'https://files.example.test',
      ADMIN_BASE_URL: 'https://admin.example.test',
      DATA_DIR: path.join(root, 'data'),
      STATE_DIR: path.join(root, 'state'),
    });
    await ensureDirs(config.paths);
    await ensureDirs(config.paths); // idempotent
    const dirs = requiredDirs(config.paths);
    expect(dirs).toHaveLength(5);
    for (const d of dirs) {
      const st = statSync(d);
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o777).toBe(0o750);
    }
  });
});
