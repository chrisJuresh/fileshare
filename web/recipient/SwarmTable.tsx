import type { PeerKind } from '../../src/types.ts';
import { formatBytes, formatPercent, formatSpeed } from './format.ts';
import type { SwarmView } from './live.ts';

const KIND_LABEL: Record<PeerKind, string> = { server: 'Server', browser: 'Browser', client: 'Torrent app' };

export function SwarmTable({ swarm, connected }: { swarm: SwarmView | null; connected: boolean }) {
  return (
    <section class="card" aria-labelledby="swarm-h">
      <div class="card-head">
        <h2 id="swarm-h">Who's sharing</h2>
        <span class={connected ? 'live on' : 'live'} role="status">
          {connected ? 'Live' : 'Connecting…'}
        </span>
      </div>
      {!swarm || swarm.peers.length === 0 ? (
        <p class="muted">{connected ? 'Nobody else is here yet.' : 'Waiting for the live list…'}</p>
      ) : (
        <div class="table-wrap">
          <table class="swarm">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Progress</th>
                <th scope="col" class="opt">
                  Down
                </th>
                <th scope="col" class="opt">
                  Up
                </th>
                <th scope="col">Shared</th>
              </tr>
            </thead>
            <tbody>
              {swarm.peers.map((p) => {
                const you = p.id === swarm.you;
                return (
                  <tr key={p.id} class={you ? 'you' : undefined} aria-current={you ? 'true' : undefined}>
                    <td>
                      <span class="peer-name">{p.label}</span>
                      {you && <span class="you-tag"> (you)</span>}
                      <span class={`badge ${p.kind}`}>{KIND_LABEL[p.kind]}</span>
                    </td>
                    <td class="prog-cell">
                      <progress class="bar small" max={1} value={clamp(p.progress)} aria-label={`${p.label} progress`} />
                      <span class="pct">{formatPercent(clamp(p.progress))}</span>
                    </td>
                    <td class="opt num">{formatSpeed(p.down)}</td>
                    <td class="opt num">{formatSpeed(p.up)}</td>
                    <td class="num">{formatBytes(p.uploaded)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p class="muted small privacy-note">
        Downloads are shared directly between the people on this list, so they can see each other's IP
        address. We never store or show it here.
      </p>
    </section>
  );
}

function clamp(v: number): number {
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
}
