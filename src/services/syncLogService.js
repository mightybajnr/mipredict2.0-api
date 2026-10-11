import pool from "../config/db.js";

// Synchronization audit log. Recording a log must never break a sync run, so
// failures here are swallowed after being reported to the injected logger.
export async function recordSyncLog(
  {
    type,
    status,
    inserted = 0,
    updated = 0,
    skipped = 0,
    errors = 0,
    message = null,
    startedAt = null,
    finishedAt = null,
    provider = "api-football",
  },
  { db = pool, logger = console } = {}
) {
  try {
    await db.execute(
      `INSERT INTO sync_logs
         (sync_type, provider, status, inserted_count, updated_count,
          skipped_count, error_count, message, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        type,
        provider,
        status,
        inserted,
        updated,
        skipped,
        errors,
        message ? String(message).slice(0, 500) : null,
        startedAt,
        finishedAt,
      ]
    );
  } catch (err) {
    logger.error(`[sync] failed to record sync log: ${err.code || err.message}`);
  }
}

export async function getRecentSyncLogs({ limit = 20, db = pool } = {}) {
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 20));

  const [rows] = await db.query(
    `SELECT id, sync_type, provider, status, inserted_count, updated_count,
            skipped_count, error_count, message, started_at, finished_at,
            created_at
       FROM sync_logs
      ORDER BY id DESC
      LIMIT ?`,
    [safeLimit]
  );

  return rows;
}
