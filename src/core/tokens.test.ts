import { describe, expect, it } from 'vitest';
import { newShareId } from './ids.js';
import { makeShareToken, verifyShareToken } from './tokens.js';

describe('share tokens', () => {
  const key = 'k'.repeat(64);
  it('round-trips', () => {
    const id = newShareId();
    const t = makeShareToken(key, id, 3);
    expect(verifyShareToken(key, t)).toEqual({ shareId: id, tokenVersion: 3 });
    expect(t).toMatch(/^[A-Za-z0-9_.-]+$/);
  });
  it('rejects tampering and other keys', () => {
    const id = newShareId();
    const t = makeShareToken(key, id, 1);
    expect(verifyShareToken('other', t)).toBeUndefined();
    expect(verifyShareToken(key, t.replace('.1.', '.2.'))).toBeUndefined();
    expect(verifyShareToken(key, t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A'))).toBeUndefined();
    expect(verifyShareToken(key, 'garbage')).toBeUndefined();
  });
});
