# fileshare — guide for agents working on this code

Self-hosted file share. Files arrive from a PC via Syncthing (or web upload), become **library
items** (hashed into a private torrent, snapshotted with restic), and can be **shared** as links.
Recipients download in the browser over WebTorrent (P2P between recipients, the server seeds),
with a capped HTTP webseed fallback.

## Read first
- `docs/ARCHITECTURE.md` — **the contract**: layout, SQLite schema, routes per listener, token
  format, WebSocket schema, ingest state machine, module interfaces. Keep it in sync with code.
- `docs/RUNBOOK.md` — operating, restoring, rotating secrets, troubleshooting.
- `docs/HOST-CHANGES.md` — every change made outside this repo on the host, and how to revert it.
- `docs/USER-ACTIONS.md` — steps only a human can do (router, Cloudflare).
- `docs/pc-setup.md` — Windows PC side (fetched from `main` by the PC setup session).

## Layout
- `src/` — Node 22 + TypeScript (ESM). `main.ts` = app, `backup/main.ts` = restic runner, `cli.ts`.
  Modules: `ingest/`, `p2p/`, `admin/`, `backup/`, `server/` (two Fastify listeners), `core/`, `db/`.
- `web/recipient`, `web/admin` — Preact frontends bundled by `scripts/build-web.mjs` (esbuild).
- `test/` — integration (vitest) and e2e (Playwright). Unit tests sit next to code as `*.test.ts`.

## Commands
```bash
npm ci
npm run typecheck
npm test                 # vitest unit + integration
npm run build            # dist/ (server) + dist/web (frontends)
npm run test:e2e         # Playwright (needs `npx playwright install chromium firefox`); starts
                         # scripts/test-stack.sh (Docker for Syncthing + restic, data in FILESHARE_SCRATCH)
FILESHARE_BIG=1 npx playwright test --grep @big    # the 6-peer 10 GiB run
docker compose up -d --build
docker compose exec app node dist/cli.js --help
```

## Conventions
- Two listeners: **public** (`server/public.ts`) must never expose admin routes; **admin**
  (`server/admin.ts`) requires a valid Cloudflare Access JWT on every request.
- Public URLs are always built from `PUBLIC_BASE_URL`, never from request headers/ports.
- Never log or persist peer IP addresses, share tokens, passwords or JWTs (`log.ts` redacts).
- Validate every name/path with `core/paths.ts` (`validateSegment`, `safeJoin`, `assertNoSymlinks`).
- All times are ms since epoch. IDs via `core/ids.ts`. DB changes go in a new
  `src/db/migrations/NNN_*.sql` file — never edit an applied migration.
- Pin exact dependency versions. Keep commits small and focused.
- Tests use synthetic random data only.

## Configuration and secrets
Deployment-specific values live in `.env` (from `.env.example`) and the git-ignored
`deploy.local.md` — **never in git**. Secrets are files under `${APPDATA}/secrets/` (mode 600),
never env vars in compose and never in the repo.
