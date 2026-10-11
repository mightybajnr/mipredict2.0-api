import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { requireAdmin } from "../src/middleware/auth.js";
import {
  syncErrorStatus,
  handleImportFixtures,
  handleSyncResults,
} from "../src/routes/sync.routes.js";

function createRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  return res;
}

describe("requireAdmin", () => {
  const saved = process.env.ADMIN_EMAILS;

  afterEach(() => {
    process.env.ADMIN_EMAILS = saved;
  });

  it("allows configured administrators (case-insensitive)", () => {
    process.env.ADMIN_EMAILS = "Admin@Test.com, second@test.com";
    let called = false;

    requireAdmin(
      { user: { email: "ADMIN@test.com" } },
      createRes(),
      () => {
        called = true;
      }
    );

    assert.equal(called, true);
  });

  it("rejects authenticated non-admins with 403", () => {
    process.env.ADMIN_EMAILS = "admin@test.com";
    const res = createRes();
    let called = false;

    requireAdmin({ user: { email: "player@test.com" } }, res, () => {
      called = true;
    });

    assert.equal(called, false);
    assert.equal(res.statusCode, 403);
  });

  it("rejects when there is no authenticated user", () => {
    process.env.ADMIN_EMAILS = "admin@test.com";
    const res = createRes();

    requireAdmin({}, res, () => {});

    assert.equal(res.statusCode, 403);
  });
});

describe("syncErrorStatus", () => {
  it("maps provider error codes to HTTP statuses", () => {
    assert.equal(syncErrorStatus({ code: "MISSING_KEY" }), 503);
    assert.equal(syncErrorStatus({ code: "TIMEOUT" }), 504);
    assert.equal(syncErrorStatus({ code: "RATE_LIMITED" }), 429);
    assert.equal(syncErrorStatus({ code: "PROVIDER_ERROR" }), 502);
    assert.equal(syncErrorStatus({ code: "INVALID_RESPONSE" }), 502);
    assert.equal(syncErrorStatus({ code: "HTTP_ERROR" }), 502);
    assert.equal(syncErrorStatus({ code: "SOMETHING_ELSE" }), 500);
    assert.equal(syncErrorStatus(null), 500);
  });
});

describe("sync handlers without a configured key", () => {
  const savedKey = process.env.API_FOOTBALL_KEY;

  afterEach(() => {
    process.env.API_FOOTBALL_KEY = savedKey;
  });

  it("returns a clear 503 from fixture import instead of crashing", async () => {
    process.env.API_FOOTBALL_KEY = "";
    const res = createRes();

    await handleImportFixtures({ body: {} }, res, (err) => {
      throw err;
    });

    assert.equal(res.statusCode, 503);
    assert.match(res.body.message, /API_FOOTBALL_KEY/);
  });

  it("returns a clear 503 from result sync instead of crashing", async () => {
    process.env.API_FOOTBALL_KEY = "";
    const res = createRes();

    await handleSyncResults({ body: {} }, res, (err) => {
      throw err;
    });

    assert.equal(res.statusCode, 503);
    assert.match(res.body.message, /API_FOOTBALL_KEY/);
    assert.equal(JSON.stringify(res.body).includes("test-key"), false);
  });
});
