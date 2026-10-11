# Mi Predict 2.0 — API

Node.js + Express 5 API for Mi Predict. Production API: **https://api.mipredict.com** (Render). Frontend repo and local dev instructions: [`client/README.md`](../client/README.md).

## Local development

```bash
npm install
cp .env.example .env              # fill in real values (below), incl. DB_CA_CERT or certs/ca.pem
npm run db:setup                  # creates users, sessions, matches, predictions (CREATE TABLE IF NOT EXISTS)
npm run dev                       # http://localhost:3000 (nodemon)
```

Uses Aiven MySQL over TLS (`rejectUnauthorized: true`). The CA certificate is read from `DB_CA_CERT` (env var) or, failing that, `certs/ca.pem` on disk. Neither the cert nor `.env` is committed.

The server fails fast at startup with a clear message if `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` or `FRONTEND_URL` are missing. `NODE_ENV=production` is set by the platform, not the local `.env`.

## Environment variables

| Variable | Local example | Production (Render) |
| --- | --- | --- |
| `PORT` | `3000` | `3000` |
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME` | Aiven values | same |
| `FRONTEND_URL` | `http://localhost:5173` | `https://mipredict.com` (comma-separated allow-list allowed) |
| `DB_CA_CERT` | *(optional)* | Aiven `ca.pem` contents |
| `ADMIN_EMAILS` | *(optional)* | comma-separated emails allowed to finalize results / trigger sync |
| `TRUST_PROXY` | *(unset → 1)* | `1` |
| `NODE_ENV` | *(unset)* | `production` |
| `API_FOOTBALL_KEY` | *(optional)* | API-Football v3 key — **server only**, never exposed to the client |
| `API_FOOTBALL_BASE_URL` | `https://v3.football.api-sports.io` | same |
| `API_FOOTBALL_LEAGUES` | *(optional)* | comma-separated league ids to import (e.g. `39,140,135`) |
| `API_FOOTBALL_SEASONS` | *(optional)* | comma-separated seasons (e.g. `2025`) |
| `API_FOOTBALL_TIMEOUT_MS` | `10000` | request timeout |
| `API_FOOTBALL_MAX_RETRIES` | `2` | retries for temporary failures/429 (never infinite) |
| `API_FOOTBALL_RETRY_BASE_MS` | `500` | exponential backoff base |
| `API_FOOTBALL_CACHE_TTL_MS` | `60000` | in-memory response cache TTL |
| `SYNC_SCHEDULE_ENABLED` | `false` | enable the optional in-process scheduler |
| `SYNC_INTERVAL_MINUTES` | `30` | live-result sync interval (scheduler only) |
| `SYNC_FIXTURES_INTERVAL_MINUTES` | `1440` | fixture import interval (scheduler only) |
| `SYNC_ON_STARTUP` | `true` | production-only one-shot fixture window import at boot |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | nodemon autoreload on :3000 |
| `npm start` | production start (`node src/server.js`) |
| `npm test` | `node --test test/` — unit + DB integration + full HTTP E2E suites |
| `npm run db:setup` | create tables (`createUsersTable`, `createSessionsTable`, `createTables`) |
| `npm run db:migrate` | idempotent, non-destructive API-Football migration (provider columns + `sync_logs`) |
| `node src/scripts/seedMatch.js` | **manual dev-only** demo-match insert; not idempotent, never run in production |

## API notes

- Health: `GET /api/health` (liveness), `GET /api/health/db` (readiness incl. DB — `503` when down). JSON only, no secrets.
- Session auth: `HttpOnly` cookie, token stored SHA-256-hashed, 30-day expiry; `SameSite=Lax` dev / `SameSite=None; Secure` production.
- CSRF: `XSRF-TOKEN` cookie + `X-CSRF-Token` header, rotated on signup/login/logout. The token is returned in the JSON body of `GET /api/auth/me` (including on `401`), signup, login and logout so the cross-origin frontend can keep it in memory.
- CORS: allow-list only (`FRONTEND_URL`), credentials allowed, no wildcard.
- Security headers via [Helmet](https://helmetjs.github.io/): `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy: cross-origin` (so the SPA can consume the API cross-origin), and `Strict-Transport-Security` in production. CSP is disabled on this JSON-only origin. Unknown routes return JSON `404`.
- Prediction scoring is server-side and idempotent (exact 3, outcome 1, wrong 0) in a `FOR UPDATE` transaction; kickoff deadlines enforced; only `ADMIN_EMAILS` can finalize results.
- Rate limits: `/api` 300/15 min, auth routes 10/10 min — applied before CSRF checks.

## API-Football integration

Fixtures, statuses and scores are imported from **API-Football v3** (`https://v3.football.api-sports.io`) entirely server-side. The API key is read from `API_FOOTBALL_KEY` and sent in the `x-apisports-key` header. It is never sent to the browsable frontend, never placed in URLs, never returned by any endpoint and never written to logs.

### Architecture

| Concern | Location |
| --- | --- |
| Config (lazy env parsing) | `src/config/apiFootball.js` |
| HTTP client (timeout, retries, cache, validation, error types) | `src/services/apiFootballClient.js` |
| Payload normalization + status mapping (UTC) | `src/services/fixtureMapper.js` |
| Provider-match SQL (unique external id) | `src/services/matchRepository.js` |
| Fixture import | `src/services/fixtureSyncService.js` |
| Live/final result sync (reuses scoring) | `src/services/resultSyncService.js` |
| Sync audit log | `src/services/syncLogService.js` |
| Optional guarded scheduler | `src/services/syncScheduler.js` |
| Admin routes | `src/routes/sync.routes.js` |
| Migration | `src/scripts/migrateApiFootball.js` |

### Database migration

The server **self-heals** the schema on boot: `ensureApiFootballSchema()` (`src/services/schemaService.js`) runs at startup and on `npm run db:migrate`. Both are idempotent and non-destructive — only `ADD COLUMN` / `ADD INDEX` / `CREATE TABLE IF NOT EXISTS`, guarded by `INFORMATION_SCHEMA` and safe against concurrent starts.

It adds these columns to `matches`: `provider`, `external_fixture_id`, `provider_status`, `last_synced_at`, `home_team_logo`, `away_team_logo`. It also adds a unique index on `external_fixture_id` (many `NULL`s are allowed, so manual matches are unaffected) and creates the `sync_logs` table. Local match ids, predictions and foreign keys are never changed.

> A production `matches` table created before API-Football support exists will be missing these columns; without the migration every import fails with `Unknown column 'provider'`. Startup self-heal means a redeploy fixes this automatically — `npm run db:migrate` remains available for the CLI/`db:setup` path.

Matching for imports/updates is by (`provider = 'api-football'`, `external_fixture_id`), so manually created matches are never modified or deleted. Existing finished scores are preserved on re-import. Team logos (`teams.home.logo` / `teams.away.logo`) are stored only when they are absolute `http(s)` URLs and are rendered by the frontend with an initials fallback.

### Status mapping

API-Football short codes map onto the existing `matches.status` enum and the raw code is stored in `provider_status`:

| Provider | App status |
| --- | --- |
| `NS`, `TBD`, `SCH` | `scheduled` |
| `1H`, `2H`, `HT`, `ET`, `BT`, `P`, `SUSP`, `INT`, `LIVE` | `live` |
| `FT`, `AET`, `PEN`, `AWD`, `WO` | `finished` |
| `PST` | `postponed` |
| `CANC`, `ABD` | `cancelled` |

### Scoring safety

Points are only ever awarded through the existing server-side `finalizeMatchResult` (`src/services/scoringService.js`), which recomputes scores inside a `FOR UPDATE` transaction. Re-running it awards the same points (idempotent), so a re-sync cannot double-award. The sync scopes skip finalization when a finished result is unchanged and never read scores from client input. Postponed/cancelled/abandoned fixtures never clear already-awarded scores or predictions; a corrected finished result is recalculated by the same idempotent path.

### Admin endpoints (all require an authenticated admin)

- `POST /api/admin/sync/fixtures` — body `{ "leagues": [...], "seasons": [...] }` (optional; falls back to `API_FOOTBALL_LEAGUES`/`API_FOOTBALL_SEASONS`).
- `POST /api/admin/sync/results` — body `{ "mode": "live" | "date" | "league", "league": 39, "season": 2025, "date": "2025-08-15" }` (all optional; default `live`).
- `GET /api/admin/sync/status` — provider request stats (requests/failures/rate-limits/retries/cache) and the last sync logs. Never returns the key.

These endpoints are behind `requireAuth` + `requireAdmin`, the global CSRF check, and a dedicated `syncLimiter` (10 per 15 min).

### First manual synchronization

1. Deploy/run with `API_FOOTBALL_KEY` set (Render or local `.env`).
2. Run `npm run db:migrate` once against the database.
3. Set `API_FOOTBALL_LEAGUES` and `API_FOOTBALL_SEASONS` (e.g. `39,140,135` and `2025`).
4. From the admin account, `POST /api/admin/sync/fixtures` (with CSRF header/cookie) to import upcoming fixtures.
5. `POST /api/admin/sync/results` to pull current/live scores and finalize any finished matches.
6. `GET /api/admin/sync/status` to confirm counts/errors.

### Automated synchronization

An external scheduler is recommended on Render (a **Cron Job** that `curl`s the protected sync endpoints, or a platform cron). This avoids multiple loops when the web service restarts or scales. If you prefer in-process scheduling, set `SYNC_SCHEDULE_ENABLED=true`; a module-level singleton plus a MySQL `GET_LOCK('mipredict_sync', 0)` advisory lock guarantee only one instance syncs at a time. It is off by default.

When the scheduler is enabled it fires **immediately on startup** (then on the interval), so fixtures/results do not wait a full interval after a restart. Independently, when `NODE_ENV=production` and `SYNC_ON_STARTUP` is not `false`, the server performs a **one-shot fixture window import at boot** (never in tests/dev), so a fresh deploy shows real fixtures even if the scheduler is disabled.

#### Date-window import (not league × season)

The automatic path (`importFixtureWindow`) queries the provider **one day at a time** (`?date=YYYY-MM-DD`) across a rolling window (default *today-1 .. today+7*) and keeps only the configured/default competitions. This is intentional:

- It is one request per day instead of `leagues × seasons`, and a single day response already includes every competition.
- It is the **only model that works on the free plan**: a free plan can query dates near "now" but rejects arbitrary seasons (`Free plans do not have access to this season, try from 2022 to 2024`) and out-of-window dates (`...try from <today-1> to <today+1>`). Days outside the allowed range are skipped gracefully and logged as errors; the days inside it still import.

Set `API_FOOTBALL_LEAGUES` to control which competitions are kept (ids, e.g. `39,140,135,78,61,2`). If unset, a small default set (top-5 European leagues + Champions League) is used. Manual `POST /api/admin/sync/fixtures` still accepts explicit `{ leagues, seasons }` for full-season imports on paid plans.

`GET /api/matches` supports `status`, `competition`, `team`, `date` (`YYYY-MM-DD`), `page` and `limit` for server-side filtering.

### Expected request usage (free plan is limited)

With `SYNC_INTERVAL_MINUTES=30`, live sync is **48 requests/day**. The boot/window fixture import is **one request per day in the window** (default 9), plus the scheduled interval. `API_FOOTBALL_CACHE_TTL_MS` deduplicates identical upstream calls within the window and the client never retries indefinitely. Start conservatively and watch `GET /api/admin/sync/status`.

> **Free-plan limit:** API-Football's free plan only serves a narrow *date* window around "now" and seasons 2022–2024. If fixtures still do not appear, confirm the plan/season with `GET /api/admin/sync/status` and the `sync_logs` `message`/`error_count`; the provider error text says exactly which range is allowed.

### Public data stays local

`GET /api/matches` and match details always serve from MySQL; no provider call happens on page load, and the frontend never talks to API-Football directly.

## Deployment — Render

- **Web Service**, runtime Node, root directory `server`, build `npm install`, start `npm start`.
- Health check: `GET /api/health/db`.
- Set `NODE_ENV=production`, `FRONTEND_URL=https://mipredict.com`, Aiven DB vars, `DB_CA_CERT` (the Aiven `ca.pem` contents), `ADMIN_EMAILS`, `TRUST_PROXY=1`.
- For API-Football: add `API_FOOTBALL_KEY` (Render env var — never commit it), `API_FOOTBALL_BASE_URL`, and optionally `API_FOOTBALL_LEAGUES` / `API_FOOTBALL_SEASONS`. Optionally `SYNC_SCHEDULE_ENABLED` + intervals, or use a Render Cron Job against the sync endpoints; `SYNC_ON_STARTUP` (default on in production) imports the current date window at boot.
- The provider schema is applied automatically at startup; `npm run db:migrate` (Render Shell) is still available and idempotent.
- Do not run `npm run db:setup` or any seeding against production without an approved migration plan.

## Tests

`npm test` runs `scoring.test.js` (unit), `integration.test.js` (DB), `adminE2E.test.js` (HTTP admin flow on :3001) and `csrf.test.js` (CSRF delivery/rotation, CORS allow-list, JSON 404, security headers on :3002). Each suite cleans up only the rows it creates (by id), so suites run in parallel safely. Tests require a reachable dev Aiven DB (set by `server/.env`).