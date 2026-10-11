import pool from "../config/db.js";
import {
  apiFootballConfig,
  DEFAULT_LEAGUE_IDS,
} from "../config/apiFootball.js";
import {
  apiFootballClient,
  ApiFootballError,
} from "./apiFootballClient.js";
import {
  normalizeFixture,
  nowUtcDateTime,
  deriveSeason,
} from "./fixtureMapper.js";
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
          homeTeamLogo: fixture.homeTeamLogo,
          awayTeamLogo: fixture.awayTeamLogo,
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
              homeTeamLogo: fixture.homeTeamLogo,
              awayTeamLogo: fixture.awayTeamLogo,
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

// Rolling date window used by the automatic (scheduler/startup) import. A
// narrow window keeps the stored set small and relevant so the public list
// endpoint never has to page through an entire season to find upcoming games.
export const WINDOW_DAYS_BACK = 1;
export const WINDOW_DAYS_FORWARD = 7;

function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date, days) {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

// Pure helper: resolves the inclusive [from, to] UTC dates for a window.
export function resolveWindow({
  daysBack = WINDOW_DAYS_BACK,
  daysForward = WINDOW_DAYS_FORWARD,
  now = new Date(),
} = {}) {
  const back =
    Number.isInteger(daysBack) && daysBack >= 0 ? daysBack : WINDOW_DAYS_BACK;
  const forward =
    Number.isInteger(daysForward) && daysForward >= 0
      ? daysForward
      : WINDOW_DAYS_FORWARD;

  return {
    from: utcDateString(addUtcDays(now, -back)),
    to: utcDateString(addUtcDays(now, forward)),
  };
}

// Pure helper: every YYYY-MM-DD (UTC) between from and to, inclusive.
export function buildWindowDates({ from, to } = {}) {
  const dates = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return dates;
  }

  for (let cursor = start; cursor <= end; cursor = addUtcDays(cursor, 1)) {
    dates.push(utcDateString(cursor));
  }

  return dates;
}

// Resolves which competitions the automatic window import keeps. Explicit
// arguments win, then configuration, then the built-in fallback league set (the
// automatic path must not be a no-op when the deployment only set an API key).
// `importFixtures` deliberately keeps using `resolveImportTargets` so its
// "skip when unconfigured" contract is unchanged.
export function resolveWindowTargets({
  leagues,
  seasons,
  now = new Date(),
} = {}) {
  const config = apiFootballConfig();

  const leagueSource =
    Array.isArray(leagues) && leagues.length
      ? leagues
      : config.defaultLeagues.length
        ? config.defaultLeagues
        : DEFAULT_LEAGUE_IDS;

  const seasonSource =
    Array.isArray(seasons) && seasons.length
      ? seasons
      : config.defaultSeasons.length
        ? config.defaultSeasons
        : [deriveSeason(now)];

  const leagueList = leagueSource
    .map((value) => String(value).trim())
    .filter(Boolean);
  const seasonList = seasonSource
    .map((value) => String(value).trim())
    .filter(Boolean);

  return { leagueList, seasonList };
}

// Imports fixtures for a rolling date window. It queries the provider per day
// (`?date=YYYY-MM-DD`) and then keeps only the configured/default competitions.
//
// Why date-based rather than league+season: the day endpoint returns every
// competition in one request (far fewer calls), and it is the only window model
// that works across provider plans — a free plan can query dates near "now" but
// rejects arbitrary seasons. This is what makes real fixtures appear shortly
// after deployment instead of waiting a full fixtures interval.
export async function importFixtureWindow({
  daysBack,
  daysForward,
  leagues,
  seasons,
  now = new Date(),
  client = apiFootballClient,
  db = pool,
  repository = createMatchRepository(db),
  logger = console,
} = {}) {
  const startedAt = nowUtcDateTime();
  const startMs = Date.now();
  const { from, to } = resolveWindow({ daysBack, daysForward, now });
  const { leagueList } = resolveWindowTargets({ leagues, seasons, now });
  const allowedLeagues = new Set(leagueList);

  if (!client.isConfigured()) {
    throw new ApiFootballError(
      "MISSING_KEY",
      "API-Football is not configured: set API_FOOTBALL_KEY on the server."
    );
  }

  const summary = {
    status: "success",
    from,
    to,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    competitions: [],
  };

  for (const date of buildWindowDates({ from, to })) {
    try {
      const payload = await client.getFixtures({ date });
      const all = (payload.response || []).map(normalizeFixture).filter(Boolean);
      const fixtures = all.filter(
        (fixture) =>
          fixture.leagueId != null && allowedLeagues.has(String(fixture.leagueId))
      );

      const stats = await persistFixtures({ fixtures, db, repository });

      summary.inserted += stats.inserted;
      summary.updated += stats.updated;
      summary.skipped += stats.skipped;
      summary.competitions.push({
        date,
        fetched: all.length,
        fixtures: fixtures.length,
      });
    } catch (err) {
      summary.errors += 1;
      summary.status = "partial";

      if (!(err instanceof ApiFootballError)) {
        throw err;
      }

      logger.error(
        `[sync] fixture window import failed for date ${date} (${err.code}).`
      );
    }
  }

  if (summary.errors > 0 && summary.inserted + summary.updated === 0) {
    summary.status = "error";
  }

  await recordSyncLog(
    {
      type: "fixtures-window",
      status: summary.status,
      inserted: summary.inserted,
      updated: summary.updated,
      skipped: summary.skipped,
      errors: summary.errors,
      message: `window=${from}..${to}`,
      startedAt,
      finishedAt: nowUtcDateTime(),
    },
    { db, logger }
  );

  return { ...summary, durationMs: Date.now() - startMs };
}
