// Stats & health tab: savings, downloads, upload now vs cap, snapshots, disks, Syncthing.
import { useEffect, useState } from 'preact/hooks';
import type { AdminLiveMsg, DiskStatus, StatsDto, StatusDto } from '../../src/types.ts';
import { api, errorMessage } from './api.ts';
import { fmtBytes, fmtDate, fmtPercent, fmtRate, fmtRelative } from './format.ts';
import { Progress, useNotify } from './ui.tsx';

function Card(props: { label: string; value: string; sub?: string; tone?: 'bad' | 'warn' | 'ok' }) {
  return (
    <div class={`card${props.tone ? ` card-${props.tone}` : ''}`}>
      <div class="card-label">{props.label}</div>
      <div class="card-value">{props.value}</div>
      {props.sub && <div class="card-sub">{props.sub}</div>}
    </div>
  );
}

function Disk(props: { d: DiskStatus }) {
  const d = props.d;
  return (
    <li class="disk">
      <div class="disk-head">
        <strong>{d.label}</strong>
        {d.mounted ? (
          <span class={d.warn ? 'warn-text' : 'muted'}>
            {fmtPercent(d.usedFraction)} used · {fmtBytes(d.free)} free of {fmtBytes(d.total)}
            {d.warn ? ' · over 85%' : ''}
          </span>
        ) : (
          <span class="muted">{d.note ?? 'not mounted'}</span>
        )}
      </div>
      {d.mounted && <Progress value={d.usedFraction} warn={d.warn} label={`${d.label} used`} />}
      {d.mounted && d.note && <div class="muted small">{d.note}</div>}
    </li>
  );
}

export function UploadMeter(props: { live: AdminLiveMsg | null; fallbackCap?: number }) {
  const cap = props.live?.upload.capBps ?? props.fallbackCap ?? 0;
  const cur = props.live?.upload.currentBps ?? 0;
  return (
    <div class="meter">
      <div class="meter-head">
        <span>Upload now</span>
        <span>
          <strong>{fmtRate(cur)}</strong> of {cap > 0 ? fmtRate(cap) : 'no cap'}
        </span>
      </div>
      <Progress value={cap > 0 ? cur / cap : 0} warn={cap > 0 && cur / cap > 0.95} label="Upload now versus cap" />
    </div>
  );
}

export function Health(props: { active: boolean; live: AdminLiveMsg | null }) {
  const [stats, setStats] = useState<StatsDto | null>(null);
  const [status, setStatus] = useState<StatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [snapBusy, setSnapBusy] = useState(false);
  const notify = useNotify();

  const load = async (): Promise<void> => {
    try {
      const [s, st] = await Promise.all([api<StatsDto>('GET', '/api/admin/stats'), api<StatusDto>('GET', '/api/admin/status')]);
      setStats(s);
      setStatus(st);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  useEffect(() => {
    if (!props.active) return;
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [props.active]);

  if (error && !stats) return <p class="form-error" role="alert">{error}</p>;
  if (!stats || !status) return <p class="muted">Loading…</p>;

  const r = status.restic;
  const peak = stats.shares.reduce((m, s) => Math.max(m, s.peakSwarm), 0);
  const backupTone = r.lastBackupOk === false ? 'bad' : r.lastBackupAt && Date.now() - r.lastBackupAt > 26 * 3600_000 ? 'warn' : undefined;

  return (
    <div class="stack">
      {error && <p class="form-error" role="alert">{error}</p>}
      <section aria-labelledby="h-transfer">
        <h2 id="h-transfer">Transfers</h2>
        <div class="cards">
          <Card
            label="Saved by peers"
            value={fmtBytes(stats.totals.peerBytes)}
            sub={`${fmtPercent(stats.totals.savedFraction)} of all data delivered`}
            tone={stats.totals.savedFraction > 0 ? 'ok' : undefined}
          />
          <Card label="Sent by server" value={fmtBytes(stats.totals.serverBytes)} />
          <Card label="Completed downloads" value={String(stats.totals.completedDownloads)} />
          <Card label="Peak swarm" value={String(peak)} sub="most peers at once, incl. server" />
        </div>
        <UploadMeter live={props.live} fallbackCap={stats.upload.capBps} />
        {stats.shares.length > 0 && (
          <div class="table-wrap">
            <table class="table table-compact">
              <caption class="sr-only">Per share</caption>
              <thead>
                <tr>
                  <th scope="col">Share</th>
                  <th scope="col" class="num">Downloads</th>
                  <th scope="col" class="num">Peak swarm</th>
                  <th scope="col" class="num">Server</th>
                  <th scope="col" class="num">Peers</th>
                  <th scope="col" class="num">Saved</th>
                  <th scope="col" class="hide-sm">Last activity</th>
                </tr>
              </thead>
              <tbody>
                {stats.shares.map((s) => {
                  const server = s.serverBytesP2p + s.serverBytesWebseed;
                  return (
                    <tr key={s.shareId}>
                      <td>{s.itemName}</td>
                      <td class="num">{s.completedDownloads}</td>
                      <td class="num">{s.peakSwarm}</td>
                      <td class="num">{fmtBytes(server)}</td>
                      <td class="num">{fmtBytes(s.peerBytes)}</td>
                      <td class="num">{fmtPercent(server + s.peerBytes > 0 ? s.peerBytes / (server + s.peerBytes) : null)}</td>
                      <td class="hide-sm">{fmtRelative(s.lastActivityAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="h-activity">
        <h2 id="h-activity">Recent recipients</h2>
        {stats.recent.length === 0 ? (
          <p class="muted">Nobody has opened a link yet.</p>
        ) : (
          <div class="table-wrap">
            <table class="table table-compact">
              <caption class="sr-only">Who opened links and finished downloads, newest first</caption>
              <thead>
                <tr>
                  <th scope="col">When</th>
                  <th scope="col">Name</th>
                  <th scope="col">What</th>
                  <th scope="col">Share</th>
                </tr>
              </thead>
              <tbody>
                {stats.recent.map((a, i) => (
                  <tr key={`${a.at}-${i}`}>
                    <td title={fmtDate(a.at)}>{fmtRelative(a.at)}</td>
                    <td>{a.name ?? <span class="muted">no name</span>}</td>
                    <td>{a.type === 'completed' ? 'Finished downloading' : 'Opened the link'}</td>
                    <td>{a.itemName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="h-snap">
        <h2 id="h-snap">Snapshots</h2>
        <div class="cards">
          <Card
            label="Last snapshot"
            value={r.lastBackupAt ? fmtRelative(r.lastBackupAt) : 'never'}
            sub={r.lastBackupOk === false ? 'latest run FAILED' : r.lastSnapshotId ? `id ${r.lastSnapshotId} · ${fmtDate(r.lastBackupAt)}` : undefined}
            tone={backupTone}
          />
          <Card
            label="Last integrity check"
            value={r.lastCheckAt ? fmtRelative(r.lastCheckAt) : 'never'}
            sub={r.lastCheckOk === false ? 'FAILED: see the runbook' : r.lastCheckOk ? 'passed' : undefined}
            tone={r.lastCheckOk === false ? 'bad' : r.lastCheckOk ? 'ok' : undefined}
          />
          <Card label="Pending requests" value={String(r.pendingRequests)} sub={r.paused ? 'paused (nightly window)' : undefined} />
          <Card label="Repository" value={r.repoInitialised ? 'initialised' : 'not initialised'} tone={r.repoInitialised ? undefined : 'warn'} />
        </div>
        <button
          type="button"
          class="btn"
          disabled={snapBusy}
          onClick={async () => {
            setSnapBusy(true);
            try {
              await api('POST', '/api/admin/snapshots');
              notify('Snapshot requested. It runs within a few minutes (not during the nightly pause).');
              void load();
            } catch (e) {
              notify(errorMessage(e), 'error');
            } finally {
              setSnapBusy(false);
            }
          }}
        >
          Snapshot now
        </button>
      </section>

      <section aria-labelledby="h-disks">
        <h2 id="h-disks">Disks</h2>
        <ul class="disks">
          {status.disks.map((d) => (
            <Disk key={d.label} d={d} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="h-sync">
        <h2 id="h-sync">PC sync (Syncthing)</h2>
        <div class="cards">
          <Card label="Syncthing" value={status.syncthing.reachable ? 'running' : 'unreachable'} tone={status.syncthing.reachable ? 'ok' : 'bad'} />
          <Card
            label="PC"
            value={status.syncthing.pcConnected === null ? 'unknown' : status.syncthing.pcConnected ? 'connected' : 'not connected'}
            sub={status.syncthing.pcConnected === null ? 'no PC paired yet' : undefined}
            tone={status.syncthing.pcConnected ? 'ok' : undefined}
          />
          <Card label="Outbox folder" value={status.syncthing.folderState ?? '–'} />
        </div>
      </section>
      <p class="muted small">fileshare {status.version}</p>
    </div>
  );
}
