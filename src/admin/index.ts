// OWNER: admin builder. Contract: docs/ARCHITECTURE.md §7.2, §8, §13.
import type { FastifyInstance } from 'fastify';
import type { JWTVerifyGetKey } from 'jose';
import type { AppContext } from '../context.js';
import type { IngestService } from '../ingest/index.js';
import type { P2PService } from '../p2p/index.js';
import { createAccessHook } from './access.js';
import { liveRoute } from './live.js';
import { adminRoutes } from './routes.js';
import { SettingsWatcher } from './settings-watch.js';

export interface AdminDeps {
  ingest: IngestService;
  p2p: P2PService;
}

export interface AdminApiOptions {
  /** Test hook: a key source to use instead of fetching the Access JWKS. */
  accessKeys?: JWTVerifyGetKey;
  /** Poll interval for cross-process settings changes (ms). 0 disables the watcher. */
  settingsPollMs?: number;
}

/** Registers the Access-JWT guard, /api/admin/* routes and the admin live WebSocket. */
export async function registerAdminApi(
  app: FastifyInstance,
  ctx: AppContext,
  deps: AdminDeps,
  opts: AdminApiOptions = {},
): Promise<void> {
  // The guard goes on the ROOT instance so it covers everything registered on the admin listener:
  // these routes, ingest's tus/batch routes, the static dashboard and WebSocket upgrades.
  app.decorateRequest('adminEmail', undefined);
  app.addHook('onRequest', createAccessHook(ctx.config, ctx.log, opts.accessKeys));

  const watcher = new SettingsWatcher(ctx.db, ctx.events);
  const pollMs = opts.settingsPollMs ?? 3000;
  if (pollMs > 0) watcher.start(pollMs);
  app.addHook('onClose', async () => watcher.stop());

  await app.register(
    async (api) => {
      await adminRoutes(api, ctx, deps, { onSettingsWritten: (key) => watcher.markSeen(key) });
      await liveRoute(api, ctx, deps);
    },
    { prefix: '/api/admin' },
  );
}
