import pino, { type Logger } from 'pino';

export type { Logger };

/**
 * Make a request URL safe to log: tracker queries are dropped, the token segment of /tr/<token>/… and /ws/<token>/… and every
 * `t=` query value become `[token]`; share ids in /s/<id> and /api/s/<id>/… keep only their first 4
 * characters (enough to correlate, useless for access).
 */
export function redactUrl(url: string): string {
  return url
    .replace(/^\/tr\/([^?#]*)[?#].*$/, '/tr/$1') // announce queries carry the info_hash and peer_id
    .replace(/^\/(tr|ws)\/[^/?#]+/, '/$1/[token]')
    .replace(/^\/(s|api\/s)\/([^/?#]+)/, (_m, prefix: string, id: string) => `/${prefix}/${id.slice(0, 4)}…`)
    .replace(/([?&]t=)[^&#]+/g, '$1[token]');
}

export function createLogger(level: string, name = 'fileshare'): Logger {
  return pino({
    name,
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers["cf-access-jwt-assertion"]',
        'req.headers.cookie',
        'req.headers.authorization',
        'token',
        'password',
        '*.token',
        '*.password',
      ],
      censor: '[redacted]',
    },
  });
}
