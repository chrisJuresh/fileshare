// Human-friendly formatting. Sizes use decimal units (like disks and network speeds).

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** bytes/s → "12.3 Mbit/s" */
export function fmtRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined || !Number.isFinite(bytesPerSec)) return '–';
  const bits = Math.max(0, bytesPerSec) * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbit/s`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(bits >= 1e8 ? 0 : 1)} Mbit/s`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} kbit/s`;
  return `${bits.toFixed(0)} bit/s`;
}

export const bpsToMbps = (bytesPerSec: number): number => (bytesPerSec * 8) / 1e6;
export const mbpsToBps = (mbps: number): number => Math.floor((mbps * 1e6) / 8);

export function fmtPercent(fraction: number | null | undefined, digits = 0): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '–';
  return `${(fraction * 100).toFixed(digits)}%`;
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function fmtDate(ms: number | null | undefined): string {
  if (!ms) return '–';
  return dateFmt.format(new Date(ms));
}

export function fmtRelative(ms: number | null | undefined, now = Date.now()): string {
  if (!ms) return '–';
  const diff = ms - now;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60_000, 'second'],
    [3_600_000, 'minute'],
    [86_400_000, 'hour'],
    [30 * 86_400_000, 'day'],
    [365 * 86_400_000, 'month'],
  ];
  const div: Record<string, number> = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000, month: 30 * 86_400_000, year: 365 * 86_400_000 };
  for (const [limit, unit] of steps) {
    if (abs < limit) return rtf.format(Math.round(diff / div[unit]!), unit);
  }
  return rtf.format(Math.round(diff / div.year!), 'year');
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): number | null {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** One line for a share event, with the recipient's self-chosen name where there is one. */
export function fmtActivity(e: { type: string; name: string | null; detail?: unknown }): string {
  const kind = e.detail && typeof e.detail === 'object' ? (e.detail as { kind?: unknown }).kind : undefined;
  const who = e.name ?? (kind === 'client' ? 'A torrent client' : 'Someone (no name given)');
  switch (e.type) {
    case 'unlocked':
      return `${who} opened the link`;
    case 'completed':
      return `${who} finished downloading`;
    case 'unlock_failed':
      return 'Wrong password entered';
    case 'created':
      return 'Link created';
    case 'updated':
      return 'Link changed';
    case 'revoked':
      return 'Link revoked';
    case 'expired':
      return 'Link expired';
    default:
      return e.type;
  }
}
