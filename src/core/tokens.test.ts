import { describe, expect, it } from 'vitest';
import { newRecipientId, newShareId } from './ids.js';
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

describe('recipient share tokens', () => {
  const key = 'k'.repeat(64);
  it('round-trip with the recipient id, path-safe and within the length limit', () => {
    const id = newShareId();
    const rid = newRecipientId();
    const t = makeShareToken(key, id, 123456789, rid);
    expect(verifyShareToken(key, t)).toEqual({ shareId: id, tokenVersion: 123456789, recipientId: rid });
    expect(t).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(t.length).toBeLessThanOrEqual(80);
  });
  it('bind the recipient id: swapping, dropping or adding it breaks the MAC', () => {
    const id = newShareId();
    const rid = newRecipientId();
    const other = newRecipientId();
    const t = makeShareToken(key, id, 1, rid);
    const plain = makeShareToken(key, id, 1);
    expect(verifyShareToken(key, t.replace(rid, other))).toBeUndefined();
    const mac = t.split('.').at(-1)!;
    expect(verifyShareToken(key, `${id}.1.${mac}`)).toBeUndefined(); // recipient MAC without the id
    const plainMac = plain.split('.').at(-1)!;
    expect(verifyShareToken(key, `${id}.1.${rid}.${plainMac}`)).toBeUndefined(); // plain MAC with an id added
    expect(verifyShareToken(key, `${id}.1.NOT-A-RID-0000000.${mac}`)).toBeUndefined();
    expect(verifyShareToken(key, `${t}.extra`)).toBeUndefined();
  });
});
