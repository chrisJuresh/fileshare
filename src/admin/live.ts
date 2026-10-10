// Admin live stream: GET (WS) /api/admin/live (docs/ARCHITECTURE.md §8). Auth is the Access guard,
// which also runs on the upgrade request.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { AdminLiveMsg } from '../types.js';
import { listItemRows } from './dto.js';
import type { AdminDeps } from './index.js';
import { effectiveCapBps } from './settings.js';

export const LIVE_INTERVAL_MS = 2000;

export function buildLiveMsg(ctx: AppContext, deps: AdminDeps): AdminLiveMsg {
  const progress = deps.ingest.progress();
  return {
    t: 'live',
    upload: { capBps: effectiveCapBps(ctx.db), currentBps: deps.p2p.limiter.currentBps() },
    shares: deps.p2p.allSwarms(),
    items: listItemRows(ctx.db).map((r) => {
      const p = progress[r.id];
      return { id: r.id, status: r.status, progress: typeof p === 'number' && Number.isFinite(p) ? p : null };
    }),
  };
}

export async function liveRoute(api: FastifyInstance, ctx: AppContext, deps: AdminDeps): Promise<void> {
  api.get('/live', { websocket: true }, (socket, req) => {
    const send = (): void => {
      if (socket.readyState !== socket.OPEN) return;
      try {
        socket.send(JSON.stringify(buildLiveMsg(ctx, deps)));
      } catch (err) {
        req.log.warn({ err: { message: (err as Error).message } }, 'admin live: send failed');
      }
    };
    const timer = setInterval(send, LIVE_INTERVAL_MS);
    send();
    // The stream is server → client only; anything the client sends is ignored.
    socket.on('message', () => undefined);
    socket.on('close', () => clearInterval(timer));
    socket.on('error', () => clearInterval(timer));
  });
}
