import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((v) => v === 'true' || v === '1');

const port = z.coerce.number().int().min(1).max(65535);

const EnvSchema = z.object({
  NODE_ENV: z.string().default('production'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TZ: z.string().default('UTC'),

  PUBLIC_BASE_URL: z.url(),
  ADMIN_BASE_URL: z.url(),
  PUBLIC_BIND: z.string().default('127.0.0.1'),
  PUBLIC_PORT: port.default(8090),
  ADMIN_BIND: z.string().default('127.0.0.1'),
  ADMIN_PORT: port.default(8091),
  BT_PORT: port.default(6890),
  WEBRTC_PORT: port.default(6891),
  WEBRTC_ANNOUNCE_IP: z.string().default(''),
  STUN_URLS: z.string().default('stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302'),

  DATA_DIR: z.string().default('/data'),
  STATE_DIR: z.string().default('/state'),
  SECRETS_DIR: z.string().default('/secrets'),
  WEB_DIR: z.string().default(''),

  SYNCTHING_API_URL: z.url().default('http://127.0.0.1:8384'),
  SYNCTHING_FOLDER_ID: z.string().default('fileshare-outbox'),
  SYNCTHING_PC_DEVICE_ID: z.string().default(''),
  INGEST_QUIET_SECONDS: z.coerce.number().int().min(1).default(120),
  INGEST_RESCAN_SECONDS: z.coerce.number().int().min(1).default(30),

  CF_ACCESS_TEAM_DOMAIN: z.string().default(''),
  CF_ACCESS_AUD: z.string().default(''),
  CF_ACCESS_CERTS_URL: z.string().default(''),
  ADMIN_EMAILS: z.string().default(''),

  SNAPSHOT_DEBOUNCE_SECONDS: z.coerce.number().int().min(1).default(120),
  SNAPSHOT_PAUSE_WINDOW: z
    .string()
    .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/)
    .default('03:45-05:15'),
  RESTIC_REPOSITORY: z.string().default('/restic'),
  RESTIC_BIN: z.string().default('restic'),
  BACKUP_EXTRA_PATHS: z.string().default('/config/.env,/secrets,/syncthing-config'),

  TRUST_PROXY: bool,
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  env: Env;
  isTest: boolean;
  publicBaseUrl: URL;
  adminBaseUrl: URL;
  publicHost: string;
  stunUrls: string[];
  adminEmails: string[];
  pauseWindow: { startMin: number; endMin: number };
  paths: {
    data: string;
    outbox: string;
    library: string;
    staging: string;
    uploads: string;
    state: string;
    db: string;
    seedlinks: string;
    backupDir: string;
    secrets: string;
    web: string;
  };
  /** Reads a secret file from SECRETS_DIR. Throws if missing or empty. Never log the result. */
  secret(name: SecretName): string;
}

export type SecretName = 'share-hmac-key' | 'syncthing-api-key' | 'restic-password';

function hhmmToMin(s: string): number {
  const [h, m] = s.split(':').map(Number) as [number, number];
  if (h > 23 || m > 59) throw new Error(`bad time ${s}`);
  return h * 60 + m;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const env = EnvSchema.parse(source);
  if (env.ADMIN_BIND === '0.0.0.0' || env.ADMIN_BIND === '::' || env.ADMIN_BIND === '') {
    throw new Error('ADMIN_BIND must be a specific non-public address (never 0.0.0.0 / ::)');
  }
  const [ps, pe] = env.SNAPSHOT_PAUSE_WINDOW.split('-') as [string, string];
  const publicBaseUrl = new URL(env.PUBLIC_BASE_URL);
  const adminBaseUrl = new URL(env.ADMIN_BASE_URL);
  const secretCache = new Map<string, string>();
  const data = env.DATA_DIR;
  const state = env.STATE_DIR;
  return {
    env,
    isTest: env.NODE_ENV === 'test',
    publicBaseUrl,
    adminBaseUrl,
    publicHost: publicBaseUrl.host,
    stunUrls: env.STUN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
    adminEmails: env.ADMIN_EMAILS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    pauseWindow: { startMin: hhmmToMin(ps), endMin: hhmmToMin(pe) },
    paths: {
      data,
      outbox: path.join(data, 'outbox'),
      library: path.join(data, 'library'),
      staging: path.join(data, 'staging'),
      uploads: path.join(data, 'uploads'),
      state,
      db: path.join(state, 'fileshare.db'),
      seedlinks: path.join(state, 'seedlinks'),
      backupDir: path.join(state, 'backup'),
      secrets: env.SECRETS_DIR,
      web: env.WEB_DIR || path.resolve(import.meta.dirname, '..', 'dist', 'web'),
    },
    secret(name) {
      const cached = secretCache.get(name);
      if (cached) return cached;
      const value = readFileSync(path.join(env.SECRETS_DIR, name), 'utf8').trim();
      if (!value) throw new Error(`secret ${name} is empty`);
      secretCache.set(name, value);
      return value;
    },
  };
}
