import { createHmac, timingSafeEqual } from 'node:crypto';
import { RECIPIENT_ID_RE, SHARE_ID_RE } from './ids.js';

/**
 * Share access token (see docs/ARCHITECTURE.md §9), one of:
 *   `<shareId>.<tokenVersion>.<mac>`                 plain (seeder, recipients who gave no name)
 *   `<shareId>.<tokenVersion>.<recipientId>.<mac>`   recipient token: names whoever uses it
 * The MAC covers every field, so the recipient id can't be swapped. Verifying the MAC is necessary
 * but NOT sufficient: callers must then load the share and check token_version, revoked_at and
 * expires_at (and look the recipient up).
 */
export function shareMac(key: string, shareId: string, tokenVersion: number, recipientId?: string): string {
  const msg =
    recipientId === undefined
      ? `fileshare/share/v1\n${shareId}\n${tokenVersion}`
      : `fileshare/share-recipient/v1\n${shareId}\n${tokenVersion}\n${recipientId}`;
  return createHmac('sha256', key).update(msg).digest('base64url').slice(0, 22);
}

export function makeShareToken(key: string, shareId: string, tokenVersion: number, recipientId?: string): string {
  const mac = shareMac(key, shareId, tokenVersion, recipientId);
  return recipientId === undefined ? `${shareId}.${tokenVersion}.${mac}` : `${shareId}.${tokenVersion}.${recipientId}.${mac}`;
}

export interface ParsedToken {
  shareId: string;
  tokenVersion: number;
  recipientId?: string;
}

/** Returns the parsed token if the MAC is valid, otherwise undefined. Constant-time compare. */
export function verifyShareToken(key: string, token: string): ParsedToken | undefined {
  if (typeof token !== 'string' || token.length > 80) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 && parts.length !== 4) return undefined;
  const shareId = parts[0]!;
  const versionStr = parts[1]!;
  const recipientId = parts.length === 4 ? parts[2]! : undefined;
  const mac = parts[parts.length - 1]!;
  if (!SHARE_ID_RE.test(shareId) || !/^[1-9]\d{0,8}$/.test(versionStr)) return undefined;
  if (recipientId !== undefined && !RECIPIENT_ID_RE.test(recipientId)) return undefined;
  const tokenVersion = Number(versionStr);
  const expected = Buffer.from(shareMac(key, shareId, tokenVersion, recipientId));
  const given = Buffer.from(mac);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  return recipientId === undefined ? { shareId, tokenVersion } : { shareId, tokenVersion, recipientId };
}
