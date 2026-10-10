// Public share API (docs/ARCHITECTURE.md §7.1, §7.3):
//   GET  /api/s/:shareId           status (unknown / revoked / expired are all `gone`)
//   POST /api/s/:shareId/unlock    password check (argon2 verify only) → UnlockResponse
//   GET  /api/s/:shareId/torrent   .torrent for a valid token
// All URLs come from PUBLIC_BASE_URL. Client IPs are used in memory for rate limiting only.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import type { ShareStatusResponse, UnlockResponse } from '../types.js';
import { buildMagnet, buildTorrentFile, shareUrls, torrentContentDisposition } from './metainfo.js';
import { Semaphore, UnlockRateLimiter } from './ratelimit.js';
import { shareState, type ShareStore } from './shares.js';

export interface PublicRouteDeps {
  shares: ShareStore;
  unlockLimiter: UnlockRateLimiter;
}

const gone = (reply: FastifyReply) => reply.code(404).send({ error: 'gone' });

export async function registerShareApi(app: FastifyInstance, ctx: AppContext, deps: PublicRouteDeps): Promise<void> {
  const { shares, unlockLimiter } = deps;
  const argonGate = new Semaphore(4, 64);

  app.get<{ Params: { shareId: string } }>('/api/s/:shareId', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const row = shares.getRow(req.params.shareId);
    let body: ShareStatusResponse;
    if (!row || shareState(row, Date.now()) !== 'active') body = { status: 'gone', passwordRequired: false };
    else body = { status: row.password_hash ? 'locked' : 'open', passwordRequired: row.password_hash !== null };
    return reply.send(body);
  });

  app.post<{ Params: { shareId: string }; Body: unknown }>(
    '/api/s/:shareId/unlock',
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      const b = req.body as { password?: unknown } | undefined | null;
      if (b !== undefined && b !== null && (typeof b !== 'object' || Array.isArray(b))) return reply.code(400).send({ error: 'bad_request' });
      const pw = b?.password;
      if (pw !== undefined && (typeof pw !== 'string' || pw.length > 1024)) return reply.code(400).send({ error: 'bad_request' });
      const row = shares.getRow(req.params.shareId);
      if (!row || shareState(row, Date.now()) !== 'active') return gone(reply);

      if (row.password_hash !== null) {
        const ip = req.ip || 'unknown';
        const lim = unlockLimiter.check(row.id, ip);
        if (!lim.ok) {
          return reply.code(429).header('Retry-After', String(lim.retryAfter)).send({ error: 'rate_limited', retryAfter: lim.retryAfter });
        }
        // Count the attempt as a failure up front, synchronously with the check (no await in between),
        // so parallel guesses can't race past the limiter. Undone below on success.
        const undo = unlockLimiter.recordFailure(row.id, ip);
        const release = await argonGate.acquire();
        if (!release) {
          undo();
          return reply.code(429).header('Retry-After', '1').send({ error: 'rate_limited', retryAfter: 1 });
        }
        let ok: boolean;
        try {
          // Always run argon2 verify (also for a missing password) so failures take the same time.
          ok = await shares.verifyPassword(row.password_hash, typeof pw === 'string' ? pw : '');
        } finally {
          release();
        }
        if (!ok) {
          shares.event(row.id, 'unlock_failed');
          return reply.code(401).send({ error: 'bad_password' });
        }
        undo();
      }

      // Re-read: the share may have changed while we were hashing.
      const cur = shares.getRow(row.id);
      if (!cur || shareState(cur, Date.now()) !== 'active' || cur.token_version !== row.token_version) return gone(reply);
      shares.event(cur.id, 'unlocked');
      const token = shares.token(cur);
      const urls = shareUrls(ctx.config, cur.id, token);
      const info = shares.info(cur);
      const body: UnlockResponse = {
        token,
        infoHash: cur.info_hash,
        name: cur.torrent_name,
        totalBytes: info.totalBytes,
        pieceLength: info.pieceLength,
        files: info.files.map((f) => ({ path: f.path, length: f.length })),
        torrentUrl: urls.torrent,
        magnet: buildMagnet(cur.info_hash, cur.torrent_name, urls),
        announce: { ws: urls.trackerWs, http: urls.trackerHttp },
        webseed: urls.webseed,
        iceServers: ctx.config.stunUrls.map((urls) => ({ urls })),
        expiresAt: cur.expires_at,
      };
      return reply.send(body);
    },
  );

  app.get<{ Params: { shareId: string }; Querystring: { t?: string } }>('/api/s/:shareId/torrent', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const t = typeof req.query.t === 'string' ? req.query.t : '';
    const auth = shares.authorize(t);
    if (!auth.ok || auth.share.id !== req.params.shareId) return gone(reply);
    const share = auth.share;
    const urls = shareUrls(ctx.config, share.id, t);
    const buf = buildTorrentFile(share.info, urls);
    return reply
      .header('Content-Type', 'application/x-bittorrent')
      .header('Content-Disposition', torrentContentDisposition(share.torrent_name))
      .send(buf);
  });
}
