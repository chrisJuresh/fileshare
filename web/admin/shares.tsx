// Shares tab: list, edit, revoke, copy link, and a live swarm table per share.
import { Fragment } from 'preact';
import { useState } from 'preact/hooks';
import type { ShareDto, SwarmSnapshot } from '../../src/types.ts';
import { api } from './api.ts';
import { fmtBytes, fmtDate, fmtPercent, fmtRate, fmtRelative } from './format.ts';
import { EditShareDialog } from './share-dialog.tsx';
import { ConfirmDialog, CopyButton, Progress, useNotify } from './ui.tsx';

const KIND_LABEL = { server: 'Server', browser: 'Browser', client: 'Torrent client' } as const;

function SwarmTable(props: { swarm: SwarmSnapshot | undefined }) {
  if (!props.swarm || props.swarm.peers.length === 0) {
    return <p class="muted">Nobody is connected right now.</p>;
  }
  return (
    <div class="table-wrap">
      <table class="table table-compact">
        <caption class="sr-only">Live swarm</caption>
        <thead>
          <tr>
            <th scope="col">Peer</th>
            <th scope="col">Kind</th>
            <th scope="col">Progress</th>
            <th scope="col" class="num">Down</th>
            <th scope="col" class="num">Up</th>
            <th scope="col" class="num">Uploaded</th>
          </tr>
        </thead>
        <tbody>
          {props.swarm.peers.map((p) => (
            <tr key={p.id}>
              <td>{p.label}</td>
              <td>{KIND_LABEL[p.kind] ?? p.kind}</td>
              <td class="progress-cell">
                <Progress value={p.progress} label={`${p.label} progress`} />
                <span class="muted">{fmtPercent(p.progress)}</span>
              </td>
              <td class="num">{fmtRate(p.down)}</td>
              <td class="num">{fmtRate(p.up)}</td>
              <td class="num">{fmtBytes(p.uploaded)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="muted small">
        {props.swarm.totals.peers} in swarm · from server {fmtBytes(props.swarm.totals.serverBytes)} · between peers{' '}
        {fmtBytes(props.swarm.totals.peerBytes)} · {props.swarm.totals.completed} completed
      </p>
    </div>
  );
}

export function Shares(props: {
  shares: ShareDto[] | null;
  error: string | null;
  swarms: Record<string, SwarmSnapshot>;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ShareDto | null>(null);
  const [revoking, setRevoking] = useState<ShareDto | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const notify = useNotify();

  if (props.error) return <p class="form-error" role="alert">{props.error}</p>;
  if (!props.shares) return <p class="muted">Loading…</p>;

  const visible = props.shares.filter((s) => showInactive || s.state === 'active');
  const inactiveCount = props.shares.length - props.shares.filter((s) => s.state === 'active').length;
  const toggle = (id: string): void => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  return (
    <>
      <div class="toolbar">
        <label class="check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive((e.target as HTMLInputElement).checked)} />
          Show expired and revoked ({inactiveCount})
        </label>
      </div>
      {visible.length === 0 ? (
        <div class="empty">
          <p>No {showInactive ? '' : 'active '}shares.</p>
          <p class="muted">Create one from the Library tab.</p>
        </div>
      ) : (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">State</th>
                <th scope="col" class="hide-sm">Password</th>
                <th scope="col">Expires</th>
                <th scope="col" class="hide-sm">Created</th>
                <th scope="col" class="num">Downloads</th>
                <th scope="col" class="num hide-sm">Saved</th>
                <th scope="col">
                  <span class="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((s) => {
                const live = props.swarms[s.id];
                const server = s.stats.serverBytesWebseed + s.stats.serverBytesP2p;
                const saved = s.stats.peerBytes + server > 0 ? s.stats.peerBytes / (s.stats.peerBytes + server) : null;
                const open = expanded.has(s.id);
                return (
                  <Fragment key={s.id}>
                    <tr>
                      <td>
                        <button type="button" class="btn-link" aria-expanded={open} onClick={() => toggle(s.id)}>
                          <span aria-hidden="true">{open ? '▾' : '▸'}</span> {s.itemName}
                        </button>
                        {s.torrentName !== s.itemName && <div class="muted small">as “{s.torrentName}”</div>}
                        {live && live.totals.peers > 1 && <span class="pill pill-live">{live.totals.peers - 1} connected</span>}
                      </td>
                      <td>
                        <span class={`badge badge-share-${s.state}`}>{s.state}</span>
                      </td>
                      <td class="hide-sm">{s.hasPassword ? 'Yes' : 'No'}</td>
                      <td title={s.expiresAt ? fmtDate(s.expiresAt) : undefined}>{s.expiresAt ? fmtRelative(s.expiresAt) : 'Never'}</td>
                      <td class="hide-sm">{fmtDate(s.createdAt)}</td>
                      <td class="num">{s.stats.completedDownloads}</td>
                      <td class="num hide-sm">{fmtPercent(saved)}</td>
                      <td class="actions-cell">
<div class="row-actions">
                        {s.state !== 'revoked' && <CopyButton text={s.url} label="Copy link" />}
                        {s.state !== 'revoked' && (
                          <button type="button" class="btn btn-small" onClick={() => setEditing(s)}>
                            Edit
                          </button>
                        )}
                        {s.state !== 'revoked' && (
                          <button type="button" class="btn btn-small btn-danger-outline" onClick={() => setRevoking(s)}>
                            Revoke
                          </button>
                        )}
                      </div>
</td>
                    </tr>
                    {open && (
                      <tr class="detail-row">
                        <td colSpan={8}>
                          <div class="detail-grid">
                            <div>
                              <h3 class="h-small">Live swarm</h3>
                              <SwarmTable swarm={live} />
                            </div>
                            <dl class="kv">
                              <dt>Link</dt>
                              <dd class="mono break">{s.url}</dd>
                              <dt>Served by server</dt>
                              <dd>
                                {fmtBytes(server)} (webseed {fmtBytes(s.stats.serverBytesWebseed)}, P2P {fmtBytes(s.stats.serverBytesP2p)})
                              </dd>
                              <dt>Shared between peers</dt>
                              <dd>{fmtBytes(s.stats.peerBytes)}</dd>
                              <dt>Peak swarm</dt>
                              <dd>{s.stats.peakSwarm}</dd>
                              <dt>Last activity</dt>
                              <dd>{fmtRelative(s.stats.lastActivityAt)}</dd>
                              {s.revokedAt && (
                                <>
                                  <dt>Revoked</dt>
                                  <dd>{fmtDate(s.revokedAt)}</dd>
                                </>
                              )}
                            </dl>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <EditShareDialog
        share={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          notify('Share updated');
          props.onChanged();
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        title="Revoke link?"
        danger
        confirmLabel="Revoke link"
        message={
          revoking && (
            <p>
              Revoke the link for <strong>{revoking.itemName}</strong>? It stops working immediately for everyone, including
              downloads in progress. This cannot be undone; you can create a new link later.
            </p>
          )
        }
        onClose={() => setRevoking(null)}
        onConfirm={async () => {
          if (!revoking) return;
          await api('POST', `/api/admin/shares/${encodeURIComponent(revoking.id)}/revoke`);
          notify('Link revoked');
          props.onChanged();
        }}
      />
    </>
  );
}
