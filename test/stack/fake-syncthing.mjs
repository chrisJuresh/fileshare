// Minimal fake of the Syncthing REST calls the app makes (test stack fallback when Docker is not
// available): the folder is always idle, the PC always 100 % complete, nothing needed, no events.
// Real Syncthing (compose.test.yaml) is the default; this only keeps the app's ingest gate happy.
//
//   node test/stack/fake-syncthing.mjs <port> <api-key-file> <folder-id>
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const [port, keyFile, folder] = [Number(process.argv[2]), process.argv[3], process.argv[4]];
const apiKey = readFileSync(keyFile, 'utf8').trim();

const server = createServer((req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (u.pathname === '/rest/noauth/health') return send(200, { status: 'OK' });
  if (req.headers['x-api-key'] !== apiKey) return send(403, { error: 'forbidden' });
  const okFolder = u.searchParams.get('folder') === folder;
  switch (u.pathname) {
    case '/rest/db/status':
      return okFolder ? send(200, { state: 'idle', needFiles: 0, needBytes: 0 }) : send(404, {});
    case '/rest/db/completion':
      return okFolder ? send(200, { completion: 100, needBytes: 0, needItems: 0, needDeletes: 0 }) : send(404, {});
    case '/rest/db/need':
      return okFolder ? send(200, { progress: [], queued: [], rest: [], page: 1, perpage: 1000 }) : send(404, {});
    case '/rest/system/connections':
      return send(200, { connections: {} });
    case '/rest/events': {
      const t = setTimeout(() => send(200, []), Math.min(Number(u.searchParams.get('timeout') ?? '60'), 60) * 1000);
      req.on('close', () => clearTimeout(t));
      return;
    }
    default:
      return send(404, {});
  }
});
server.listen(port, '127.0.0.1', () => console.log(`fake syncthing on 127.0.0.1:${port}`));
const stop = () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
