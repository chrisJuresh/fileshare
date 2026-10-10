// OWNER: admin builder. Contract: docs/ARCHITECTURE.md §7.2, §8, §13.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { IngestService } from '../ingest/index.js';
import type { P2PService } from '../p2p/index.js';

export interface AdminDeps {
  ingest: IngestService;
  p2p: P2PService;
}

/** Registers the Access-JWT guard, /api/admin/* routes and the admin live WebSocket. */
export async function registerAdminApi(_app: FastifyInstance, _ctx: AppContext, _deps: AdminDeps): Promise<void> {
  throw new Error('admin: not implemented');
}
