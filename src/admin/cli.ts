// Operator CLI commands (run inside the app container: `node dist/cli.js <cmd>`).
//
// Design: the CLI is a separate process, so it cannot call the running app's p2p/ingest services
// in-process. It therefore only does things that are safe through SQLite alone:
//   - read-only listings (items, shares, status)
//   - settings writes (the app's SettingsWatcher notices them within a few seconds and emits
//     `settings.changed`, so the upload limiter picks the new cap up live)
//   - snapshot requests (the restic runner consumes backup_requests)
// Creating and revoking shares needs the p2p module (info hash, argon2, seedlinks, seeding), so
// those commands point the operator to the dashboard instead of half-doing it in the DB.
import { requestSnapshot } from '../backup/queue.js';
import type { Config } from '../config.js';
import type { Db, ShareRow } from '../db/index.js';
import type { ShareStatsDto } from '../types.js';
import { listItems } from './dto.js';
import { bpsToMbps, KEY_CAP, mbpsToBps, MAX_CAP_BPS, MIN_CAP_BPS, readSettings, recordCapacity, writeCap } from './settings.js';
import { buildStatus } from './stats.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

export interface CliEnv {
  config: Config;
  db: Db;
  io: CliIo;
  fetchImpl?: typeof fetch;
}

export const HELP = `fileshare operator CLI

Usage: node dist/cli.js <command> [options]

  items [--json]                     list library items
  shares [--json]                    list shares (links, state, expiry)
  share create|revoke ...            not available here: use the dashboard (needs the running app)
  settings get [--json]              show the upload cap and measured capacity
  settings set-cap <Mbps>            set the upload cap (Mbit/s, decimal)
  speedtest record <upload_Mbps> [--keep-cap]
                                     store a measured upload capacity; also sets the cap to 90 %
                                     of it unless --keep-cap
  snapshot request                   queue a manual snapshot
  status [--json]                    disks, snapshots, Syncthing
  help                               this text

Settings changes reach the running app within a few seconds.
`;

const fmtBytes = (n: number): string => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${u[i]}`;
};
const fmtMbps = (bps: number): string => `${bpsToMbps(bps).toFixed(1)} Mbit/s`;
const fmtTime = (ms: number | null | undefined): string => (ms ? new Date(ms).toISOString().replace('.000Z', 'Z') : '-');

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join('  '));
}

interface CliShare {
  id: string;
  itemId: string;
  itemName: string;
  url: string;
  hasPassword: boolean;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
  state: 'active' | 'expired' | 'revoked';
  stats: ShareStatsDto;
}

export function listSharesFromDb(db: Db, config: Config, now = Date.now()): CliShare[] {
  const rows = db
    .prepare(
      `SELECT s.*, i.name AS item_name, st.server_bytes_webseed, st.server_bytes_p2p, st.peer_bytes,
              st.completed_downloads, st.peak_swarm, st.last_activity_at
       FROM shares s JOIN items i ON i.id = s.item_id LEFT JOIN share_stats st ON st.share_id = s.id
       ORDER BY s.created_at DESC`,
    )
    .all() as (ShareRow & { item_name: string; server_bytes_webseed: number | null; server_bytes_p2p: number | null; peer_bytes: number | null; completed_downloads: number | null; peak_swarm: number | null; last_activity_at: number | null })[];
  const base = config.publicBaseUrl.origin;
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    itemName: r.item_name,
    url: `${base}/s/${r.id}`,
    hasPassword: r.password_hash !== null,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    createdAt: r.created_at,
    state: r.revoked_at !== null ? 'revoked' : r.expires_at !== null && r.expires_at <= now ? 'expired' : 'active',
    stats: {
      serverBytesWebseed: r.server_bytes_webseed ?? 0,
      serverBytesP2p: r.server_bytes_p2p ?? 0,
      peerBytes: r.peer_bytes ?? 0,
      completedDownloads: r.completed_downloads ?? 0,
      peakSwarm: r.peak_swarm ?? 0,
      lastActivityAt: r.last_activity_at,
    },
  }));
}

function parseMbps(raw: string | undefined): number {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isFinite(n) || n <= 0) throw new UsageError('expected a positive number of Mbit/s');
  return n;
}

export class UsageError extends Error {}

/** Runs one CLI command. Returns the process exit code. */
export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const { db, config, io } = env;
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  const json = flags.has('--json');
  const [cmd, sub, arg] = args;

  try {
    switch (cmd) {
      case undefined:
      case 'help':
        io.out(HELP);
        return cmd === undefined && !flags.has('--help') ? 1 : 0;

      case 'items': {
        const items = listItems(db, {});
        if (json) return io.out(JSON.stringify(items, null, 2)), 0;
        if (items.length === 0) return io.out('no items'), 0;
        io.out(table([['ID', 'STATUS', 'SIZE', 'FILES', 'SHARES', 'CREATED', 'NAME'], ...items.map((i) => [i.id, i.status, fmtBytes(i.totalBytes), String(i.fileCount), String(i.activeShares), fmtTime(i.createdAt), i.name])]).join('\n'));
        return 0;
      }

      case 'shares': {
        const shares = listSharesFromDb(db, config);
        if (json) return io.out(JSON.stringify(shares, null, 2)), 0;
        if (shares.length === 0) return io.out('no shares'), 0;
        io.out(table([['ID', 'STATE', 'PASSWORD', 'EXPIRES', 'DOWNLOADS', 'ITEM', 'URL'], ...shares.map((s) => [s.id, s.state, s.hasPassword ? 'yes' : 'no', fmtTime(s.expiresAt), String(s.stats.completedDownloads), s.itemName, s.url])]).join('\n'));
        return 0;
      }

      case 'share':
        if (sub === 'create' || sub === 'revoke') {
          io.err(
            `"share ${sub}" is not available from the CLI: it needs the running app's p2p service (hashing the share's\n` +
              'info dict, password hashing, seeding). Use the admin dashboard (Library → Share, or Shares → Revoke).',
          );
          return 2;
        }
        throw new UsageError('usage: share create|revoke (use the dashboard)');

      case 'settings': {
        if (sub === 'get' || sub === undefined) {
          const s = readSettings(db);
          if (json) return io.out(JSON.stringify(s, null, 2)), 0;
          io.out(`upload cap:       ${s.uploadCapBps > 0 ? `${fmtMbps(s.uploadCapBps)} (${s.uploadCapBps} B/s)` : 'not set'}`);
          io.out(`upload capacity:  ${s.uploadCapacityBps !== null ? `${fmtMbps(s.uploadCapacityBps)} (${s.uploadCapacityBps} B/s)` : 'not measured'}`);
          io.out(`measured at:      ${fmtTime(s.uploadMeasuredAt)}`);
          return 0;
        }
        if (sub === 'set-cap') {
          const bps = mbpsToBps(parseMbps(arg));
          if (bps < MIN_CAP_BPS || bps > MAX_CAP_BPS) throw new UsageError(`cap must be between ${fmtMbps(MIN_CAP_BPS)} and ${fmtMbps(MAX_CAP_BPS)}`);
          writeCap(db, bps);
          io.out(`${KEY_CAP} = ${bps} B/s (${fmtMbps(bps)}); the app applies it within a few seconds`);
          return 0;
        }
        throw new UsageError('usage: settings get | settings set-cap <Mbps>');
      }

      case 'speedtest': {
        if (sub !== 'record') throw new UsageError('usage: speedtest record <upload_Mbps> [--keep-cap]');
        const capacity = mbpsToBps(parseMbps(arg));
        recordCapacity(db, capacity, { keepCap: flags.has('--keep-cap') });
        const s = readSettings(db);
        io.out(`capacity ${fmtMbps(capacity)} recorded; upload cap ${s.uploadCapBps > 0 ? fmtMbps(s.uploadCapBps) : 'not set'}${flags.has('--keep-cap') ? ' (kept)' : ''}`);
        return 0;
      }

      case 'snapshot': {
        if (sub !== 'request') throw new UsageError('usage: snapshot request');
        const id = requestSnapshot(db, 'manual');
        io.out(`snapshot request #${id} queued`);
        return 0;
      }

      case 'status': {
        const st = await buildStatus(config, db, env.fetchImpl);
        if (json) return io.out(JSON.stringify(st, null, 2)), 0;
        io.out(`version ${st.version}`);
        io.out('disks:');
        for (const d of st.disks) {
          io.out(
            d.mounted
              ? `  ${d.label}: ${(d.usedFraction * 100).toFixed(0)}% used, ${fmtBytes(d.free)} free of ${fmtBytes(d.total)}${d.warn ? '  WARNING: over 85%' : ''}`
              : `  ${d.label}: ${d.note ?? 'not mounted'}`,
          );
        }
        const r = st.restic;
        io.out('snapshots:');
        io.out(`  repo initialised: ${r.repoInitialised ? 'yes' : 'no'}${r.paused ? ' (paused window)' : ''}`);
        io.out(`  last backup: ${fmtTime(r.lastBackupAt)} ${r.lastSnapshotId ?? ''} ${r.lastBackupOk === false ? 'FAILED' : ''}`.trimEnd());
        io.out(`  last check:  ${fmtTime(r.lastCheckAt)} ${r.lastCheckOk === false ? 'FAILED' : r.lastCheckOk ? 'ok' : ''}`.trimEnd());
        io.out(`  pending requests: ${r.pendingRequests}`);
        const s = st.syncthing;
        io.out(`syncthing: ${s.reachable ? 'reachable' : 'unreachable'}; PC ${s.pcConnected === null ? 'unknown' : s.pcConnected ? 'connected' : 'not connected'}; folder ${s.folderState ?? '-'}`);
        return 0;
      }

      default:
        throw new UsageError(`unknown command "${cmd}"`);
    }
  } catch (err) {
    if (err instanceof UsageError || err instanceof RangeError) {
      io.err(`error: ${err.message}\n(run "help" for usage)`);
      return 1;
    }
    throw err;
  }
}
