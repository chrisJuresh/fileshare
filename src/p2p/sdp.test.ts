import { describe, expect, it } from 'vitest';
import { injectHostCandidate, rewriteServerSignal } from './sdp.js';

const SDP = [
  'v=0',
  'o=rtc 1 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:0',
  'a=ice-ufrag:abcd',
  'a=candidate:1 1 UDP 2114977791 10.0.0.5 6891 typ host',
  'a=end-of-candidates',
  '',
].join('\r\n');

describe('injectHostCandidate', () => {
  it('adds `<ip> <port> typ host` before end-of-candidates', () => {
    const out = injectHostCandidate(SDP, '192.0.2.10', 6891);
    const lines = out.split('\r\n');
    const i = lines.findIndex((l) => l.includes('192.0.2.10'));
    expect(lines[i]).toMatch(/^a=candidate:fsinj 1 UDP \d+ 192\.0\.2\.10 6891 typ host$/);
    expect(lines[i + 1]).toBe('a=end-of-candidates');
    expect(out.endsWith('\r\n')).toBe(true);
    expect(lines.filter((l) => l.startsWith('a=candidate')).length).toBe(2);
  });

  it('is idempotent and validates input', () => {
    const once = injectHostCandidate(SDP, '192.0.2.10', 6891);
    expect(injectHostCandidate(once, '192.0.2.10', 6891)).toBe(once);
    expect(injectHostCandidate(SDP, 'not-an-ip', 6891)).toBe(SDP);
    expect(injectHostCandidate(SDP, '192.0.2.10', 0)).toBe(SDP);
    expect(injectHostCandidate(SDP, '192.0.2.10\r\na=evil', 6891)).toBe(SDP);
    expect(injectHostCandidate('v=0\r\n', '192.0.2.10', 6891)).toBe('v=0\r\n');
  });

  it('handles LF-only SDP and IPv6', () => {
    const lf = SDP.replace(/\r\n/g, '\n');
    const out = injectHostCandidate(lf, '2001:db8::1', 6891);
    expect(out).toContain('2001:db8::1 6891 typ host');
    expect(out).not.toContain('\r');
  });
});

describe('rewriteServerSignal', () => {
  const serverBin = Buffer.from('-WW0300-serverpeerid').toString('latin1');
  const otherBin = Buffer.from('-WW0300-otherpeer123').toString('latin1');

  it('rewrites answers from the server peer only', () => {
    const msg = JSON.stringify({ action: 'announce', peer_id: serverBin, answer: { type: 'answer', sdp: SDP }, to_peer_id: otherBin });
    const out = rewriteServerSignal(msg, serverBin, '192.0.2.10', 6891) as string;
    expect(JSON.parse(out).answer.sdp).toContain('192.0.2.10 6891 typ host');
    const fromOther = JSON.stringify({ action: 'announce', peer_id: otherBin, answer: { type: 'answer', sdp: SDP } });
    expect(rewriteServerSignal(fromOther, serverBin, '192.0.2.10', 6891)).toBe(fromOther);
  });

  it('rewrites offers from the server peer and accepts Buffers', () => {
    const msg = Buffer.from(JSON.stringify({ action: 'announce', peer_id: serverBin, offers: [{ offer: { type: 'offer', sdp: SDP }, offer_id: 'x' }] }));
    const out = rewriteServerSignal(msg, serverBin, '192.0.2.10', 6891) as string;
    expect(JSON.parse(out).offers[0].offer.sdp).toContain('192.0.2.10');
  });

  it('passes through garbage untouched', () => {
    expect(rewriteServerSignal('not json', serverBin, '192.0.2.10', 6891)).toBe('not json');
    const plain = JSON.stringify({ action: 'announce', peer_id: serverBin, numwant: 0 });
    expect(rewriteServerSignal(plain, serverBin, '192.0.2.10', 6891)).toBe(plain);
  });
});
