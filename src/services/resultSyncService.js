import pool from "../config/db.js";
import { apiFootballClient, ApiFootballError } from "./apiFootballClient.js";
import {
  normalizeFixture,
  nowUtcDateTime,
} from "./fixtureMapper.js";
import { createMatchRepository } from "./matchRepository.js";
import { finalizeMatchResult } from "./scoringService.js";
import { recordSyncLog } from "./syncLogService.js";

const SUPPORTED_MODES = new Set(["live", "date", "league"]);

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function buildResultQuery({ mode = "live", league, season, date } = {}) {
  const safeMode = SUPPORTED_MODES.has(mode) ? mode : "live";

  if (safeMode === "live") {
    return { live: "all" };
  }

  if (safeMode === "date") {
    const params = { date: date || todayUtc() };
    if (league) params.league = league;
    if (season) params.season = season;
    return params;
  }

  const params = {};
  if (league) params.league = league;
  if (season) params.season = season;
  return params;
}

function toUpdateFields(fixture, updateScores) {
  return {
    homeTeam: fixture.homeTeam,
    awayTeam: fixture.awayTeam,
    competition: fixture.competition,
    kickoffAt: fixture.kickoffAt,
    status: fixture.status,
    providerStatus: fixture.providerStatus,
    updateScores,
    homeScore: fixture.homeScore,
    awayScore: fixture.awayScore,
  };
}

// Synchronizes statuses and scores for already-imported, provider-managed
// matches. Points are only awarded through the existing `finalizeMatchResult`
// scoring path, which is idempotent. Predictions are never overwritten and
// local match ids are never changed.
export async function syncResults({
  mode = "live",
  league,
  season,
  date,
  client = apiFootballClient,
  db = pool,
  repository = createMatchRepository(db),
  finalize = finalizeMatchResult,
  logger = console,
} = {}) {
  const startedAt = nowUtcDateTime();
  const startMs = Date.now();

  if (!client.isConfigured()) {
    throw new ApiFootballError(
      "MISSING_KEY",
      "API-Football is not configured: set API_FOOTBALL_KEY on the server."
    );
  }

  const params = buildResultQuery({ mode, league, season, date });
  const payload = await client.getFixtures(params);
  const fixtures = (payload.response || []).map(normalizeFixture).filter(Boolean);

  const summary = {
    status: "success",
    checked: fixtures.length,
    updated: 0,
    finalized: 0,
    skipped: 0,
    errors: 0,
  };

  for (const fixture of fixtures) {
    try {
      const match = await repository.findProviderMatch(
        db,
        fixture.externalFixtureId
      );

      if (!match) {
        summary.skipped += 1;
        continue;
      }

      const hasScore =
        fixture.homeScore !== null && fixture.awayScore !== null;

      if (fixture.isFinal && hasScore) {
        const alreadyFinal =
          match.status === "finished" &&
          Number(match.home_score) === fixture.homeScore &&
          Number(match.away_score) === fixture.awayScore;

        if (alreadyFinal) {
          await repository.updateProviderMatch(
            db,
            match.id,
            toUpdateFields(fixture, false)
          );
          summary.updated += 1;
        } else {
          await finalize({
            matchId: match.id,
            homeScore: fixture.homeScore,
            awayScore: fixture.awayScore,
            providerStatus: fixture.providerStatus,
            kickoffAt: fixture.kickoffAt,
            syncedAt: nowUtcDateTime(),
            db,
          });
          summary.finalized += 1;
        }
        continue;
      }

      // Scheduled, live, postponed, cancelled or abandoned: update status,
      // metadata and (for live) partial scores, but never award points and
      // never clear a previously finalized score.
      await repository.updateProviderMatch(
        db,
        match.id,
        toUpdateFields(fixture, fixture.isLive)
      );
      summary.updated += 1;
    } catch (err) {
      summary.errors += 1;
      summary.status = "partial";

      if (!(err instanceof ApiFootballError)) {
        throw err;
      }

      logger.error(
        `[sync] result sync failed for fixture ${fixture.externalFixtureId} (${err.code}).`
      );
    }
  }

  if (summary.errors > 0 && summary.updated + summary.finalized === 0) {
    summary.status = "error";
  }

  await recordSyncLog(
    {
      type: "results",
      status: summary.status,
      inserted: 0,
      updated: summary.updated,
      skipped: summary.skipped,
      errors: summary.errors,
      message: `mode=${mode}`,
      startedAt,
      finishedAt: nowUtcDateTime(),
    },
    { db, logger }
  );

  return { ...summary, durationMs: Date.now() - startMs };
}
