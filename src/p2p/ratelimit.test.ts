import { describe, expect, it } from 'vitest';
import { Semaphore, UnlockRateLimiter } from './ratelimit.js';

describe('UnlockRateLimiter', () => {
  it('allows 5 failures per (share, IP) per 10 min', () => {
    let now = 1_000_000;
    const l = new UnlockRateLimiter(undefined, () => now);
    for (let i = 0; i < 5; i++) {
      expect(l.check('s1', '192.0.2.1').ok).toBe(true);
      l.recordFailure('s1', '192.0.2.1');
    }
    const r = l.check('s1', '192.0.2.1');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfter).toBe(600);
    // Other IP and other share unaffected.
    expect(l.check('s1', '192.0.2.2').ok).toBe(true);
    expect(l.check('s2', '192.0.2.1').ok).toBe(true);
    now += 10 * 60_000 + 1;
    expect(l.check('s1', '192.0.2.1').ok).toBe(true);
  });

  it('allows 50 failures per share per hour across IPs', () => {
    let now = 5_000_000;
    const l = new UnlockRateLimiter(undefined, () => now);
    for (let i = 0; i < 50; i++) {
      now += 1000;
      l.recordFailure('s', `198.51.100.${i}`);
    }
    const r = l.check('s', '203.0.113.200');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.retryAfter).toBeGreaterThan(3000);
    now += 60 * 60_000;
    expect(l.check('s', '203.0.113.200').ok).toBe(true);
  });

  it('undo removes a provisional failure (successful attempt)', () => {
    const l = new UnlockRateLimiter();
    for (let i = 0; i < 5; i++) l.recordFailure('s', '192.0.2.1')();
    expect(l.check('s', '192.0.2.1').ok).toBe(true);
  });

  it('prunes old entries', () => {
    let now = 0;
    const l = new UnlockRateLimiter(undefined, () => now);
    l.recordFailure('s', '192.0.2.1');
    now += 2 * 60 * 60_000;
    l.prune();
    expect((l as unknown as { perIp: Map<string, number[]> }).perIp.size).toBe(0);
  });

  it('does not keep raw IPs as keys', () => {
    const l = new UnlockRateLimiter();
    l.recordFailure('s', '192.0.2.77');
    const keys = [...(l as unknown as { perIp: Map<string, number[]> }).perIp.keys()].join();
    expect(keys).not.toContain('192.0.2.77');
  });
});

describe('Semaphore', () => {
  it('bounds concurrency and rejects when the queue is full', async () => {
    const s = new Semaphore(1, 1);
    const r1 = await s.acquire();
    const p2 = s.acquire();
    expect(await s.acquire()).toBeUndefined();
    r1!();
    const r2 = await p2;
    expect(r2).toBeTypeOf('function');
    r2!();
  });
});
