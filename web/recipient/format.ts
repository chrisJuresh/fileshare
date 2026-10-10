const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '–';
  let v = n;
  let i = 0;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1000;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${UNITS[i]}`;
}

export function formatSpeed(bps: number): string {
  return `${formatBytes(Math.max(0, bps))}/s`;
}

export function formatPercent(p: number): string {
  const v = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0)) * 100;
  return `${v >= 99.95 && p < 1 ? '99.9' : v.toFixed(v < 10 ? 1 : 0)}%`;
}

export function formatEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return 'working it out…';
  if (seconds < 60) return 'less than a minute';
  const m = Math.round(seconds / 60);
  if (m < 60) return `about ${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return `about ${h} h ${rm} min`;
  return `about ${Math.round(h / 24)} days`;
}
