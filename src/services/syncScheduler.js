import pool from "../config/db.js";
import { apiFootballConfig } from "../config/apiFootball.js";
import { apiFootballClient } from "./apiFootballClient.js";
import { importFixtureWindow } from "./fixtureSyncService.js";
import { syncResults } from "./resultSyncService.js";

// Optional in-process scheduler. Disabled unless SYNC_SCHEDULE_ENABLED=true.
//
// Safety notes:
// - A module-level singleton guard prevents multiple loops from starting when
//   this module is imported more than once in the same process.
// - A MySQL advisory lock (`GET_LOCK`) prevents two server instances from
//   syncing at the same time if the service is scaled horizontally.
// - The recommended production approach remains a single external scheduler
//   (e.g. Render Cron Job) calling the protected admin sync endpoints.
const LOCK_NAME = "mipredict_sync";

let started = false;
let timers = [];

export function startSyncScheduler({
  db = pool,
  client = apiFootballClient,
  logger = console,
} = {}) {
  const config = apiFootballConfig();

  if (!config.scheduleEnabled) {
    return { started: false, reason: "disabled" };
  }

  if (started) {
    return { started: false, reason: "already-started" };
  }

  started = true;

  // Run once immediately so a deploy (or a fresh restart) populates fixtures
  // and live scores without waiting a whole interval. Previously the first run
  // waited up to SYNC_FIXTURES_INTERVAL_MINUTES and reset on every restart.
  runGuarded(
    "results",
    () => syncResults({ mode: "live", db, client, logger }),
    logger
  );
  runGuarded(
    "fixtures-window",
    () => importFixtureWindow({ db, client, logger }),
    logger
  );

  const resultsTimer = setInterval(
    () =>
      runGuarded("results", () => syncResults({ mode: "live", db, client, logger }), logger),
    config.liveSyncIntervalMs
  );

  const fixturesTimer = setInterval(
    () => runGuarded("fixtures-window", () => importFixtureWindow({ db, client, logger }), logger),
    config.fixturesSyncIntervalMs
  );

  resultsTimer.unref?.();
  fixturesTimer.unref?.();
  timers = [resultsTimer, fixturesTimer];

  logger.log(
    `[sync] scheduler enabled (live every ${Math.round(
      config.liveSyncIntervalMs / 60000
    )}m, fixtures every ${Math.round(config.fixturesSyncIntervalMs / 60000)}m)`
  );

  return {
    started: true,
    liveSyncIntervalMs: config.liveSyncIntervalMs,
    fixturesSyncIntervalMs: config.fixturesSyncIntervalMs,
  };
}

export function stopSyncScheduler() {
  for (const timer of timers) clearInterval(timer);
  timers = [];
  started = false;
}

async function runGuarded(label, task, logger) {
  let connection;

  try {
    connection = await pool.getConnection();
    const [rows] = await connection.query("SELECT GET_LOCK(?, 0) AS locked", [
      LOCK_NAME,
    ]);

    if (!Number(rows[0]?.locked)) {
      return;
    }

    try {
      await task();
    } finally {
      await connection
        .query("SELECT RELEASE_LOCK(?)", [LOCK_NAME])
        .catch(() => {});
    }
  } catch (err) {
    logger.error(`[sync] ${label} tick failed: ${err.code || err.message}`);
  } finally {
    connection?.release?.();
  }
}
