// Workaround: the server's WebRTC answers were sent ~5 s late.
//
// The seeder's WebRTC peers are simple-peer (lite) instances created by bittorrent-tracker with
// `trickle: false`, so simple-peer waits for "ICE gathering complete" before it sends the answer. It
// only recognises that from an `icecandidate` event with a null candidate. webrtc-polyfill
// (node-datachannel) never dispatches that event; it does fire `icegatheringstatechange` with
// `iceGatheringState === 'complete'`, which simple-peer ignores. So every answer waited for
// simple-peer's fallback timer (5 s after the first candidate).
//
// This patch makes simple-peer also treat `iceGatheringState === 'complete'` as the end of gathering,
// once the local description carries at least one candidate (node-datachannel may report
// "complete" before the candidate events are delivered). It changes nothing for peers that do get the
// null candidate, and the 5 s fallback stays in place. Only server-side (Node) peers are affected.
// @ts-ignore untyped package (pinned in package.json; the same module instance webtorrent and
// bittorrent-tracker import)
import PeerImpl from '@thaunknown/simple-peer/lite.js';

interface SimplePeerInternals {
  destroyed: boolean;
  trickle: boolean;
  _iceComplete: boolean;
  _pc?: { iceGatheringState?: string; localDescription?: { sdp?: string } | null } | null;
  emit(event: string): void;
  _onIceStateChange(...args: unknown[]): void;
  _onIceCandidate(...args: unknown[]): void;
}

const Peer = PeerImpl as { prototype: SimplePeerInternals };
const PATCHED = Symbol.for('fileshare.iceGatheringFix');

function maybeComplete(p: SimplePeerInternals): void {
  if (p.destroyed || p.trickle || p._iceComplete) return;
  const pc = p._pc;
  if (!pc || pc.iceGatheringState !== 'complete') return;
  if (!/^a=candidate:/m.test(pc.localDescription?.sdp ?? '')) return;
  p._iceComplete = true;
  p.emit('_iceComplete');
}

/** Idempotent. Call before any WebRTC peer is created. */
export function installIceGatheringFix(): void {
  const proto = Peer.prototype as SimplePeerInternals & { [PATCHED]?: true };
  if (proto[PATCHED]) return;
  const onState = proto._onIceStateChange;
  const onCandidate = proto._onIceCandidate;
  proto._onIceStateChange = function (this: SimplePeerInternals, ...args: unknown[]) {
    onState.apply(this, args);
    maybeComplete(this);
  };
  proto._onIceCandidate = function (this: SimplePeerInternals, ...args: unknown[]) {
    onCandidate.apply(this, args);
    maybeComplete(this);
  };
  proto[PATCHED] = true;
}
