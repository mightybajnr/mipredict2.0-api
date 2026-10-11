import pool from "../config/db.js";
import { apiFootballConfig } from "../config/apiFootball.js";
import {
  apiFootballClient,
  ApiFootballError,
} from "./apiFootballClient.js";
import { normalizeFixture, nowUtcDateTime } from "./fixtureMapper.js";
import { createMatchRepository } from "./matchRepository.js";
import { recordSyncLog } from "./syncLogService.js";

// Resolves which league/season combinations to import. Explicit arguments win;
// otherwise the configured defaults are used. No competition list is ever
// hardcoded in the service.
export function resolveImportTargets({ leagues, seasons } = {}) {
  const config = apiFootballConfig();

  const leagueList = (Array.isArray(leagues) && leagues.length
    ? leagues
    : config.defaultLeagues
  )
    .map((value) => String(value).trim())
    .filter(Boolean);

  const seasonList = (Array.isArray(seasons) && seasons.length
    ? seasons
    : config.defaultSeasons
  )
    .map((value) => String(value).trim())
    .filter(Boolean);

  return { leagueList, seasonList };
}

// Persists normalized fixtures. Duplicate prevention is keyed on the unique
// `external_fixture_id`; manually created matches (provider IS NULL) are never
// matched or modified. Existing finished scores are preserved so an import can
// never undo a locally finalized result.
export async function persistFixtures({
  fixtures,
  db = pool,
  repository = createMatchRepository(db),
}) {
  const connection = await db.getConnection();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await connection.beginTransaction();

    for (const fixture of fixtures) {
      const existing = await repository.findProviderMatch(
        connection,
        fixture.externalFixtureId,
        { forUpdate: true }
      );

      if (existing) {
        const preserveScores = existing.status === "finished";

        await repository.updateProviderMatch(connection, existing.id, {
          homeTeam: fixture.homeTeam,
          awayTeam: fixture.awayTeam,
          competition: fixture.competition,
          kickoffAt: fixture.kickoffAt,
          status: fixture.status,
          providerStatus: fixture.providerStatus,
          updateScores: !preserveScores,
          homeScore: fixture.homeScore,
          awayScore: fixture.awayScore,
        });

        updated += 1;
        continue;
      }

      try {
        await repository.insertProviderMatch(connection, fixture);
        inserted += 1;
      } catch (err) {
        if (err && err.code === "ER_DUP_ENTRY") {
          // Lost a race with another import; fall back to a safe update.
          const raced = await repository.findProviderMatch(
            connection,
            fixture.externalFixtureId,
            { forUpdate: true }
          );

          if (raced) {
            await repository.updateProviderMatch(connection, raced.id, {
              homeTeam: fixture.homeTeam,
              awayTeam: fixture.awayTeam,
              competition: fixture.competition,
              kickoffAt: fixture.kickoffAt,
              status: fixture.status,
              providerStatus: fixture.providerStatus,
              updateScores: raced.status !== "finished",
              homeScore: fixture.homeScore,
              awayScore: fixture.awayScore,
            });
            updated += 1;
          } else {
            skipped += 1;
          }
        } else {
          throw err;
        }
      }
    }

    await connection.commit();
    return { inserted, updated, skipped };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

export async function importFixtures({
  leagues,
  seasons,
  client = apiFootballClient,
  db = pool,
  repository = createMatchRepository(db),
  logger = console,
} = {}) {
  const startedAt = nowUtcDateTime();
  const startMs = Date.now();
  const { leagueList, seasonList } = resolveImportTargets({ leagues, seasons });

  if (!leagueList.length || !seasonList.length) {
    const skippedResult = {
      status: "skipped",
      reason: "no-leagues-or-seasons-configured",
      inserted: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      competitions: [],
      durationMs: 0,
    };

    await recordSyncLog(
      {
        type: "fixtures",
        status: "skipped",
        message: skippedResult.reason,
        startedAt,
        finishedAt: nowUtcDateTime(),
      },
      { db, logger }
    );

    return skippedResult;
  }

  if (!client.isConfigured()) {
    throw new ApiFootballError(
      "MISSING_KEY",
      "API-Football is not configured: set API_FOOTBALL_KEY on the server."
    );
  }

  const summary = {
    status: "success",
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    competitions: [],
  };

  for (const league of leagueList) {
    for (const season of seasonList) {
      try {
        const payload = await client.getFixtures({ league, season });
        const fixtures = (payload.response || [])
          .map(normalizeFixture)
          .filter(Boolean);

        const stats = await persistFixtures({ fixtures, db, repository });

        summary.inserted += stats.inserted;
        summary.updated += stats.updated;
        summary.skipped += stats.skipped;
        summary.competitions.push({
          league,
          season,
          fixtures: fixtures.length,
        });
      } catch (err) {
        summary.errors += 1;
        summary.status = "partial";

        if (!(err instanceof ApiFootballError)) {
          throw err;
        }

        logger.error(
          `[sync] fixtures import failed for league ${league} season ${season} (${err.code}).`
        );
      }
    }
  }

  if (summary.errors > 0 && summary.inserted + summary.updated === 0) {
    summary.status = "error";
  }

  await recordSyncLog(
    {
      type: "fixtures",
      status: summary.status,
      inserted: summary.inserted,
      updated: summary.updated,
      skipped: summary.skipped,
      errors: summary.errors,
      message:
        summary.competitions
          .map((entry) => `${entry.league}/${entry.season}:${entry.fixtures}`)
          .join(", ") || null,
      startedAt,
      finishedAt: nowUtcDateTime(),
    },
    { db, logger }
  );

  return { ...summary, durationMs: Date.now() - startMs };
}
