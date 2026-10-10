// Minimal reader for STORED (uncompressed) zip files, as produced by client-zip, incl. ZIP64 records.
// Test helper only: returns sha256 per entry name.
import { createHash } from 'node:crypto';

export function storedZipHashes(buf: Buffer): Record<string, string> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('no end of central directory');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const loc = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), eocd);
    const z64 = Number(buf.readBigUInt64LE(loc + 8));
    count = Number(buf.readBigUInt64LE(z64 + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
  }
  const out: Record<string, string> = {};
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    let size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // ZIP64 extra field (id 0x0001): sizes/offset that overflowed, in order.
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (buf.readUInt32LE(p + 24) === 0xffffffff) q += 8; // uncompressed
        if (size === 0xffffffff) {
          size = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (localOffset === 0xffffffff) localOffset = Number(buf.readBigUInt64LE(q));
      }
      e += 4 + len;
    }
    if (method !== 0) throw new Error('only stored entries supported');
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header');
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    if (!name.endsWith('/')) out[name] = createHash('sha256').update(buf.subarray(dataStart, dataStart + size)).digest('hex');
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
