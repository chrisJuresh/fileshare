// Public share API (docs/ARCHITECTURE.md §7.1, §7.3):
//   GET  /api/s/:shareId           status (unknown / revoked / expired are all `gone`)
//   POST /api/s/:shareId/unlock    password check (argon2 verify only) → UnlockResponse; records the
//                                  recipient's self-chosen name (if given) on the `unlocked` event
//   POST /api/s/:shareId/name      valid token + name → UnlockResponse with that name's recipient token
//   POST /api/s/:shareId/refresh   valid token → UnlockResponse for the same token (current file list
//                                  and infohash, e.g. after files were added to the share)
//   GET  /api/s/:shareId/torrent   .torrent for a valid token
// All URLs come from PUBLIC_BASE_URL. Client IPs are used in memory for rate limiting only.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import type { ShareRow } from '../db/index.js';
import type { ShareStatusResponse, UnlockResponse } from '../types.js';
import { buildMagnet, buildTorrentFile, shareUrls, torrentContentDisposition } from './metainfo.js';
import { RecentOnce, Semaphore, UnlockRateLimiter } from './ratelimit.js';
import { shareState, type ShareStore } from './shares.js';
import { sanitizeNick } from './swarm.js';

export interface PublicRouteDeps {
  shares: ShareStore;
  unlockLimiter: UnlockRateLimiter;
  /** One `unlocked` event per (share, name, client) per 10 min; a reload loop can't flood share_events. */
  unlockEvents: RecentOnce;
}

/** Raw `name` length accepted before sanitising (sanitizeNick keeps ≤ 24 characters). */
const MAX_NAME_CHARS = 256;

const gone = (reply: FastifyReply) => reply.code(404).send({ error: 'gone' });

export async function registerShareApi(app: FastifyInstance, ctx: AppContext, deps: PublicRouteDeps): Promise<void> {
  const { shares, unlockLimiter, unlockEvents } = deps;
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
      const b = req.body as { password?: unknown; name?: unknown } | undefined | null;
      if (b !== undefined && b !== null && (typeof b !== 'object' || Array.isArray(b))) return reply.code(400).send({ error: 'bad_request' });
      const pw = b?.password;
      if (pw !== undefined && (typeof pw !== 'string' || pw.length > 1024)) return reply.code(400).send({ error: 'bad_request' });
      if (b?.name !== undefined && (typeof b.name !== 'string' || b.name.length > MAX_NAME_CHARS)) return reply.code(400).send({ error: 'bad_request' });
      const name = sanitizeNick(b?.name);
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
      // Keyed by name too: several people behind one NAT (an office) each get their own event.
      if (unlockEvents.first(`${cur.id}\n${name ?? ''}`, req.ip || 'unknown')) shares.event(cur.id, 'unlocked', name ? { name } : undefined);
      // A named recipient gets a recipient token: the .torrent, magnet and tracker URLs built from it
      // carry their name to the tracker, so a torrent app using them is labelled too.
      return reply.send(unlockBody(cur, shares.token(cur, name ? shares.recipientId(cur.id, name) : undefined)));
    },
  );

  // Swap a valid token for the recipient token of a (new) name: a page that unlocked before it had a
  // name, or whose recipient changed their name, gets .torrent/magnet links that carry the name.
  // Grants nothing the presented token doesn't already grant (same share, same token_version).
  app.post<{ Params: { shareId: string }; Body: unknown }>('/api/s/:shareId/name', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = req.body as { token?: unknown; name?: unknown } | undefined | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.token !== 'string' || typeof b.name !== 'string' || b.name.length > MAX_NAME_CHARS) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const name = sanitizeNick(b.name);
    if (!name) return reply.code(400).send({ error: 'bad_request' });
    const auth = shares.authorize(b.token);
    if (!auth.ok) return auth.reason === 'gone' ? gone(reply) : reply.code(401).send({ error: 'invalid' });
    if (auth.share.id !== req.params.shareId) return reply.code(401).send({ error: 'invalid' });
    const cur = auth.share;
    if (unlockEvents.first(`${cur.id}\n${name}`, req.ip || 'unknown')) shares.event(cur.id, 'unlocked', { name });
    return reply.send(unlockBody(cur, shares.token(cur, shares.recipientId(cur.id, name))));
  });

  // Grants nothing new: same token back, with the share's current info. Records no event.
  app.post<{ Params: { shareId: string }; Body: unknown }>('/api/s/:shareId/refresh', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const b = req.body as { token?: unknown } | undefined | null;
    if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.token !== 'string' || b.token.length > 512) {
      return reply.code(400).send({ error: 'bad_request' });
    }
    const auth = shares.authorize(b.token);
    if (!auth.ok) return auth.reason === 'gone' ? gone(reply) : reply.code(401).send({ error: 'invalid' });
    if (auth.share.id !== req.params.shareId) return reply.code(401).send({ error: 'invalid' });
    return reply.send(unlockBody(auth.share, b.token));
  });

  function unlockBody(cur: ShareRow, token: string): UnlockResponse {
    const urls = shareUrls(ctx.config, cur.id, token);
    const info = shares.info(cur);
    return {
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
  }

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
