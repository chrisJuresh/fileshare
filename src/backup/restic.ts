// Thin wrapper around the restic binary: builds a minimal environment (never the whole
// process env), streams `--json` lines, and lets the caller interrupt with SIGINT.
import { spawn } from 'node:child_process';

export interface ResticEnv {
  bin: string;
  repository: string;
  passwordFile: string;
  cacheDir: string;
}

export interface ResticResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Parsed JSON objects/arrays from stdout, in order (non-JSON lines are dropped). */
  json: unknown[];
  /** JSON messages restic printed on stderr (`error`, `exit_error`), in order (capped). */
  errors: Record<string, unknown>[];
  /** Last few KB of stderr, for error messages. */
  stderrTail: string;
  /** True if `interrupt()` was called before the process exited. */
  interrupted: boolean;
}

export interface ResticProcess {
  result: Promise<ResticResult>;
  /** Ask restic to stop (SIGINT, then SIGKILL after `graceMs`). */
  interrupt(graceMs?: number): void;
}

export const EXIT = {
  ok: 0,
  fatal: 1,
  incomplete: 3,
  repoMissing: 10,
  lockFailed: 11,
  wrongPassword: 12,
  interrupted: 130,
} as const;

const STDERR_TAIL = 4096;
/** Keep at most this many parsed JSON lines (status lines are frequent; summaries come last). */
const MAX_JSON_LINES = 2000;

export function resticEnv(r: ResticEnv): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    TZ: process.env.TZ ?? 'UTC',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    RESTIC_REPOSITORY: r.repository,
    RESTIC_PASSWORD_FILE: r.passwordFile,
    RESTIC_CACHE_DIR: r.cacheDir,
    // One status line per minute is plenty for logs.
    RESTIC_PROGRESS_FPS: '0.0167',
  };
}

export function runRestic(
  r: ResticEnv,
  args: string[],
  opts: { onJson?: (msg: unknown) => void } = {},
): ResticProcess {
  const child = spawn(r.bin, args, { env: resticEnv(r), stdio: ['ignore', 'pipe', 'pipe'] });
  let interrupted = false;
  let killTimer: NodeJS.Timeout | undefined;
  const json: unknown[] = [];
  const errors: Record<string, unknown>[] = [];
  let stderrTail = '';
  let buf = '';
  let errBuf = '';

  const handleErrLine = (line: string): void => {
    const t = line.trim();
    if (!t) return;
    if (t[0] === '{') {
      try {
        const msg = JSON.parse(t) as Record<string, unknown>;
        if (errors.length < MAX_JSON_LINES) errors.push(msg);
        const text = messageText(msg);
        stderrTail = (stderrTail + text + '\n').slice(-STDERR_TAIL);
        return;
      } catch {
        // fall through: keep the raw line
      }
    }
    stderrTail = (stderrTail + t + '\n').slice(-STDERR_TAIL);
  };

  const handleLine = (line: string): void => {
    const t = line.trim();
    if (!t || (t[0] !== '{' && t[0] !== '[')) return;
    try {
      const msg = JSON.parse(t) as unknown;
      if (json.length >= MAX_JSON_LINES) json.splice(0, json.length - MAX_JSON_LINES + 1);
      json.push(msg);
      opts.onJson?.(msg);
    } catch {
      // not JSON (restic prints some plain text even with --json); ignore
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      handleLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    errBuf += chunk;
    let i: number;
    while ((i = errBuf.indexOf('\n')) >= 0) {
      handleErrLine(errBuf.slice(0, i));
      errBuf = errBuf.slice(i + 1);
    }
  });

  const result = new Promise<ResticResult>((resolve) => {
    let settled = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (buf) handleLine(buf);
      if (errBuf) handleErrLine(errBuf);
      resolve({ code, signal, json, errors, stderrTail, interrupted });
    };
    child.on('error', (err) => {
      stderrTail = (stderrTail + `\nspawn error: ${err.message}`).slice(-STDERR_TAIL);
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });

  return {
    result,
    interrupt(graceMs = 60_000) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      interrupted = true;
      child.kill('SIGINT');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), graceMs);
      killTimer.unref();
    },
  };
}

/** Short, single-line error text from a failed restic run (no secrets: restic never prints the password). */
export function errorText(res: ResticResult, max = 500): string {
  const lines = res.stderrTail
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines.slice(-3).join(' | ');
  const head = res.code === null ? `restic did not run${res.signal ? ` (${res.signal})` : ''}` : `restic exit ${res.code}`;
  return (last ? `${head}: ${last}` : head).slice(0, max);
}

function messageText(msg: Record<string, unknown>): string {
  const err = msg.error as { message?: unknown } | undefined;
  if (err && typeof err.message === 'string') return err.message;
  if (typeof msg.message === 'string') return msg.message;
  return JSON.stringify(msg);
}

export function isMsg(m: unknown, type: string): m is Record<string, unknown> {
  return typeof m === 'object' && m !== null && (m as { message_type?: unknown }).message_type === type;
}
