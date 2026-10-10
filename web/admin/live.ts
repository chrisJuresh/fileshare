// Admin live stream (wss://<admin>/api/admin/live), reconnecting with backoff.
import { useEffect, useState } from 'preact/hooks';
import type { AdminLiveMsg } from '../../src/types.ts';

export function useLive(): { msg: AdminLiveMsg | null; connected: boolean } {
  const [msg, setMsg] = useState<AdminLiveMsg | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let ws: WebSocket | undefined;
    let stopped = false;
    let delay = 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = (): void => {
      const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/admin/live`;
      ws = new WebSocket(url);
      ws.onopen = () => {
        delay = 1000;
        setConnected(true);
      };
      ws.onmessage = (ev) => {
        try {
          const m = JSON.parse(String(ev.data)) as AdminLiveMsg;
          if (m && m.t === 'live') setMsg(m);
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (stopped) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30_000);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, []);
  return { msg, connected };
}
