// Shares tab: list, edit, revoke, copy link, a live swarm table per share, and adding library items
// to a shared folder (drop a dragged library row onto the share, or "Add from library").
import { Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { ItemDto, ShareDto, ShareEventDto, SwarmSnapshot } from '../../src/types.ts';
import { addableItems, canReceiveItems, useItemDrop, type AddItemsRequest } from './add-items.tsx';
import { api, errorMessage } from './api.ts';
import { fmtActivity, fmtBytes, fmtDate, fmtPercent, fmtRate, fmtRelative } from './format.ts';
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

const ACTIVITY_SHOWN = 50;

/** Who opened the link and who finished downloading, by the names recipients gave. */
function ShareActivity(props: { shareId: string; refreshKey: number }) {
  const [events, setEvents] = useState<ShareEventDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<ShareEventDto[]>('GET', `/api/admin/shares/${encodeURIComponent(props.shareId)}/events`).then(
      (e) => {
        if (cancelled) return;
        setEvents(e);
        setError(null);
      },
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [props.shareId, props.refreshKey]);

  if (error && !events) return <p class="form-error">{error}</p>;
  if (!events) return <p class="muted">Loading…</p>;
  const downloadedBy = [...new Set(events.filter((e) => e.type === 'completed' && e.name).map((e) => e.name as string))];
  const opened = [...new Set(events.filter((e) => e.type === 'unlocked' && e.name).map((e) => e.name as string))];
  const shown = events.slice(0, ACTIVITY_SHOWN);
  return (
    <div>
      <dl class="kv">
        <dt>Downloaded by</dt>
        <dd>{downloadedBy.length > 0 ? downloadedBy.join(', ') : '–'}</dd>
        <dt>Opened by</dt>
        <dd>{opened.length > 0 ? opened.join(', ') : '–'}</dd>
      </dl>
      <ul class="activity">
        {shown.map((e) => (
          <li key={e.id}>
            <span class="muted" title={fmtDate(e.at)}>
              {fmtRelative(e.at)}
            </span>{' '}
            {fmtActivity(e)}
          </li>
        ))}
      </ul>
      {events.length > shown.length && <p class="muted small">Showing the latest {shown.length} of {events.length}.</p>}
    </div>
  );
}

export function Shares(props: {
  shares: ShareDto[] | null;
  error: string | null;
  swarms: Record<string, SwarmSnapshot>;
  items: ItemDto[] | null;
  onChanged: () => void;
  onAddItems: (r: AddItemsRequest) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ShareDto | null>(null);
  const [revoking, setRevoking] = useState<ShareDto | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const notify = useNotify();
  const drop = useItemDrop((targetId, dragged) => props.onAddItems({ targetId, preselect: [dragged] }));
  const itemById = new Map((props.items ?? []).map((i) => [i.id, i]));

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
                const folder = itemById.get(s.itemId);
                const receives = s.state !== 'revoked' && canReceiveItems(folder);
                return (
                  <Fragment key={s.id}>
                    <tr class={drop.overKey === s.id ? 'drop-over' : undefined} {...drop.propsFor(s.id, receives ? s.itemId : undefined)}>
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
                        {receives && addableItems(props.items ?? [], folder!).length > 0 && (
                          <button
                            type="button"
                            class="btn btn-small"
                            onClick={() => props.onAddItems({ targetId: s.itemId, preselect: [] })}
                            aria-label={`Add library items to ${s.itemName}`}
                          >
                            Add from library
                          </button>
                        )}
                        {s.state === 'active' && s.hasPassword && (
                          <button
                            type="button"
                            class="btn btn-small"
                            title="Clear wrong-password lockouts for this link (all recipients)"
                            onClick={async () => {
                              try {
                                await api('POST', `/api/admin/shares/${encodeURIComponent(s.id)}/reset-limits`);
                                notify('Password attempt limits reset');
                              } catch (e) {
                                notify(errorMessage(e), 'error');
                              }
                            }}
                          >
                            Reset limits
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
                          <h3 class="h-small">Activity</h3>
                          <ShareActivity
                            shareId={s.id}
                            refreshKey={s.stats.completedDownloads + (s.stats.lastActivityAt ?? 0) + (live?.peers.length ?? 0)}
                          />
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
