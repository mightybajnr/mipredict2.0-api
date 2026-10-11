import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

import pool from "../src/config/db.js";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const CSRF_PORT = 3002;
const BASE = `http://localhost:${CSRF_PORT}`;

after(async () => {
  await pool.end();
});

function uniqueEmail(tag) {
  return `itt_${tag}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}@test.local`;
}

function utcDateString(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function cookieJar() {
  const store = new Map();

  return {
    parse(res) {
      const cookies =
        typeof res.headers.getSetCookie === "function"
          ? res.headers.getSetCookie()
          : [];
      for (const cookie of cookies) {
        const eq = cookie.indexOf("=");
        const end = cookie.indexOf(";");
        if (eq === -1) continue;
        store.set(cookie.slice(0, eq).trim(), cookie.slice(eq + 1, end === -1 ? undefined : end));
      }
    },
    header() {
      return [...store.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
    csrf() {
      return store.get("XSRF-TOKEN") || "";
    },
  };
}

async function raw({ method = "GET", path, headers = {}, body, jar } = {}) {
  const requestHeaders = { ...headers };
  const cookie = jar?.header();
  if (cookie) requestHeaders.Cookie = cookie;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  jar?.parse(response);
  const data = await response.json().catch(() => ({}));

  return { response, data };
}

async function json({ method, path, body, jar, expected, csrf }) {
  const headers = { "Content-Type": "application/json" };
  if (csrf) headers["X-CSRF-Token"] = csrf;

  const { response, data } = await raw({ method, path, body, headers, jar });

  assert.equal(
    response.status,
    expected,
    `${method} ${path} expected ${expected}, got ${response.status}: ${JSON.stringify(data)}`
  );

  return { response, data };
}

async function insertMatch() {
  const [result] = await pool.execute(
    `INSERT INTO matches (home_team, away_team, competition, kickoff_at, status)
     VALUES (?, ?, ?, ?, ?)`,
    ["ITT CSRF Home", "ITT CSRF Away", "ITT CSRF League", utcDateString(2), "scheduled"]
  );
  return result.insertId;
}

async function waitForHealth(child, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      const data = await res.json();
      if (res.status === 200 && data.status === "ok") return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Server did not become healthy in time.");
}

test("CSRF token delivery, CORS and security headers over HTTP", async (t) => {
  const matchId = await insertMatch();
  let createdUserId = null;

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(CSRF_PORT),
      FRONTEND_URL: "https://mipredict.com,http://localhost:5173",
    },
    stdio: "ignore",
  });

  try {
    await waitForHealth(child);

    const jar = cookieJar();

    await t.test("unauthenticated /api/auth/me returns csrfToken on 401", async () => {
      const { data } = await json({ method: "GET", path: "/api/auth/me", jar, expected: 401 });
      assert.ok(data.csrfToken, "csrfToken should be present on the 401 body");
    });

    await t.test("first POST without a CSRF token is rejected", async () => {
      const attackerJar = cookieJar();
      await json({ method: "GET", path: "/api/auth/me", jar: attackerJar, expected: 401 });
      const { response, data } = await raw({
        method: "POST",
        path: "/api/auth/logout",
        jar: attackerJar,
      });
      assert.equal(response.status, 403);
      assert.ok(!("success" in data));
    });

    await t.test("signup succeeds with token and rotates it in the response body", async () => {
      const before = jar.csrf();
      const { data } = await json({
        method: "POST",
        path: "/api/auth/signup",
        body: {
          name: "ITT CSRF User",
          email: uniqueEmail("csrf"),
          password: "Passw0rd1",
        },
        expected: 201,
        jar,
        csrf: jar.csrf(),
      });

      assert.ok(typeof data.csrfToken === "string" && data.csrfToken.length > 0);
      assert.notEqual(data.csrfToken, before, "csrfToken should rotate after signup");
      assert.equal(data.csrfToken, jar.csrf(), "body token should match the rotated cookie");

      createdUserId = data.user.id;
    });

    await t.test("authenticated /api/auth/me returns user and csrfToken", async () => {
      const { data } = await json({ method: "GET", path: "/api/auth/me", jar, expected: 200 });
      assert.ok(data.user && data.user.email);
      assert.equal(data.csrfToken, jar.csrf());
    });

    await t.test("prediction submission works with the returned token", async () => {
      const { data } = await json({
        method: "POST",
        path: `/api/matches/${matchId}/predictions`,
        body: { predicted_home_score: 1, predicted_away_score: 0 },
        expected: 201,
        jar,
        csrf: jar.csrf(),
      });
      assert.equal(data.prediction.predicted_home_score, 1);
    });

    await t.test("logout rotates the token and returns it", async () => {
      const before = jar.csrf();
      const { data } = await json({
        method: "POST",
        path: "/api/auth/logout",
        expected: 200,
        jar,
        csrf: jar.csrf(),
      });
      assert.equal(data.success, true);
      assert.ok(data.csrfToken);
      assert.notEqual(data.csrfToken, before);
    });

    await t.test("POST after logout is still CSRF-protected", async () => {
      const safeJar = cookieJar();
      await json({ method: "GET", path: "/api/auth/me", jar: safeJar, expected: 401 });
      const { response, data } = await raw({
        method: "POST",
        path: "/api/auth/login",
        body: { email: "nobody@test.local", password: "Wrong1pass" },
        jar: safeJar,
      });
      assert.equal(response.status, 403);
      assert.deepEqual(data, { message: "Invalid or missing CSRF token." });
    });

    await t.test("CORS allows only approved origins with credentials", async () => {
      const approved = await raw({
        path: "/api/health",
        headers: { Origin: "https://mipredict.com" },
      });
      assert.equal(approved.response.headers.get("access-control-allow-origin"), "https://mipredict.com");
      assert.equal(approved.response.headers.get("access-control-allow-credentials"), "true");

      const denied = await raw({
        path: "/api/health",
        headers: { Origin: "https://evil.example" },
      });
      assert.equal(denied.response.headers.get("access-control-allow-origin"), null);
    });

    await t.test("CORS preflight permits the CSRF header", async () => {
      const { response } = await raw({
        method: "OPTIONS",
        path: "/api/matches/1/predictions",
        headers: {
          Origin: "https://mipredict.com",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type,x-csrf-token",
        },
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://mipredict.com");
      assert.equal(response.headers.get("access-control-allow-credentials"), "true");
      const allowed = response.headers.get("access-control-allow-headers") || "";
      assert.match(allowed.toLowerCase(), /content-type/);
      assert.match(allowed.toLowerCase(), /x-csrf-token/);
    });

    await t.test("unknown API routes return JSON 404", async () => {
      const { response, data } = await raw({ path: "/api/does-not-exist" });
      assert.equal(response.status, 404);
      assert.equal(data.message, "Not found.");
    });

    await t.test("security headers are present", async () => {
      const { response } = await raw({ path: "/api/health" });
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("x-frame-options"), "DENY");
      assert.equal(
        response.headers.get("referrer-policy"),
        "strict-origin-when-cross-origin"
      );
    });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});

    if (createdUserId != null) {
      await pool.execute("DELETE FROM users WHERE id = ?", [createdUserId]);
    }
    await pool.execute("DELETE FROM matches WHERE id = ?", [matchId]);
  }
});