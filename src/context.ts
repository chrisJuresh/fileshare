import type { Config } from './config.js';
import type { AppEvents } from './core/events.js';
import type { Db } from './db/index.js';
import type { Logger } from './log.js';

export interface AppContext {
  config: Config;
  db: Db;
  log: Logger;
  events: AppEvents;
}
