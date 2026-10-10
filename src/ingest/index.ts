// OWNER: ingest builder. Contract: docs/ARCHITECTURE.md §4, §13.
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import type { P2PService } from '../p2p/index.js';

export interface IngestService {
  start(): Promise<void>;
  stop(): Promise<void>;
  retry(itemId: string): Promise<void>;
  renameItem(itemId: string, newName: string): Promise<void>;
  deleteItem(itemId: string): Promise<void>;
  /** tus endpoint + upload batch routes under /api/admin/uploads (admin listener only). */
  registerAdminRoutes(app: FastifyInstance): Promise<void>;
  /** itemId → 0..1 for items currently hashing. */
  progress(): Record<string, number>;
}

export type IngestDeps = { p2p: Pick<P2PService, 'revokeAllForItem' | 'repointItem'> };

export function createIngest(_ctx: AppContext, _deps: IngestDeps): IngestService {
  throw new Error('ingest: not implemented');
}
