import type { FastifyReply } from 'fastify';

export function publicSecurityHeaders(reply: FastifyReply, publicHost: string): void {
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      `connect-src 'self' wss://${publicHost}`,
      "img-src 'self' data: blob:",
      "media-src 'self' blob:",
      "worker-src 'self'",
      "style-src 'self'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}

export function adminSecurityHeaders(reply: FastifyReply): void {
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data: blob:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; '),
  );
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cache-Control', 'no-store');
}
