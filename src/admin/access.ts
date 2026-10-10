// Cloudflare Access JWT guard + CSRF checks for the admin listener (docs/ARCHITECTURE.md §7.2).
// Registered as an onRequest hook on the whole admin instance: API, tus, static and WS upgrades.
import { createRemoteJWKSet, errors as joseErrors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../log.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the Access guard: the verified `email` claim (lowercased), or '' for service tokens. */
    adminEmail?: string;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TUS_PREFIX = '/api/admin/uploads/tus/';
const MAX_JWT_LENGTH = 16 * 1024;
const CLOCK_TOLERANCE_S = 60;

export interface AccessSettings {
  issuer: string;
  audience: string;
  certsUrl: URL;
  allowEmails: string[];
  allowedOrigin: string;
}

/** Derives the verifier settings from config, or returns a reason string if they are incomplete. */
export function accessSettings(config: Config): AccessSettings | string {
  const team = config.env.CF_ACCESS_TEAM_DOMAIN.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const aud = config.env.CF_ACCESS_AUD.trim();
  if (!team) return 'CF_ACCESS_TEAM_DOMAIN is not set';
  if (!aud) return 'CF_ACCESS_AUD is not set';
  let certsUrl: URL;
  try {
    certsUrl = new URL(config.env.CF_ACCESS_CERTS_URL.trim() || `https://${team}/cdn-cgi/access/certs`);
  } catch {
    return 'CF_ACCESS_CERTS_URL / CF_ACCESS_TEAM_DOMAIN do not form a valid URL';
  }
  return {
    issuer: `https://${team}`,
    audience: aud,
    certsUrl,
    allowEmails: config.adminEmails,
    allowedOrigin: config.adminBaseUrl.origin,
  };
}

export type VerifyResult = { ok: true; email: string } | { ok: false; reason: string };

/** Builds a verifier for `Cf-Access-Jwt-Assertion` values. Never logs or returns the token itself. */
export function createAccessVerifier(s: AccessSettings, keys?: JWTVerifyGetKey): (token: string) => Promise<VerifyResult> {
  const jwks = keys ?? createRemoteJWKSet(s.certsUrl, { timeoutDuration: 5000, cooldownDuration: 30_000 });
  return async (token) => {
    if (!token || token.length > MAX_JWT_LENGTH) return { ok: false, reason: 'missing' };
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: s.issuer,
        audience: s.audience,
        algorithms: ['RS256'],
        clockTolerance: CLOCK_TOLERANCE_S,
        requiredClaims: ['exp', 'iat'],
      });
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      if (s.allowEmails.length > 0 && !s.allowEmails.includes(email)) return { ok: false, reason: 'email_not_allowed' };
      return { ok: true, email };
    } catch (err) {
      return { ok: false, reason: err instanceof joseErrors.JOSEError ? err.code : 'verify_failed' };
    }
  };
}

function isHtmlNavigation(req: FastifyRequest): boolean {
  return !req.url.startsWith('/api/') && (req.headers.accept ?? '').includes('text/html');
}

function deny(req: FastifyRequest, reply: FastifyReply, code = 403, error = 'forbidden'): FastifyReply {
  if (code === 403 && isHtmlNavigation(req)) {
    return reply
      .code(403)
      .type('text/html; charset=utf-8')
      .send('<!doctype html><meta charset="utf-8"><title>Forbidden</title><h1>403 Forbidden</h1><p>Access denied.</p>');
  }
  return reply.code(code).send({ error });
}

function isJson(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(';')[0]!.trim().toLowerCase();
  return base === 'application/json';
}

/**
 * The onRequest hook. Fails closed: with incomplete Access config every request (except /healthz)
 * gets 403, and the reason is logged once at startup.
 */
export function createAccessHook(config: Config, log: Logger, keys?: JWTVerifyGetKey): onRequestAsyncHookHandler {
  const settings = accessSettings(config);
  const verify = typeof settings === 'string' ? undefined : createAccessVerifier(settings, keys);
  if (typeof settings === 'string') {
    log.error({ reason: settings }, 'admin: Cloudflare Access is not configured; every admin request will be refused (403)');
  }
  const allowedOrigin = config.adminBaseUrl.origin;

  return async function accessGuard(req, reply) {
    const pathOnly = req.url.split('?')[0]!;
    if (pathOnly === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) return;
    if (!verify) return deny(req, reply);

    const header = req.headers['cf-access-jwt-assertion'];
    const token = Array.isArray(header) ? '' : (header ?? '');
    const result = await verify(token);
    if (!result.ok) {
      req.log.warn({ reason: result.reason, method: req.method, path: pathOnly }, 'admin: access denied');
      return deny(req, reply);
    }
    req.adminEmail = result.email;

    const isUpgrade = (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    if (MUTATING.has(req.method) || isUpgrade) {
      // Browsers always send Origin on cross-origin and on same-origin non-GET requests and on
      // WebSocket handshakes. Require it to be exactly the admin origin (CSRF / CSWSH defence).
      if (req.headers.origin !== allowedOrigin) {
        req.log.warn({ method: req.method, path: pathOnly }, 'admin: bad or missing Origin');
        return deny(req, reply);
      }
    }
    const isTus = pathOnly === TUS_PREFIX.slice(0, -1) || pathOnly.startsWith(TUS_PREFIX);
    if (MUTATING.has(req.method) && !isTus && !isJson(req.headers['content-type'])) {
      return deny(req, reply, 415, 'unsupported_media_type');
    }
  };
}
