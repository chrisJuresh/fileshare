// Local stand-in for Cloudflare Access's certs endpoint (test stack only).
// Generates a throwaway RS256 key pair on every start, serves the public JWKS at
// /cdn-cgi/access/certs on 127.0.0.1:<port>, and writes the private JWK (mode 600) to <out> so tests
// can sign admin JWTs. Nothing here is a real credential.
//
//   node test/stack/jwks-server.mjs <port> <out.json>
import { exportJWK, generateKeyPair } from 'jose';
import { writeFileSync, renameSync } from 'node:fs';
import { createServer } from 'node:http';

const port = Number(process.argv[2]);
const out = process.argv[3];
if (!Number.isInteger(port) || !out) {
  console.error('usage: jwks-server.mjs <port> <out.json>');
  process.exit(2);
}

const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
const kid = `fileshare-test-${Date.now().toString(36)}`;
const pub = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
const priv = { ...(await exportJWK(privateKey)), kid, alg: 'RS256' };
writeFileSync(`${out}.tmp`, JSON.stringify(priv), { mode: 0o600 });
renameSync(`${out}.tmp`, out);

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/cdn-cgi/access/certs') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ keys: [pub] }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(port, '127.0.0.1', () => console.log(`jwks listening on 127.0.0.1:${port}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
