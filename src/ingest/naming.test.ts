import { describe, expect, it } from 'vitest';
import { validateSegment } from '../core/paths.js';
import { chooseName, timestampSuffix } from './naming.js';

describe('chooseName', () => {
  const at = new Date(2026, 9, 10, 9, 5); // local time 2026-10-10 09:05

  it('uses the entry name when free', async () => {
    expect(await chooseName('Holiday', () => false, at)).toBe('Holiday');
  });

  it('adds a timestamp suffix, then (n)', async () => {
    expect(timestampSuffix(at)).toBe(' (2026-10-10 0905)');
    const taken = new Set(['Holiday']);
    expect(await chooseName('Holiday', (n) => taken.has(n), at)).toBe('Holiday (2026-10-10 0905)');
    taken.add('Holiday (2026-10-10 0905)');
    expect(await chooseName('Holiday', (n) => taken.has(n), at)).toBe('Holiday (2026-10-10 0905) (2)');
    taken.add('Holiday (2026-10-10 0905) (2)');
    expect(await chooseName('Holiday', async (n) => taken.has(n), at)).toBe('Holiday (2026-10-10 0905) (3)');
  });

  it('keeps suffixed names within 200 bytes and valid', async () => {
    const base = 'é'.repeat(100); // 200 bytes
    const name = await chooseName(base, (n) => n === base, at);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200);
    expect(name.endsWith(' (2026-10-10 0905)')).toBe(true);
    expect(validateSegment(name)).toBe(name);
  });
});
