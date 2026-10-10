// Fastify's built-in request logging writes the full URL (share ids, tokens in /tr/ and /ws/ paths,
// `?t=` query strings) and the client IP. Both listeners log requests themselves in an onResponse
// hook with a redacted URL, so the built-in per-request lines are switched off here. This uses the
// LogController API (Fastify ≥ 5.12) instead of the deprecated top-level `disableRequestLogging`.
import { LogController, type FastifyReply, type FastifyRequest } from 'fastify';

export class QuietLogController extends LogController {
  constructor() {
    super({ disableRequestLogging: true });
  }

  /** Never skip the error itself for 5xx, but log it without request data (no URL, no IP). */
  override defaultErrorLog(error: Error, _request: FastifyRequest, reply: FastifyReply): void {
    if (reply.statusCode < 500) return;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    reply.log.error({ err: { name: error?.name, ...(typeof code === 'string' ? { code } : {}) }, status: reply.statusCode }, 'request failed');
  }
}
