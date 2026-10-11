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
| `ADMIN_EMAILS` | *(optional)* | comma-separated emails allowed to finalize results |
| `TRUST_PROXY` | *(unset → 1)* | `1` |
| `NODE_ENV` | *(unset)* | `production` |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | nodemon autoreload on :3000 |
| `npm start` | production start (`node src/server.js`) |
| `npm test` | `node --test test/` — unit + DB integration + full HTTP E2E suites |
| `npm run db:setup` | create tables (`createUsersTable`, `createSessionsTable`, `createTables`) |
| `node src/scripts/seedMatch.js` | **manual dev-only** demo-match insert; not idempotent, never run in production |

## API notes

- Health: `GET /api/health` (liveness), `GET /api/health/db` (readiness incl. DB — `503` when down). JSON only, no secrets.
- Session auth: `HttpOnly` cookie, token stored SHA-256-hashed, 30-day expiry; `SameSite=Lax` dev / `SameSite=None; Secure` production.
- CSRF: `XSRF-TOKEN` cookie + `X-CSRF-Token` header, rotated on signup/login/logout. The token is returned in the JSON body of `GET /api/auth/me` (including on `401`), signup, login and logout so the cross-origin frontend can keep it in memory.
- CORS: allow-list only (`FRONTEND_URL`), credentials allowed, no wildcard.
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Cross-Origin-Opener-Policy`, and `Strict-Transport-Security` in production. Unknown routes return JSON `404`.
- Prediction scoring is server-side and idempotent (exact 3, outcome 1, wrong 0) in a `FOR UPDATE` transaction; kickoff deadlines enforced; only `ADMIN_EMAILS` can finalize results.
- Rate limits: `/api` 300/15 min, auth routes 10/10 min — applied before CSRF checks.

## Deployment — Render

- **Web Service**, runtime Node, root directory `server`, build `npm install`, start `npm start`.
- Health check: `GET /api/health/db`.
- Set `NODE_ENV=production`, `FRONTEND_URL=https://mipredict.com`, Aiven DB vars, `DB_CA_CERT` (the Aiven `ca.pem` contents), `ADMIN_EMAILS`, `TRUST_PROXY=1`.
- Do not run `npm run db:setup` or any seeding against production without an approved migration plan.

## Tests

`npm test` runs `scoring.test.js` (unit), `integration.test.js` (DB), `adminE2E.test.js` (HTTP admin flow on :3001) and `csrf.test.js` (CSRF delivery/rotation, CORS allow-list, JSON 404, security headers on :3002). Each suite cleans up only the rows it creates (by id), so suites run in parallel safely. Tests require a reachable dev Aiven DB (set by `server/.env`).