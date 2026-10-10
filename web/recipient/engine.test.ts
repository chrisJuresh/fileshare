// skipOwnedPiecesInRarestSearch: WebTorrent's rarest-first search must never be handed pieces we
// already have (each one cost a full O(pieces) re-scan in trySelectWire; quadratic on big torrents).
import { describe, expect, it } from 'vitest';
import { skipOwnedPiecesInRarestSearch } from './engine.ts';
import type { WtTorrent } from './wt-types.ts';

/** Minimal copy of webtorrent 3.0.21 lib/rarity-map.js getRarestPiece over a fixed availability array. */
function rarityMap(availability: number[]) {
  return {
    scans: 0,
    getRarestPiece(filter?: (i: number) => boolean): number {
      this.scans++;
      let best = -1;
      let min = Infinity;
      for (let i = 0; i < availability.length; i++) {
        if (filter && !filter(i)) continue;
        if (availability[i]! < min) {
          min = availability[i]!;
          best = i;
        }
      }
      return best;
    },
  };
}

describe('skipOwnedPiecesInRarestSearch', () => {
  it('never returns a piece we have, and keeps the caller filter', () => {
    const n = 2000;
    const have = new Set<number>();
    for (let i = 0; i < 1500; i++) have.add(i); // the rarest pieces are the ones we already have
    const rm = rarityMap(Array.from({ length: n }, (_, i) => (i < 1500 ? 1 : 3)));
    const torrent = { _rarityMap: rm, bitfield: { get: (i: number) => have.has(i) } } as unknown as WtTorrent;

    skipOwnedPiecesInRarestSearch(torrent);
    const p = rm.getRarestPiece((i) => i !== 1500);
    expect(p).toBeGreaterThan(1500);
    expect(have.has(p)).toBe(false);
    // The trySelectWire pattern ("pick rarest, reject, mark tried, repeat") now needs one scan, not 1500.
    rm.scans = 0;
    const tried = new Set<number>();
    let piece = -1;
    for (;;) {
      piece = rm.getRarestPiece((i) => !tried.has(i));
      if (piece < 0 || !have.has(piece)) break;
      tried.add(piece);
    }
    expect(rm.scans).toBe(1);
    have.clear();
    expect(rm.getRarestPiece()).toBe(0);
  });

  it('is a no-op without a rarity map', () => {
    expect(() => skipOwnedPiecesInRarestSearch({ bitfield: null } as unknown as WtTorrent)).not.toThrow();
  });
});
