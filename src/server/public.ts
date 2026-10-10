// Public listener: share pages, /api/s, tracker, webseed, stats WS. NEVER register admin routes here.
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import path from 'node:path';
import type { AppContext } from '../context.js';
import { redactUrl } from '../log.js';
import type { P2PService } from '../p2p/index.js';
import { publicSecurityHeaders } from './headers.js';
import { QuietLogController } from './log-controller.js';

export async function buildPublicServer(ctx: AppContext, p2p: P2PService): Promise<FastifyInstance> {
  const { config, log } = ctx;
  const app = Fastify({
    loggerInstance: log.child({ listener: 'public' }) as FastifyBaseLogger,
    // No built-in request lines (full URL + client IP); the onResponse hook below logs a redacted URL.
    logController: new QuietLogController(),
    trustProxy: config.env.TRUST_PROXY ? ['127.0.0.1', '::1'] : false,
    bodyLimit: 64 * 1024,
    routerOptions: { maxParamLength: 300 },
  });

  app.addHook('onRequest', async (_req, reply) => {
    publicSecurityHeaders(reply, config.publicHost);
  });
  app.addHook('onResponse', async (req, reply) => {
    // Unmatched paths are arbitrary client input (could carry a share id): don't echo them.
    const url = req.routeOptions.url === undefined ? '[unmatched]' : redactUrl(req.url);
    req.log.info({ method: req.method, url, status: reply.statusCode, ms: Math.round(reply.elapsedTime) }, 'req');
  });

  await app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });

  const webRoot = path.join(config.paths.web, 'recipient');
  await app.register(fastifyStatic, { root: path.join(webRoot, 'assets'), prefix: '/assets/', serve: true, index: false, maxAge: '7d', immutable: true, wildcard: true, decorateReply: true });
  await app.register(fastifyStatic, { root: path.join(webRoot, 'vendor'), prefix: '/vendor/', index: false, maxAge: '1d', decorateReply: false });

  app.get('/healthz', async () => ({ ok: true }));

  app.get('/sw.min.js', async (_req, reply) => {
    reply.header('Service-Worker-Allowed', '/').header('Cache-Control', 'no-cache');
    return reply.sendFile('sw.min.js', path.join(webRoot, 'vendor'));
  });

  // Constant shell for every id: reveals nothing until unlock.
  app.get('/s/:shareId', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return reply.sendFile('index.html', webRoot);
  });

  await p2p.registerPublicRoutes(app);

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  return app;
}
