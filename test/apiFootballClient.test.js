import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  createApiFootballClient,
  ApiFootballError,
} from "../src/services/apiFootballClient.js";

const BASE = "https://v3.football.api-sports.io";

function jsonResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => payload,
  };
}

function silent() {
  return { error() {}, log() {} };
}

function makeClient(overrides = {}) {
  return createApiFootballClient({
    key: "test-key",
    baseUrl: BASE,
    maxRetries: 1,
    retryBaseMs: 1,
    cacheTtlMs: 0,
    sleep: async () => {},
    logger: silent(),
    ...overrides,
  });
}

describe("apiFootballClient", () => {
  it("reports configured state from the key", () => {
    assert.equal(makeClient().isConfigured(), true);
    assert.equal(makeClient({ key: "" }).isConfigured(), false);
  });

  it("throws a clear MISSING_KEY error without a key", async () => {
    const client = makeClient({ key: "" });
    await assert.rejects(
      () => client.getFixtures({ league: 39, season: 2025 }),
      (err) => err instanceof ApiFootballError && err.code === "MISSING_KEY"
    );
  });

  it("sends the x-apisports-key header and returns valid payloads", async () => {
    let captured;
    const client = makeClient({
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return jsonResponse(200, { response: [{ fixture: { id: 1 } }] });
      },
    });

    const payload = await client.getFixtures({ league: 39, season: 2025 });
    assert.equal(payload.response.length, 1);
    assert.equal(captured.options.headers["x-apisports-key"], "test-key");
    assert.match(captured.url, /league=39/);
    assert.match(captured.url, /season=2025/);
    assert.equal(captured.url.includes("test-key"), false, "key must not be in the URL");
  });

  it("rejects invalid JSON responses", async () => {
    const client = makeClient({
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        json: async () => {
          throw new Error("bad json");
        },
      }),
    });

    await assert.rejects(
      () => client.getFixtures({}),
      (err) => err.code === "INVALID_RESPONSE"
    );
  });

  it("rejects responses without a response array", async () => {
    const client = makeClient({
      fetchImpl: async () => jsonResponse(200, { results: 0 }),
    });

    await assert.rejects(
      () => client.getFixtures({}),
      (err) => err.code === "INVALID_RESPONSE"
    );
  });

  it("surfaces provider-declared errors", async () => {
    const client = makeClient({
      fetchImpl: async () =>
        jsonResponse(200, { errors: { token: "Invalid API key" }, response: [] }),
    });

    await assert.rejects(
      () => client.getFixtures({}),
      (err) => err.code === "PROVIDER_ERROR" && /Invalid API key/.test(err.message)
    );
  });

  it("retries rate limits and then succeeds", async () => {
    let calls = 0;
    const client = makeClient({
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        if (calls < 2) return jsonResponse(429, {});
        return jsonResponse(200, { response: [] });
      },
    });

    const payload = await client.getFixtures({});
    assert.deepEqual(payload.response, []);
    assert.equal(calls, 2);
    assert.equal(client.getRequestStats().retries, 1);
    assert.equal(client.getRequestStats().rateLimited, 1);
  });

  it("stops retrying after the configured maximum", async () => {
    let calls = 0;
    const client = makeClient({
      maxRetries: 2,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(500, {});
      },
    });

    await assert.rejects(
      () => client.getFixtures({}),
      (err) => err.code === "PROVIDER_ERROR"
    );
    assert.equal(calls, 3, "initial attempt plus two retries");
  });

  it("treats aborted requests as timeouts", async () => {
    const client = makeClient({
      maxRetries: 0,
      fetchImpl: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    });

    await assert.rejects(
      () => client.getFixtures({}),
      (err) => err.code === "TIMEOUT" && err.retryable === true
    );
  });

  it("caches identical requests within the TTL", async () => {
    let calls = 0;
    const client = makeClient({
      cacheTtlMs: 60000,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(200, { response: [] });
      },
    });

    await client.getFixtures({ league: 39, season: 2025 });
    await client.getFixtures({ league: 39, season: 2025 });

    assert.equal(calls, 1);
    assert.equal(client.getRequestStats().cacheHits, 1);
  });

  it("does not retry non-retryable client errors", async () => {
    let calls = 0;
    const client = makeClient({
      maxRetries: 3,
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(403, {});
      },
    });

    await assert.rejects(
      () => client.getFixtures({}),
      (err) => err.code === "HTTP_ERROR" && err.retryable === false
    );
    assert.equal(calls, 1);
  });
});
