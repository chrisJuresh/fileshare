// Optional WEBRTC_ANNOUNCE_IP support (docs/ARCHITECTURE.md §11): libdatachannel cannot be told its
// public address, so the tracker can append a host candidate `<ip> <WEBRTC_PORT> typ host` to SDPs it
// relays FROM THE SERVER'S OWN PEER. Off by default.
import { isIP } from 'node:net';

const FOUNDATION = 'fsinj';
// Host candidate priority: type preference 126, local preference 0x7fff, component 1.
const PRIORITY = (126 << 24) + (0x7fff << 8) + (256 - 1);

/**
 * Append an ICE host candidate for `ip:port` (UDP) to every media section of `sdp`.
 * Idempotent; returns the input unchanged if `ip`/`port` are invalid or the candidate exists.
 */
export function injectHostCandidate(sdp: string, ip: string, port: number): string {
  const family = isIP(ip);
  if (!family || !Number.isInteger(port) || port < 1 || port > 65535) return sdp;
  if (typeof sdp !== 'string' || sdp.length === 0) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(eol);
  const trailing = lines.length > 0 && lines[lines.length - 1] === '' ? lines.pop() : undefined;
  const candidate = `a=candidate:${FOUNDATION} 1 UDP ${PRIORITY} ${ip} ${port} typ host`;
  const exists = (sec: string[]): boolean =>
    sec.some((l) => {
      if (!l.startsWith('a=candidate:')) return false;
      const f = l.split(' ');
      return f[2]?.toUpperCase() === 'UDP' && f[4] === ip && f[5] === String(port);
    });

  // Split into session part + media sections.
  const sections: string[][] = [[]];
  for (const l of lines) {
    if (l.startsWith('m=')) sections.push([]);
    sections[sections.length - 1]!.push(l);
  }
  if (sections.length === 1) return sdp; // no media section
  for (let i = 1; i < sections.length; i++) {
    const sec = sections[i]!;
    if (exists(sec)) continue;
    const eoc = sec.findIndex((l) => l === 'a=end-of-candidates');
    if (eoc >= 0) sec.splice(eoc, 0, candidate);
    else sec.push(candidate);
  }
  const out = sections.flat();
  if (trailing !== undefined) out.push(trailing);
  return out.join(eol);
}

interface SdpHolder {
  type?: unknown;
  sdp?: unknown;
}

/**
 * Rewrite a raw WebSocket tracker message if (and only if) it is an announce from `serverPeerIdBin`
 * (the 20-byte peer id as a latin1 string, as on the wire) carrying an `answer` or `offers`.
 * Returns the original value untouched in every other case (including parse errors).
 */
export function rewriteServerSignal(raw: unknown, serverPeerIdBin: string, ip: string, port: number): unknown {
  const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : undefined;
  if (text === undefined || text.length > 256 * 1024) return raw;
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return raw;
  }
  if (!msg || typeof msg !== 'object' || msg.action !== 'announce' || msg.peer_id !== serverPeerIdBin) return raw;
  let changed = false;
  const fix = (h: unknown): void => {
    const o = h as SdpHolder | undefined;
    if (o && typeof o.sdp === 'string') {
      const next = injectHostCandidate(o.sdp, ip, port);
      if (next !== o.sdp) {
        o.sdp = next;
        changed = true;
      }
    }
  };
  if (msg.answer) fix(msg.answer);
  if (Array.isArray(msg.offers)) for (const o of msg.offers) fix((o as { offer?: unknown })?.offer);
  return changed ? JSON.stringify(msg) : raw;
}
