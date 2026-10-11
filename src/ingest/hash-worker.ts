// Source of the worker_threads hashing worker (SHA-1 pieces for a torrent v1 info dict).
//
// It is kept as a plain-JavaScript string and started with `new Worker(src, { eval: true })` so it
// runs identically from dist/ and from TypeScript sources under vitest (this Node build has no
// type stripping, and the build only compiles *.ts). It uses only node: built-ins.
//
// Memory is bounded to one piece buffer: files are read sequentially with readSync into it.
// Each file must match its expected size and mtime before and after reading; otherwise it fails.
// A job entry is a file ({path, size, mtimeMs, start?, length?}: `length` bytes from `start`, by
// default the whole file) or a run of zero bytes ({zeros}: a BEP 47 pad file).
// Messages: {type:'progress',done,total} | {type:'done',pieces,totalBytes} | {type:'error',message}.
export const HASH_WORKER_SOURCE = String.raw`
'use strict';
const { createHash } = require('node:crypto');
const { closeSync, constants, fstatSync, openSync, readSync } = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');

function run(job) {
  const pieceLength = job.pieceLength;
  const span = (f) => (f.zeros !== undefined ? f.zeros : f.length !== undefined ? f.length : f.size);
  const total = job.files.reduce((s, f) => s + span(f), 0);
  const numPieces = Math.ceil(total / pieceLength);
  const pieces = new Uint8Array(numPieces * 20);
  const buf = Buffer.allocUnsafe(pieceLength);
  let fill = 0;
  let pieceIndex = 0;
  let done = 0;
  let lastReport = 0;

  function flush() {
    const digest = createHash('sha1').update(buf.subarray(0, fill)).digest();
    pieces.set(digest, pieceIndex * 20);
    pieceIndex++;
    fill = 0;
  }

  function progress() {
    const now = Date.now();
    if (now - lastReport >= 200) {
      lastReport = now;
      parentPort.postMessage({ type: 'progress', done, total });
    }
  }

  for (const f of job.files) {
    if (f.zeros !== undefined) {
      let remaining = f.zeros;
      while (remaining > 0) {
        const n = Math.min(pieceLength - fill, remaining);
        buf.fill(0, fill, fill + n);
        fill += n;
        remaining -= n;
        done += n;
        if (fill === pieceLength) flush();
        progress();
      }
      continue;
    }
    const start = f.start || 0;
    const length = span(f);
    if (start < 0 || start + length > f.size) throw new Error('bad file range');
    const fd = openSync(f.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size !== f.size || before.mtimeMs !== f.mtimeMs) {
        throw new Error('a file changed before hashing');
      }
      let remaining = length;
      let pos = start;
      while (remaining > 0) {
        const want = Math.min(pieceLength - fill, remaining);
        const n = readSync(fd, buf, fill, want, pos);
        if (n <= 0) throw new Error('a file shrank during hashing');
        fill += n;
        pos += n;
        remaining -= n;
        done += n;
        if (fill === pieceLength) flush();
        progress();
      }
      const after = fstatSync(fd);
      if (after.size !== f.size || after.mtimeMs !== f.mtimeMs) throw new Error('a file changed during hashing');
    } finally {
      closeSync(fd);
    }
  }
  if (fill > 0) flush();
  if (pieceIndex !== numPieces) throw new Error('piece count mismatch');
  parentPort.postMessage({ type: 'progress', done, total });
  parentPort.postMessage({ type: 'done', pieces, totalBytes: done }, [pieces.buffer]);
}

try {
  run(workerData);
} catch (err) {
  // System errors carry full paths in their message; report only the code.
  const code = err && typeof err.code === 'string' ? err.code : undefined;
  const message = code ? 'I/O error while hashing (' + code + ')' : (err && err.message) || 'hashing failed';
  parentPort.postMessage({ type: 'error', message });
}
`;
