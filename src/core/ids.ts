import { randomBytes } from 'node:crypto';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 16 random bytes as lowercase base32 (26 chars). */
export function newId(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** 16 random bytes as base64url (22 chars) — share ids in public links. */
export function newShareId(): string {
  return randomBytes(16).toString('base64url');
}

export const SHARE_ID_RE = /^[A-Za-z0-9_-]{22}$/;
