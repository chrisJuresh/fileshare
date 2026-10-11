import { describe, expect, it } from 'vitest';
import { formatPercent } from './format.ts';

describe('formatPercent', () => {
  it('never shows 100 % before it is complete', () => {
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0.99999)).toBe('99.9%');
    expect(formatPercent(0.9996)).toBe('99.9%');
    expect(formatPercent(0.995)).toBe('99.5%');
    expect(formatPercent(0.99)).toBe('99.0%');
  });

  it('one decimal below 10 %, whole per cents up to 99 %, clamps bad input', () => {
    expect(formatPercent(0.042)).toBe('4.2%');
    expect(formatPercent(0.456)).toBe('46%');
    expect(formatPercent(0.986)).toBe('99%');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(-1)).toBe('0.0%');
    expect(formatPercent(2)).toBe('100%');
    expect(formatPercent(Number.NaN)).toBe('0.0%');
  });
});
