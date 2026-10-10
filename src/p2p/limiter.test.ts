import { randomBytes } from 'node:crypto';
import { pipeline, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Limiter, RateMeter } from './limiter.js';

function pump(limiter: Limiter, bytes: number): Promise<{ ms: number; got: number }> {
  const t0 = Date.now();
  let got = 0;
  const data = randomBytes(bytes);
  const src = Readable.from((function* () {
    for (let i = 0; i < data.length; i += 16 * 1024) yield data.subarray(i, i + 16 * 1024);
  })());
  const sink = new Writable({
    write(chunk: Buffer, _e, cb) {
      got += chunk.length;
      cb();
    },
  });
  return new Promise((resolve, reject) =>
    pipeline(src, limiter.throttle(), sink, (err) => (err ? reject(err) : resolve({ ms: Date.now() - t0, got }))),
  );
}

describe('RateMeter', () => {
  it('averages over a 2 s window', () => {
    let now = 10_000;
    const m = new RateMeter(2000, 100, () => now);
    m.add(1000);
    now += 500;
    m.add(1000);
    expect(m.rate()).toBe(1000); // 2000 bytes / 2 s
    now += 1600; // first sample has left the window
    expect(m.rate()).toBe(500);
    now += 3000;
    expect(m.rate()).toBe(0);
  });
});

describe('Limiter', () => {
  it('is unlimited until a rate is set', async () => {
    const l = new Limiter();
    expect(l.rate()).toBeNull();
    const r = await pump(l, 2 * 1024 * 1024);
    expect(r.got).toBe(2 * 1024 * 1024);
    expect(r.ms).toBeLessThan(1000);
  });

  it('throttles to the rate (after the 1 s burst)', async () => {
    const l = new Limiter();
    l.setRate(400 * 1024);
    // Bucket starts empty: 800 KiB at 400 KiB/s ≈ 2 s.
    const r = await pump(l, 800 * 1024);
    expect(r.got).toBe(800 * 1024);
    expect(r.ms).toBeGreaterThan(1700);
    expect(r.ms).toBeLessThan(3500);
  });

  it('shares ONE bucket between concurrent throttles', async () => {
    const l = new Limiter();
    l.setRate(400 * 1024);
    const t0 = Date.now();
    await Promise.all([pump(l, 400 * 1024), pump(l, 400 * 1024)]);
    expect(Date.now() - t0).toBeGreaterThan(1700);
  });

  it('applies rate changes live and can be lifted', async () => {
    const l = new Limiter();
    l.setRate(50 * 1024);
    const p = pump(l, 1024 * 1024);
    await new Promise((r) => setTimeout(r, 300));
    l.setRate(Number.POSITIVE_INFINITY); // unlimited
    const r = await p;
    expect(r.got).toBe(1024 * 1024);
    expect(r.ms).toBeLessThan(1500);
    expect(l.rate()).toBeNull();
  });

  it('destroying a waiting throttle does not hang or leak', async () => {
    const l = new Limiter();
    l.setRate(1024);
    const t = l.throttle();
    t.write(randomBytes(64 * 1024));
    await new Promise((r) => setTimeout(r, 50));
    const closed = new Promise((r) => t.on('close', r));
    t.destroy();
    await closed;
    expect(t.destroyed).toBe(true);
  });

  it('currentBps reflects recorded bytes', () => {
    const l = new Limiter();
    l.record(4000);
    expect(l.currentBps()).toBe(2000);
  });
});
