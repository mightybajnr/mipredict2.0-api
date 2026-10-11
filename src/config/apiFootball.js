import "dotenv/config";

// API-Football v3 configuration.
//
// Values are read lazily (per call) rather than captured at import time so
// that test suites and multiple environments can override process.env without
// needing to re-import this module. The API key is intentionally NOT part of
// the required-env set: a missing key must produce a clear server-side
// configuration error at request time, never crash the whole application.

export const DEFAULT_API_FOOTBALL_BASE_URL =
  "https://v3.football.api-sports.io";

function toInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function toBool(value) {
  return String(value || "").trim().toLowerCase() === "true";
}

export function apiFootballConfig() {
  return {
    key: process.env.API_FOOTBALL_KEY || "",
    baseUrl: (
      process.env.API_FOOTBALL_BASE_URL || DEFAULT_API_FOOTBALL_BASE_URL
    ).replace(/\/+$/, ""),
    timeoutMs: toInt(process.env.API_FOOTBALL_TIMEOUT_MS, 10000),
    maxRetries: toInt(process.env.API_FOOTBALL_MAX_RETRIES, 2),
    retryBaseMs: toInt(process.env.API_FOOTBALL_RETRY_BASE_MS, 500),
    cacheTtlMs: toInt(process.env.API_FOOTBALL_CACHE_TTL_MS, 60000),
    defaultLeagues: parseList(process.env.API_FOOTBALL_LEAGUES),
    defaultSeasons: parseList(process.env.API_FOOTBALL_SEASONS),
    scheduleEnabled: toBool(process.env.SYNC_SCHEDULE_ENABLED),
    liveSyncIntervalMs: toInt(process.env.SYNC_INTERVAL_MINUTES, 30) * 60000,
    fixturesSyncIntervalMs:
      toInt(process.env.SYNC_FIXTURES_INTERVAL_MINUTES, 1440) * 60000,
  };
}

// Public (non-secret) description of the provider configuration, safe to
// return from an admin-only status endpoint.
export function apiFootballPublicConfig() {
  const config = apiFootballConfig();

  return {
    configured: Boolean(config.key),
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    cacheTtlMs: config.cacheTtlMs,
    defaultLeagues: config.defaultLeagues,
    defaultSeasons: config.defaultSeasons,
    schedule: {
      enabled: config.scheduleEnabled,
      liveSyncIntervalMinutes: Math.round(config.liveSyncIntervalMs / 60000),
      fixturesSyncIntervalMinutes: Math.round(
        config.fixturesSyncIntervalMs / 60000
      ),
    },
  };
}
