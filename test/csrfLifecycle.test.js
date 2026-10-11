import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

// This suite intentionally touches no database. It exercises the CSRF token
// lifecycle that the cross-origin frontend depends on: body-seeded tokens,
// rotation, the uncached bootstrap endpoint, no-store caching headers and the
// one-shot 403 retry that recovers from a stale/proxy-cached token.
const SERVER_DIR = fileURLToPath(new URL("..", import.meta.url));
const PORT = 3003;
const BASE = `http://localhost:${PORT}`;

let child;

after(async () => {
  if (child) {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
});

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
        if (eq === -1) continue;
        const end = cookie.indexOf(";");
        store.set(
          cookie.slice(0, eq).trim(),
          cookie.slice(eq + 1, end === -1 ? undefined : end)
        );
      }
    },
    header() {
      return [...store.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; ");
    },
    csrf() {
      return store.get("XSRF-TOKEN") || "";
    },
    drop(name) {
      store.delete(name);
    },
  };
}

async function request({ method = "GET", path, headers = {}, body, jar } = {}) {
  const requestHeaders = { ...headers };
  if (jar?.header()) requestHeaders.Cookie = jar.header();

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  jar?.parse(response);
  const data = await response.json().catch(() => ({}));

  return { response, data };
}

async function waitForHealth(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early with code ${child.exitCode}`);
    }
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.status === 200) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Server did not become healthy in time.");
}

test("CSRF lifecycle for cross-origin clients (no DB required)", async (t) => {
  child = spawn(process.execPath, ["src/server.js"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      FRONTEND_URL: "https://mipredict.com",
      SYNC_SCHEDULE_ENABLED: "false",
    },
    stdio: "ignore",
  });

  await waitForHealth();

  await t.test("API responses are not cacheable", async () => {
    const { response } = await request({ path: "/api/health" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  await t.test("GET /api/csrf-token returns an uncached token matching its cookie", async () => {
    const jar = cookieJar();
    const { response, data } = await request({ path: "/api/csrf-token", jar });

    assert.equal(response.status, 200);
    assert.ok(data.csrfToken, "body should contain csrfToken");
    assert.equal(data.csrfToken, jar.csrf(), "body token must match Set-Cookie");
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  await t.test("unauthenticated /api/auth/me still returns a csrfToken", async () => {
    const jar = cookieJar();
    const { response, data } = await request({ path: "/api/auth/me", jar });

    assert.equal(response.status, 401);
    assert.ok(data.csrfToken, "401 body should seed the token");
    assert.equal(data.csrfToken, jar.csrf());
    assert.equal(response.headers.get("cache-control"), "no-store");
  });

  await t.test("cross-origin client: body-seeded token authorizes a POST", async () => {
    const jar = cookieJar();

    // The frontend cannot read document.cookie, so it seeds from JSON.
    const seed = await request({ path: "/api/csrf-token", jar });
    const token = seed.data.csrfToken;

    const { response, data } = await request({
      method: "POST",
      path: "/api/auth/logout",
      jar,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
    });

    assert.equal(response.status, 200);
    assert.equal(data.success, true);
    assert.ok(data.csrfToken && data.csrfToken !== token, "token rotates");
    assert.equal(data.csrfToken, jar.csrf());
  });

  await t.test("POST without a header is rejected even with a cookie", async () => {
    const jar = cookieJar();
    await request({ path: "/api/csrf-token", jar });

    const { response, data } = await request({
      method: "POST",
      path: "/api/auth/logout",
      jar,
      headers: { "Content-Type": "application/json" },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(data, { message: "Invalid or missing CSRF token." });
  });

  await t.test("POST with a mismatched header is rejected", async () => {
    const jar = cookieJar();
    await request({ path: "/api/csrf-token", jar });

    const { response } = await request({
      method: "POST",
      path: "/api/auth/logout",
      jar,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": "deadbeef".repeat(6),
      },
    });

    assert.equal(response.status, 403);
  });

  await t.test("stale token (dropped cookie) is recovered by the bootstrap retry", async () => {
    const jar = cookieJar();

    // Simulate a proxy having served a token body without its Set-Cookie:
    // the client holds a token but the browser sends no XSRF-TOKEN cookie.
    const staleToken = "a".repeat(48);
    jar.drop("XSRF-TOKEN");

    const first = await request({
      method: "POST",
      path: "/api/auth/logout",
      jar,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": staleToken },
    });
    assert.equal(first.response.status, 403);

    // Client retry path: fetch a fresh, uncached token, then retry once.
    const bootstrap = await request({ path: "/api/csrf-token", jar });
    assert.ok(bootstrap.data.csrfToken);
    assert.notEqual(bootstrap.data.csrfToken, staleToken);

    const retry = await request({
      method: "POST",
      path: "/api/auth/logout",
      jar,
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": bootstrap.data.csrfToken,
      },
    });
    assert.equal(retry.response.status, 200);
    assert.equal(retry.data.success, true);
  });
});
