// Settings tab: upload cap (Mbit/s) with the measured capacity and a "90 % of measured" reset.
import { useEffect, useId, useState } from 'preact/hooks';
import type { AdminLiveMsg, SettingsDto } from '../../src/types.ts';
import { api, errorMessage } from './api.ts';
import { bpsToMbps, fmtDate, fmtRate, mbpsToBps } from './format.ts';
import { UploadMeter } from './health.tsx';
import { useNotify } from './ui.tsx';

const MIN_BPS = 1024;
const MAX_BPS = 10_000_000_000;

const round1 = (n: number): string => (Math.round(n * 10) / 10).toString();

export function Settings(props: { active: boolean; live: AdminLiveMsg | null }) {
  const [s, setS] = useState<SettingsDto | null>(null);
  const [mbps, setMbps] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notify = useNotify();
  const inputId = useId();
  const hintId = useId();

  const load = async (): Promise<void> => {
    try {
      const r = await api<SettingsDto>('GET', '/api/admin/settings');
      setS(r);
      setMbps(r.uploadCapBps > 0 ? round1(bpsToMbps(r.uploadCapBps)) : '');
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  useEffect(() => {
    if (props.active) void load();
  }, [props.active]);

  const save = async (bps: number): Promise<void> => {
    if (!Number.isFinite(bps) || bps < MIN_BPS || bps > MAX_BPS) {
      setError(`Enter a cap between ${round1(bpsToMbps(MIN_BPS) * 1000)} kbit/s and ${bpsToMbps(MAX_BPS)} Mbit/s.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<SettingsDto>('PUT', '/api/admin/settings', { uploadCapBps: bps });
      setS(r);
      setMbps(round1(bpsToMbps(r.uploadCapBps)));
      notify(`Upload cap set to ${fmtRate(r.uploadCapBps)}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!s) return error ? <p class="form-error">{error}</p> : <p class="muted">Loading…</p>;
  const ninety = s.uploadCapacityBps ? Math.floor(0.9 * s.uploadCapacityBps) : null;

  return (
    <div class="stack narrow">
      <section aria-labelledby="h-cap">
        <h2 id="h-cap">Upload cap</h2>
        <p class="muted">
          Limits everything the server uploads (P2P seeding and the HTTP fallback) so your home connection stays usable.
        </p>
        <form
          class="cap-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save(mbpsToBps(Number(mbps)));
          }}
        >
          <label for={inputId}>Cap</label>
          <div class="input-unit">
            <input
              id={inputId}
              type="number"
              inputMode="decimal"
              min={0.01}
              step="any"
              required
              value={mbps}
              aria-describedby={hintId}
              onInput={(e) => setMbps((e.target as HTMLInputElement).value)}
            />
            <span>Mbit/s</span>
          </div>
          <button type="submit" class="btn btn-primary" disabled={busy}>
            Save
          </button>
        </form>
        <p id={hintId} class="hint">
          {s.uploadCapacityBps
            ? `Measured upload capacity: ${fmtRate(s.uploadCapacityBps)} (${fmtDate(s.uploadMeasuredAt)}).`
            : 'Upload capacity has not been measured yet (run the speed test, see the runbook).'}
          {s.uploadCapBps === 0 && ' No cap is set yet.'}
        </p>
        {ninety !== null && (
          <button type="button" class="btn" disabled={busy || ninety === s.uploadCapBps} onClick={() => void save(ninety)}>
            Reset to 90% of measured ({fmtRate(ninety)})
          </button>
        )}
        {error && <p class="form-error" role="alert">{error}</p>}
      </section>
      <section aria-labelledby="h-now">
        <h2 id="h-now">Right now</h2>
        <UploadMeter live={props.live} fallbackCap={s.uploadCapBps} />
      </section>
    </div>
  );
}
