// Admin listener: dashboard, admin API, tus uploads, admin live WS. Reachable only via cloudflared.
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import path from 'node:path';
import { registerAdminApi } from '../admin/index.js';
import type { AppContext } from '../context.js';
import type { IngestService } from '../ingest/index.js';
import type { P2PService } from '../p2p/index.js';
import { adminSecurityHeaders } from './headers.js';

export async function buildAdminServer(
  ctx: AppContext,
  deps: { ingest: IngestService; p2p: P2PService },
): Promise<FastifyInstance> {
  const { config, log } = ctx;
  const app = Fastify({
    loggerInstance: log.child({ listener: 'admin' }) as FastifyBaseLogger,
    disableRequestLogging: true,
    trustProxy: false,
    bodyLimit: 1024 * 1024,
  });

  app.addHook('onRequest', async (_req, reply) => adminSecurityHeaders(reply));
  app.addHook('onResponse', async (req, reply) => {
    req.log.info({ method: req.method, url: req.url.split('?')[0], status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'req');
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  app.get('/healthz', async () => ({ ok: true }));

  // Auth guard (registered by admin module) applies to everything below, including static files.
  await registerAdminApi(app, ctx, deps);
  await deps.ingest.registerAdminRoutes(app);

  await app.register(fastifyStatic, { root: path.join(config.paths.web, 'admin'), prefix: '/', index: ['index.html'], wildcard: true });
  return app;
}
