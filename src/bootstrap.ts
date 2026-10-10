import { loadConfig } from './config.js';
import type { AppContext } from './context.js';
import { AppEvents } from './core/events.js';
import { openDb } from './db/index.js';
import { createLogger } from './log.js';

/** Builds the shared AppContext from the environment (used by app, restic runner and CLI). */
export function createContext(name: string): AppContext {
  const config = loadConfig();
  const log = createLogger(config.env.LOG_LEVEL, name);
  const db = openDb(config.paths.db);
  return { config, db, log, events: new AppEvents() };
}
