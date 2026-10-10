// OWNER: p2p builder. Contract: docs/ARCHITECTURE.md §7.1, §8–§11, §13.
import type { FastifyInstance } from 'fastify';
import type { Transform } from 'node:stream';
import type { AppContext } from '../context.js';
import type { ShareDto, SwarmSnapshot } from '../types.js';

export interface UploadLimiter {
  setRate(bytesPerSec: number): void;
  throttle(): Transform;
  currentBps(): number;
}

export interface P2PService {
  start(): Promise<void>;
  stop(): Promise<void>;
  registerPublicRoutes(app: FastifyInstance): Promise<void>;
  createShare(input: { itemId: string; password?: string; expiresAt?: number }): Promise<ShareDto>;
  updateShare(id: string, patch: { password?: string | null; expiresAt?: number | null }): Promise<ShareDto>;
  revokeShare(id: string): Promise<void>;
  revokeAllForItem(itemId: string): Promise<void>;
  repointItem(itemId: string): Promise<void>;
  getShare(id: string): ShareDto | undefined;
  listShares(): ShareDto[];
  swarm(shareId: string): SwarmSnapshot | undefined;
  allSwarms(): Record<string, SwarmSnapshot>;
  limiter: UploadLimiter;
}

export function createP2P(_ctx: AppContext): P2PService {
  throw new Error('p2p: not implemented');
}
