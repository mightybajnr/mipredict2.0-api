import { Router } from "express";

import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { syncLimiter } from "../middleware/rateLimit.js";
import {
  apiFootballClient,
  ApiFootballError,
} from "../services/apiFootballClient.js";
import { apiFootballPublicConfig } from "../config/apiFootball.js";
import { importFixtures } from "../services/fixtureSyncService.js";
import { syncResults } from "../services/resultSyncService.js";
import { getRecentSyncLogs } from "../services/syncLogService.js";

export function syncErrorStatus(err) {
  switch (err?.code) {
    case "MISSING_KEY":
      return 503;
    case "TIMEOUT":
      return 504;
    case "RATE_LIMITED":
      return 429;
    case "PROVIDER_ERROR":
    case "INVALID_RESPONSE":
    case "NETWORK_ERROR":
      return 502;
    case "HTTP_ERROR":
      return 502;
    default:
      return 500;
  }
}

// Provider errors already carry sanitized messages with no secrets.
export function syncErrorMessage(err) {
  return err instanceof ApiFootballError
    ? err.message
    : "Synchronization failed.";
}

function parseCsv(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }

  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export async function handleImportFixtures(req, res, next) {
  try {
    if (!apiFootballClient.isConfigured()) {
      return res.status(503).json({
        message:
          "API-Football is not configured: set API_FOOTBALL_KEY on the server.",
      });
    }

    const body = req.body || {};
    const result = await importFixtures({
      leagues: parseCsv(body.leagues),
      seasons: parseCsv(body.seasons),
    });

    return res.json({
      message: "Fixture import completed.",
      result,
    });
  } catch (err) {
    if (err instanceof ApiFootballError) {
      return res
        .status(syncErrorStatus(err))
        .json({ message: syncErrorMessage(err) });
    }
    return next(err);
  }
}

export async function handleSyncResults(req, res, next) {
  try {
    if (!apiFootballClient.isConfigured()) {
      return res.status(503).json({
        message:
          "API-Football is not configured: set API_FOOTBALL_KEY on the server.",
      });
    }

    const body = req.body || {};
    const mode = ["live", "date", "league"].includes(body.mode)
      ? body.mode
      : "live";

    const result = await syncResults({
      mode,
      league: parsePositiveInt(body.league),
      season: parsePositiveInt(body.season),
      date: typeof body.date === "string" ? body.date : undefined,
    });

    return res.json({
      message: "Result synchronization completed.",
      result,
    });
  } catch (err) {
    if (err instanceof ApiFootballError) {
      return res
        .status(syncErrorStatus(err))
        .json({ message: syncErrorMessage(err) });
    }
    return next(err);
  }
}

export async function handleSyncStatus(req, res, next) {
  try {
    const limit = parsePositiveInt(req.query.limit) || 20;
    let logs = [];
    let logsUnavailable = false;

    try {
      logs = await getRecentSyncLogs({ limit });
    } catch (err) {
      // e.g. migration not yet applied; keep the status endpoint usable.
      logsUnavailable = true;
      req.log?.warn?.(`[sync] could not read sync logs: ${err.code}`);
    }

    return res.json({
      config: apiFootballPublicConfig(),
      provider: apiFootballClient.getRequestStats(),
      logs,
      logsUnavailable,
    });
  } catch (err) {
    return next(err);
  }
}

const router = Router();

// Every synchronization endpoint is administrator-only. CSRF is enforced
// globally for state-changing methods and a dedicated limiter caps how often
// upstream requests can be triggered.
router.use(requireAuth, requireAdmin);

router.post("/fixtures", syncLimiter, handleImportFixtures);
router.post("/results", syncLimiter, handleSyncResults);
router.get("/status", handleSyncStatus);

export default router;
