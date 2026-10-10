import { createContext } from './bootstrap.js';
import { ensureDirs } from './core/dirs.js';
import { createIngest } from './ingest/index.js';
import { createP2P } from './p2p/index.js';
import { buildAdminServer } from './server/admin.js';
import { buildPublicServer } from './server/public.js';

const ctx = createContext('app');
const { config, log } = ctx;

// Before any service: the seeder resolves the library's realpath at start, ingest scans the outbox.
await ensureDirs(config.paths);

const p2p = createP2P(ctx);
const ingest = createIngest(ctx, { p2p });

const publicApp = await buildPublicServer(ctx, p2p);
const adminApp = await buildAdminServer(ctx, { ingest, p2p });

await p2p.start();
await ingest.start();
await publicApp.listen({ host: config.env.PUBLIC_BIND, port: config.env.PUBLIC_PORT });
await adminApp.listen({ host: config.env.ADMIN_BIND, port: config.env.ADMIN_PORT });
log.info({ public: `${config.env.PUBLIC_BIND}:${config.env.PUBLIC_PORT}`, admin: `${config.env.ADMIN_BIND}:${config.env.ADMIN_PORT}` }, 'listening');

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, 'shutting down');
  const hard = setTimeout(() => process.exit(1), 15_000);
  hard.unref();
  await Promise.allSettled([publicApp.close(), adminApp.close()]);
  await Promise.allSettled([ingest.stop(), p2p.stop()]);
  ctx.db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
