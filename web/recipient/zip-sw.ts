// Service worker for streamed "Download all" zips (Firefox/Safari, which lack showDirectoryPicker).
// Built to /vendor/fs-zip-sw.js and registered with scope /vendor/fszip/ (inside its own directory, so
// no Service-Worker-Allowed header is needed). It holds no state: on a request for
// /vendor/fszip/<id>/<name> it asks the page that owns <id> for the bytes over a MessageChannel and
// pulls them one chunk at a time (bounded memory, backpressure from the browser's download).

const sw = self as unknown as ServiceWorkerGlobalScope;
const START_TIMEOUT_MS = 15_000;
const CHUNK_TIMEOUT_MS = 10 * 60_000;

sw.addEventListener('install', () => {
  void sw.skipWaiting();
});
sw.addEventListener('activate', (event) => {
  event.waitUntil(sw.clients.claim());
});
sw.addEventListener('message', () => {
  // keep-alive pings from the page while a zip is streaming; receiving the event is enough
});

sw.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const scope = new URL(sw.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;
  const rest = url.pathname.slice(scope.pathname.length);
  const m = /^([0-9a-f-]{36})\/([^/]+)$/.exec(rest);
  if (!m || event.request.method !== 'GET') {
    event.respondWith(new Response('Not found', { status: 404 }));
    return;
  }
  event.respondWith(serve(m[1] as string, decodeURIComponent(m[2] as string)));
});

interface Header {
  ok: true;
  name: string;
  size: string;
}

async function serve(id: string, fallbackName: string): Promise<Response> {
  const clients = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const answer = await new Promise<{ header: Header; port: MessagePort } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), START_TIMEOUT_MS);
    for (const client of clients) {
      const { port1, port2 } = new MessageChannel();
      port1.onmessage = (ev: MessageEvent) => {
        const d = ev.data as Partial<Header> | null;
        if (d && d.ok === true && typeof d.size === 'string') {
          clearTimeout(timer);
          resolve({ header: d as Header, port: port1 });
        }
      };
      client.postMessage({ type: 'fileshare-zip', id }, [port2]);
    }
  });
  if (!answer) return new Response('This download has expired. Please start it again from the page.', { status: 404 });

  const { header, port } = answer;
  const name = (header.name || fallbackName).replace(/[\u0000-\u001f"\\/]/g, '_');
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        return new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            controller.error(new Error('timeout'));
            resolve();
          }, CHUNK_TIMEOUT_MS);
          port.onmessage = (ev: MessageEvent) => {
            clearTimeout(timer);
            const d = ev.data as unknown;
            if (d instanceof Uint8Array) controller.enqueue(d);
            else if (d === null) {
              controller.close();
              port.close();
            } else controller.error(new Error('source failed'));
            resolve();
          };
          port.postMessage('pull');
        });
      },
      cancel() {
        port.postMessage('cancel');
        port.close();
      },
    },
    { highWaterMark: 1 },
  );
  const headers = new Headers({
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (/^\d+$/.test(header.size)) headers.set('Content-Length', header.size);
  return new Response(body, { status: 200, headers });
}
