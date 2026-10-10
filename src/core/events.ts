import { EventEmitter } from 'node:events';
import type { ItemStatus } from '../types.js';

export type AppEventMap = {
  'item.status': { itemId: string; status: ItemStatus };
  'item.renamed': { itemId: string; oldName: string; newName: string };
  'item.deleted': { itemId: string };
  'share.changed': { shareId: string; reason: 'created' | 'updated' | 'revoked' | 'expired' };
  'settings.changed': { key: string };
};

export class AppEvents {
  private ee = new EventEmitter();
  constructor() {
    this.ee.setMaxListeners(100);
  }
  on<K extends keyof AppEventMap>(event: K, fn: (payload: AppEventMap[K]) => void): () => void {
    this.ee.on(event, fn);
    return () => this.ee.off(event, fn);
  }
  emit<K extends keyof AppEventMap>(event: K, payload: AppEventMap[K]): void {
    this.ee.emit(event, payload);
  }
}
