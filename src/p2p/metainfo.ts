// Share info dicts, infohashes, .torrent files, magnets and public URLs (docs/ARCHITECTURE.md §7.3, §9).
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { FileEntry } from '../types.js';
import { bencode, type BValue } from './vendor.js';

type Dict = { [k: string]: BValue };

export interface LayoutFile extends FileEntry {
  /** BEP 47 padding file (attr contains "p"): zero bytes, never on disk, never shown. */
  pad: boolean;
}

export interface ParsedInfo {
  name: string;
  /** true for a single-file torrent (info.length, no info.files). */
  single: boolean;
  /** Real files (pad files left out). */
  files: FileEntry[];
  /** Every entry of the info dict's file list in torrent order, pad files included. */
  layout: LayoutFile[];
  /** Bytes of the real files. */
  totalBytes: number;
  pieceLength: number;
}

const td = new TextDecoder('utf-8', { fatal: true });

function text(v: unknown, what: string): string {
  if (v instanceof Uint8Array) return td.decode(v);
  if (typeof v === 'string') return v;
  throw new Error(`info: ${what} is not a string`);
}

function int(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`info: bad ${what}`);
  return v;
}

/** Path segments from a torrent must be plain names: never empty, `.`/`..`, or contain separators/NUL. */
export function isPlainSegment(s: string): boolean {
  return s.length > 0 && s !== '.' && s !== '..' && !/[/\\\u0000]/.test(s);
}

function decodeDict(buf: Uint8Array): Dict {
  const d = bencode.decode(buf);
  if (!d || typeof d !== 'object' || Array.isArray(d) || d instanceof Uint8Array) throw new Error('info: not a dict');
  return d as Dict;
}

export function parseInfo(info: Uint8Array): ParsedInfo {
  const d = decodeDict(info);
  const name = text(d['name.utf-8'] ?? d.name, 'name');
  if (!isPlainSegment(name)) throw new Error('info: bad name');
  const pieceLength = int(d['piece length'], 'piece length');
  if (Array.isArray(d.files)) {
    const layout: LayoutFile[] = d.files.map((f, i) => {
      const fd = f as Dict;
      const rawPath = (fd['path.utf-8'] ?? fd.path) as unknown;
      if (!Array.isArray(rawPath) || rawPath.length === 0) throw new Error(`info: file ${i} has no path`);
      const segs = rawPath.map((p) => text(p, 'path'));
      if (!segs.every(isPlainSegment)) throw new Error(`info: file ${i} has a bad path`);
      const pad = fd.attr !== undefined && text(fd.attr, 'attr').includes('p');
      return { path: segs.join('/'), length: int(fd.length, 'length'), pad };
    });
    const files = layout.filter((f) => !f.pad).map((f) => ({ path: f.path, length: f.length }));
    const totalBytes = files.reduce((a, f) => a + f.length, 0);
    return { name, single: false, files, layout, totalBytes, pieceLength };
  }
  const length = int(d.length, 'length');
  const file = { path: name, length };
  return { name, single: true, files: [file], layout: [{ ...file, pad: false }], totalBytes: length, pieceLength };
}

export function infoHashOf(info: Uint8Array): string {
  return createHash('sha1').update(info).digest('hex');
}

/**
 * Share info dict = item info + `source: "fileshare-<shareId>"` (own infohash, no re-hash).
 * The `name` is set to the item's current name, so shares created after a rename use the new name.
 */
export function buildShareInfo(itemInfo: Uint8Array, itemName: string, shareId: string): { info: Buffer; infoHash: string; name: string } {
  const d = decodeDict(itemInfo);
  if (d.private !== 1) d.private = 1;
  const nameBytes = Buffer.from(itemName, 'utf8');
  d.name = nameBytes;
  if ('name.utf-8' in d) d['name.utf-8'] = nameBytes;
  d.source = Buffer.from(`fileshare-${shareId}`, 'utf8');
  const info = Buffer.from(bencode.encode(d));
  // Sanity: the result must parse with the same name.
  const parsed = parseInfo(info);
  return { info, infoHash: infoHashOf(info), name: parsed.name };
}

export interface ShareUrls {
  page: string;
  trackerHttp: string;
  trackerWs: string;
  webseed: string;
  torrent: string;
}

/** Base URL without a trailing slash, from PUBLIC_BASE_URL only (never from the request). */
export function publicBase(config: Pick<Config, 'publicBaseUrl'>): string {
  return config.publicBaseUrl.href.replace(/\/+$/, '');
}

export function sharePageUrl(config: Pick<Config, 'publicBaseUrl'>, shareId: string): string {
  return `${publicBase(config)}/s/${shareId}`;
}

export function shareUrls(config: Pick<Config, 'publicBaseUrl'>, shareId: string, token: string): ShareUrls {
  const base = publicBase(config);
  const wsBase = base.replace(/^http(s?):/, 'ws$1:');
  return {
    page: `${base}/s/${shareId}`,
    trackerHttp: `${base}/tr/${token}/announce`,
    trackerWs: `${wsBase}/tr/${token}`,
    webseed: `${base}/ws/${token}/`,
    torrent: `${base}/api/s/${shareId}/torrent?t=${token}`,
  };
}

/** Full .torrent: announce = https tracker, announce-list = [[https],[wss]], url-list = [webseed], no nodes. */
export function buildTorrentFile(info: Uint8Array, urls: Pick<ShareUrls, 'trackerHttp' | 'trackerWs' | 'webseed'>): Buffer {
  // Keys must be sorted: announce < announce-list < info < url-list. The info dict is embedded
  // byte-for-byte so the infohash is exactly the stored one.
  const head = bencode.encode({ announce: urls.trackerHttp, 'announce-list': [[urls.trackerHttp], [urls.trackerWs]] });
  const urlList = bencode.encode([urls.webseed]);
  return Buffer.concat([
    head.subarray(0, head.length - 1),
    Buffer.from('4:info'),
    info,
    Buffer.from('8:url-list'),
    urlList,
    Buffer.from('e'),
  ]);
}

/** magnet: xt, dn, tr (https + wss), ws (webseed). No x.pe (peer addresses). */
export function buildMagnet(infoHash: string, name: string, urls: Pick<ShareUrls, 'trackerHttp' | 'trackerWs' | 'webseed'>): string {
  const q = [
    `xt=urn:btih:${infoHash}`,
    `dn=${encodeURIComponent(name)}`,
    `tr=${encodeURIComponent(urls.trackerHttp)}`,
    `tr=${encodeURIComponent(urls.trackerWs)}`,
    `ws=${encodeURIComponent(urls.webseed)}`,
  ];
  return `magnet:?${q.join('&')}`;
}

/** `Content-Disposition: attachment` for `<name>.torrent` with an ASCII fallback + RFC 5987 form. */
export function torrentContentDisposition(name: string): string {
  const clean = name.normalize('NFC').replace(/[\p{Cc}\p{Cf}"\\/]/gu, '_').trim() || 'download';
  const file = `${clean}.torrent`;
  const ascii = file.replace(/[^A-Za-z0-9 ._()+,-]/g, '_');
  const star = encodeURIComponent(file).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}
