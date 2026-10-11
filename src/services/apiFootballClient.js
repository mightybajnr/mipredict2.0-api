import { apiFootballConfig } from "../config/apiFootball.js";

// Typed error for every failure mode of the provider integration. Callers can
// map `code` to an HTTP status without ever leaking the raw provider payload.
export class ApiFootballError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ApiFootballError";
    this.code = code;
    this.status = options.status;
    this.retryable = Boolean(options.retryable);
    this.details = options.details;
  }
}

function buildUrl(baseUrl, path, params) {
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function providerErrorMessage(errors) {
  if (Array.isArray(errors)) {
    return errors.filter(Boolean).join("; ");
  }
  if (errors && typeof errors === "object") {
    return Object.values(errors).filter(Boolean).join("; ");
  }
  return "";
}

function hasProviderErrors(errors) {
  if (Array.isArray(errors)) return errors.filter(Boolean).length > 0;
  if (errors && typeof errors === "object") {
    return Object.values(errors).filter(Boolean).length > 0;
  }
  return false;
}

// Creates an API-Football client. All side-effecting dependencies (fetch,
// sleep, clock, logger) are injectable so tests never hit the real provider.
export function createApiFootballClient(options = {}) {
  const explicit = { ...options };
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sleep =
    options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || (() => Date.now());
  const logger = options.logger || console;

  const stats = {
    requests: 0,
    failures: 0,
    rateLimited: 0,
    retries: 0,
    cacheHits: 0,
  };

  const cache = new Map();

  function resolveConfig() {
    const base = apiFootballConfig();
    return {
      key: explicit.key !== undefined ? explicit.key : base.key,
      baseUrl: explicit.baseUrl || base.baseUrl,
      timeoutMs: explicit.timeoutMs ?? base.timeoutMs,
      maxRetries: explicit.maxRetries ?? base.maxRetries,
      retryBaseMs: explicit.retryBaseMs ?? base.retryBaseMs,
      cacheTtlMs: explicit.cacheTtlMs ?? base.cacheTtlMs,
    };
  }

  function isConfigured() {
    return Boolean(resolveConfig().key);
  }

  async function performRequest(config, url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    let response;

    try {
      response = await fetchImpl(url, {
        method: "GET",
        headers: {
          "x-apisports-key": config.key,
          Accept: "application/json",
        },
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === "AbortError") {
        throw new ApiFootballError(
          "TIMEOUT",
          "API-Football request timed out.",
          { retryable: true }
        );
      }
      throw new ApiFootballError(
        "NETWORK_ERROR",
        "Could not reach API-Football.",
        { retryable: true }
      );
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      throw new ApiFootballError(
        "RATE_LIMITED",
        "API-Football rate limit reached.",
        { status: 429, retryable: true }
      );
    }

    if (response.status >= 500) {
      throw new ApiFootballError(
        "PROVIDER_ERROR",
        "API-Football is temporarily unavailable.",
        { status: response.status, retryable: true }
      );
    }

    if (!response.ok) {
      throw new ApiFootballError(
        "HTTP_ERROR",
        `API-Football request failed (${response.status}).`,
        { status: response.status, retryable: false }
      );
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new ApiFootballError(
        "INVALID_RESPONSE",
        "API-Football returned invalid JSON.",
        { retryable: false }
      );
    }

    if (!payload || typeof payload !== "object") {
      throw new ApiFootballError(
        "INVALID_RESPONSE",
        "API-Football returned an unexpected response.",
        { retryable: false }
      );
    }

    if (hasProviderErrors(payload.errors)) {
      throw new ApiFootballError(
        "PROVIDER_ERROR",
        `API-Football error: ${providerErrorMessage(payload.errors)}`,
        { retryable: false }
      );
    }

    if (!Array.isArray(payload.response)) {
      throw new ApiFootballError(
        "INVALID_RESPONSE",
        "API-Football response is missing a valid 'response' array.",
        { retryable: false }
      );
    }

    return payload;
  }

  async function request(path, params = {}) {
    const config = resolveConfig();

    if (!config.key) {
      throw new ApiFootballError(
        "MISSING_KEY",
        "API-Football is not configured: set API_FOOTBALL_KEY on the server.",
        { details: { variable: "API_FOOTBALL_KEY" } }
      );
    }

    const url = buildUrl(config.baseUrl, path, params);

    if (config.cacheTtlMs > 0) {
      const cached = cache.get(url);
      if (cached && cached.expiresAt > now()) {
        stats.cacheHits += 1;
        return cached.payload;
      }
    }

    let lastError;

    for (let attempt = 1; attempt <= config.maxRetries + 1; attempt += 1) {
      stats.requests += 1;

      try {
        const payload = await performRequest(config, url);

        if (config.cacheTtlMs > 0) {
          cache.set(url, { payload, expiresAt: now() + config.cacheTtlMs });
        }

        return payload;
      } catch (err) {
        lastError = err;
        stats.failures += 1;

        if (err.code === "RATE_LIMITED") {
          stats.rateLimited += 1;
        }

        const exhausted = attempt > config.maxRetries;
        if (!err.retryable || exhausted) {
          // Never log the key or the raw URL query secrets; the message is
          // already sanitised and contains no credentials.
          logger.error(
            `[api-football] request failed (${err.code}) after ${attempt} attempt(s).`
          );
          throw err;
        }

        stats.retries += 1;
        await sleep(config.retryBaseMs * 2 ** (attempt - 1));
      }
    }

    throw lastError;
  }

  return {
    isConfigured,
    getFixtures: (params) => request("/fixtures", params),
    getLiveFixtures: () => request("/fixtures", { live: "all" }),
    getRequestStats: () => ({ ...stats, cacheSize: cache.size }),
    clearCache: () => cache.clear(),
  };
}

// Lazily-configured singleton used by the sync services at runtime.
export const apiFootballClient = createApiFootballClient();
