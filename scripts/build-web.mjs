// Bundles the two frontends with esbuild and copies WebTorrent's prebuilt ESM bundle + service worker.
// Output: dist/web/recipient/{index.html,assets/*,vendor/*}, dist/web/admin/{index.html,assets/*}
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'dist', 'web');
const watch = process.argv.includes('--dev');

rmSync(out, { recursive: true, force: true });

const common = {
  bundle: true,
  format: 'esm',
  target: ['chrome120', 'firefox120', 'safari17'],
  sourcemap: true,
  minify: !watch,
  jsx: 'automatic',
  jsxImportSource: 'preact',
  logLevel: 'info',
  legalComments: 'none',
};

for (const app of ['recipient', 'admin']) {
  const dir = path.join(out, app);
  mkdirSync(path.join(dir, 'assets'), { recursive: true });
  await build({
    ...common,
    entryPoints: { app: path.join(root, 'web', app, 'main.tsx') },
    outdir: path.join(dir, 'assets'),
    // WebTorrent is loaded at runtime from /vendor/webtorrent.min.js (its own ESM bundle).
    external: ['/vendor/*'],
    loader: { '.css': 'css' },
  });
  cpSync(path.join(root, 'web', app, 'index.html'), path.join(dir, 'index.html'));
}

const vendor = path.join(out, 'recipient', 'vendor');
mkdirSync(vendor, { recursive: true });
const wt = path.join(root, 'node_modules', 'webtorrent', 'dist');
cpSync(path.join(wt, 'webtorrent.min.js'), path.join(vendor, 'webtorrent.min.js'));
cpSync(path.join(wt, 'sw.min.js'), path.join(vendor, 'sw.min.js'));

// Recipient "Download all" zip service worker (classic script). Served as /vendor/fs-zip-sw.js and
// registered with scope /vendor/fszip/, so it needs no Service-Worker-Allowed header.
await build({
  ...common,
  format: 'iife',
  entryPoints: [path.join(root, 'web', 'recipient', 'zip-sw.ts')],
  outfile: path.join(vendor, 'fs-zip-sw.js'),
});
