import { createHmac, timingSafeEqual } from 'node:crypto';
import { SHARE_ID_RE } from './ids.js';

/**
 * Share access token: `<shareId>.<tokenVersion>.<mac>` (see docs/ARCHITECTURE.md §9).
 * Verifying the MAC is necessary but NOT sufficient: callers must then load the share and check
 * token_version, revoked_at and expires_at.
 */
export function shareMac(key: string, shareId: string, tokenVersion: number): string {
  return createHmac('sha256', key)
    .update(`fileshare/share/v1\n${shareId}\n${tokenVersion}`)
    .digest('base64url')
    .slice(0, 22);
}

export function makeShareToken(key: string, shareId: string, tokenVersion: number): string {
  return `${shareId}.${tokenVersion}.${shareMac(key, shareId, tokenVersion)}`;
}

export interface ParsedToken {
  shareId: string;
  tokenVersion: number;
}

/** Returns the parsed token if the MAC is valid, otherwise undefined. Constant-time compare. */
export function verifyShareToken(key: string, token: string): ParsedToken | undefined {
  if (typeof token !== 'string' || token.length > 80) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [shareId, versionStr, mac] = parts as [string, string, string];
  if (!SHARE_ID_RE.test(shareId) || !/^[1-9]\d{0,8}$/.test(versionStr)) return undefined;
  const tokenVersion = Number(versionStr);
  const expected = Buffer.from(shareMac(key, shareId, tokenVersion));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return { shareId, tokenVersion };
}
