export const now = (): number => Date.now();

/** Minutes since local midnight in the process TZ. */
export function localMinutes(d: Date = new Date()): number {
  return d.getHours() * 60 + d.getMinutes();
}

/** True if `min` (minutes since local midnight) is in [start, end), handling windows over midnight. */
export function inWindow(min: number, start: number, end: number): boolean {
  return start <= end ? min >= start && min < end : min >= start || min < end;
}
