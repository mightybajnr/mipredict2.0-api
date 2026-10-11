import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "node:url";

import pool from "../src/config/db.js";

const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const ADMIN_PORT = 3001;
const BASE = `http://localhost:${ADMIN_PORT}`;

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

async function insertUser(name, email, passwordHash) {
  const [result] = await pool.execute(
    "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
    [name, email, passwordHash]
  );
  return result.insertId;
}

async function insertMatch() {
  const [result] = await pool.execute(
    `INSERT INTO matches (home_team, away_team, competition, kickoff_at, status)
     VALUES (?, ?, ?, ?, ?)`,
    ["ITT E2E Home", "ITT E2E Away", "ITT E2E League", utcDateString(2), "scheduled"]
  );
  return result.insertId;
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

async function api(jar, method, path, { body, expected } = {}) {
  const headers = { "Content-Type": "application/json" };
  const cookie = jar.header();
  if (cookie) headers.Cookie = cookie;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const token = jar.csrf();
    if (token) headers["X-CSRF-Token"] = token;
  }

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  jar.parse(response);

  const data = await response.json().catch(() => ({}));
  assert.equal(
    response.status,
    expected,
    `${method} ${path} expected ${expected}, got ${response.status}: ${JSON.stringify(data)}`
  );
  return data;
}

async function waitForHealth(child, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health/db`);
      const data = await res.json();
      if (res.status === 200 && data.status === "ok") return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Server did not become healthy in time.");
}

test("admin finalize flow over HTTP", async (t) => {
  const adminPassword = "AdminPass123";
  const playerPassword = "PlayerPass123";
  const adminEmail = uniqueEmail("admin");
  const playerEmail = uniqueEmail("player");

  const adminId = await insertUser("ITT E2E Admin", adminEmail, await bcrypt.hash(adminPassword, 10));
  const playerId = await insertUser("ITT E2E Player", playerEmail, await bcrypt.hash(playerPassword, 10));
  const matchId = await insertMatch();

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(ADMIN_PORT), ADMIN_EMAILS: adminEmail },
    stdio: "ignore",
  });

  try {
    await waitForHealth(child);

    const adminJar = cookieJar();
    const playerJar = cookieJar();

    await api(adminJar, "GET", "/api/auth/me", { expected: 401 });
    await api(playerJar, "GET", "/api/auth/me", { expected: 401 });

    await api(adminJar, "POST", "/api/auth/login", {
      body: { email: adminEmail, password: adminPassword },
      expected: 200,
    });
    await api(playerJar, "POST", "/api/auth/login", {
      body: { email: playerEmail, password: playerPassword },
      expected: 200,
    });

    await api(playerJar, "POST", `/api/matches/${matchId}/predictions`, {
      body: { predicted_home_score: 2, predicted_away_score: 1 },
      expected: 201,
    });

    await t.test("non-admin cannot finalize a result", async () => {
      await api(playerJar, "POST", `/api/admin/matches/${matchId}/result`, {
        body: { home_score: 0, away_score: 0 },
        expected: 403,
      });
    });

    await t.test("admin finalizes the result and awards points", async () => {
      const result = await api(adminJar, "POST", `/api/admin/matches/${matchId}/result`, {
        body: { home_score: 2, away_score: 1 },
        expected: 200,
      });
      assert.equal(result.result.scoredPredictions, 1);

      const match = await api(playerJar, "GET", `/api/matches/${matchId}`, {
        expected: 200,
      });
      assert.equal(match.match.status, "finished");
      assert.equal(match.match.home_score, 2);
    });

    await t.test("leaderboard and dashboard reflect the scored points", async () => {
      const entry = await api(playerJar, "GET", "/api/leaderboard/me", {
        expected: 200,
      });
      assert.equal(entry.entry.total_points, 3);

      const dashboard = await api(playerJar, "GET", "/api/dashboard/me", {
        expected: 200,
      });
      assert.equal(dashboard.stats.points, 3);
      assert.equal(typeof dashboard.rank, "number");
    });
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});

    await pool.execute("DELETE FROM matches WHERE id = ?", [matchId]);
    await pool.execute("DELETE FROM users WHERE id IN (?, ?)", [adminId, playerId]);
  }
});