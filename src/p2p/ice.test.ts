// simple-peer (trickle:false, as bittorrent-tracker uses it) over webrtc-polyfill: without the fix the
// answer waits for simple-peer's 5 s ICE fallback timer; with it, it goes out as soon as gathering
// is complete.
import { describe, expect, it } from 'vitest';
// @ts-ignore untyped package
import Peer from '@thaunknown/simple-peer/lite.js';
import { installIceGatheringFix } from './ice.js';

interface P {
  on(ev: string, fn: (...a: any[]) => void): void;
  once(ev: string, fn: (...a: any[]) => void): void;
  signal(data: unknown): void;
  destroy(): void;
}

/** ms from handing the offer to the answerer until it emits its answer; also waits for 'connect'. */
async function answerDelay(): Promise<{ ms: number; sdp: string }> {
  const a = new Peer({ initiator: true, trickle: false, config: { iceServers: [] } }) as P;
  const b = new Peer({ trickle: false, config: { iceServers: [] } }) as P;
  try {
    const offer = await new Promise<unknown>((resolve) => a.once('signal', resolve));
    const t0 = Date.now();
    const answerP = new Promise<{ sdp: string }>((resolve) => b.once('signal', resolve));
    b.signal(offer);
    const answer = await answerP;
    const ms = Date.now() - t0;
    const connected = Promise.all([new Promise((r) => a.once('connect', r)), new Promise((r) => b.once('connect', r))]);
    a.signal(answer);
    await connected;
    return { ms, sdp: answer.sdp };
  } finally {
    a.destroy();
    b.destroy();
  }
}

describe('ICE gathering fix for server-side simple-peer', () => {
  it('answers without waiting for the 5 s fallback, with candidates, and connects', async () => {
    // Unpatched first (module-level patch is process-wide and idempotent).
    const before = await answerDelay();
    installIceGatheringFix();
    installIceGatheringFix();
    const after = await answerDelay();
    expect(before.ms).toBeGreaterThanOrEqual(4000);
    expect(after.ms).toBeLessThan(1500);
    expect(after.sdp).toMatch(/^a=candidate:/m);
  }, 30_000);
});
