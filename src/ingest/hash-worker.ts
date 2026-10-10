// Source of the worker_threads hashing worker (SHA-1 pieces for a torrent v1 info dict).
//
// It is kept as a plain-JavaScript string and started with `new Worker(src, { eval: true })` so it
// runs identically from dist/ and from TypeScript sources under vitest (this Node build has no
// type stripping, and the build only compiles *.ts). It uses only node: built-ins.
//
// Memory is bounded to one piece buffer: files are read sequentially with readSync into it.
// Each file must match its expected size and mtime before and after reading; otherwise it fails.
// Messages: {type:'progress',done,total} | {type:'done',pieces,totalBytes} | {type:'error',message}.
export const HASH_WORKER_SOURCE = String.raw`
'use strict';
const { createHash } = require('node:crypto');
const { closeSync, constants, fstatSync, openSync, readSync } = require('node:fs');
const { parentPort, workerData } = require('node:worker_threads');

function run(job) {
  const pieceLength = job.pieceLength;
  const total = job.files.reduce((s, f) => s + f.size, 0);
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

  for (const f of job.files) {
    const fd = openSync(f.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size !== f.size || before.mtimeMs !== f.mtimeMs) {
        throw new Error('a file changed before hashing');
      }
      let remaining = f.size;
      let pos = 0;
      while (remaining > 0) {
        const want = Math.min(pieceLength - fill, remaining);
        const n = readSync(fd, buf, fill, want, pos);
        if (n <= 0) throw new Error('a file shrank during hashing');
        fill += n;
        pos += n;
        remaining -= n;
        done += n;
        if (fill === pieceLength) flush();
        const now = Date.now();
        if (now - lastReport >= 200) {
          lastReport = now;
          parentPort.postMessage({ type: 'progress', done, total });
        }
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
