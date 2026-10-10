import pino, { type Logger } from 'pino';

export type { Logger };

/** Replace the token segment of /tr/<token>/… and /ws/<token>/… so share tokens never reach logs. */
export function redactUrl(url: string): string {
  return url.replace(/^\/(tr|ws)\/[^/?#]+/, '/$1/[token]').replace(/([?&]t=)[^&#]+/, '$1[token]');
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
