import pool from "../config/db.js";

// Self-healing, non-destructive schema migration for API-Football support.
//
// This lives in a service (not only in a CLI script) so the running server can
// guarantee the provider columns and `sync_logs` table exist before the sync
// pipeline runs. Production tables created before API-Football support was
// added are missing these columns, which previously made every import fail with
// `ER_BAD_FIELD_ERROR: Unknown column 'provider'`.
//
// Guarantees:
// - Idempotent: INFORMATION_SCHEMA guards skip anything already present.
// - Non-destructive: only ADD COLUMN / ADD INDEX / CREATE TABLE IF NOT EXISTS;
//   never drops or renames columns and never touches local match ids or rows.
// - Race-safe: duplicate-column/index errors from concurrent startups (e.g.
//   parallel test servers) are swallowed.
// - The unique index on `external_fixture_id` allows many NULLs (manually
//   created matches) while preventing duplicate imported fixtures.

export const MATCH_COLUMNS = [
  { name: "provider", ddl: "VARCHAR(50) NULL" },
  { name: "external_fixture_id", ddl: "VARCHAR(64) NULL" },
  { name: "provider_status", ddl: "VARCHAR(40) NULL" },
  { name: "last_synced_at", ddl: "DATETIME NULL" },
  { name: "home_team_logo", ddl: "VARCHAR(255) NULL" },
  { name: "away_team_logo", ddl: "VARCHAR(255) NULL" },
];

export const UNIQUE_INDEX_NAME = "uniq_matches_external_fixture";
export const PROVIDER_INDEX_NAME = "idx_matches_provider_status";

const SYNC_LOGS_SQL = `
  CREATE TABLE IF NOT EXISTS sync_logs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    sync_type VARCHAR(32) NOT NULL,
    provider VARCHAR(50) NOT NULL DEFAULT 'api-football',
    status VARCHAR(20) NOT NULL,
    inserted_count INT UNSIGNED NOT NULL DEFAULT 0,
    updated_count INT UNSIGNED NOT NULL DEFAULT 0,
    skipped_count INT UNSIGNED NOT NULL DEFAULT 0,
    error_count INT UNSIGNED NOT NULL DEFAULT 0,
    message VARCHAR(500) NULL,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    INDEX idx_sync_logs_type_created (sync_type, created_at)
  ) ENGINE=InnoDB
`;

async function tableExists(db, schema, table) {
  const [rows] = await db.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      LIMIT 1`,
    [schema, table]
  );

  return rows.length > 0;
}

async function columnExists(db, schema, table, column) {
  const [rows] = await db.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
      LIMIT 1`,
    [schema, table, column]
  );

  return rows.length > 0;
}

async function indexExists(db, schema, table, index) {
  const [rows] = await db.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
      LIMIT 1`,
    [schema, table, index]
  );

  return rows.length > 0;
}

// MySQL reports a duplicate column as ER_DUP_FIELDNAME and a duplicate index as
// ER_DUP_KEYNAME. Both mean a concurrent startup already applied the change, so
// they are safe to ignore. Accepting either code for either operation keeps the
// migration resilient even if the exact error differs across versions.
function isDuplicateError(err) {
  return err?.code === "ER_DUP_FIELDNAME" || err?.code === "ER_DUP_KEYNAME";
}

// Applies every missing piece and returns a summary of what changed. Throws a
// clear configuration error if the base `matches` table itself is missing so
// the CLI can exit non-zero while the server only logs it.
export async function ensureApiFootballSchema({
  db = pool,
  schema = process.env.DB_NAME,
  logger = console,
} = {}) {
  if (!(await tableExists(db, schema, "matches"))) {
    throw new Error(
      "The `matches` table does not exist. Run `npm run db:setup` first."
    );
  }

  const applied = [];

  for (const column of MATCH_COLUMNS) {
    if (await columnExists(db, schema, "matches", column.name)) continue;

    try {
      await db.query(
        `ALTER TABLE matches ADD COLUMN \`${column.name}\` ${column.ddl}`
      );
      applied.push(`column:${column.name}`);
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
    }
  }

  if (!(await indexExists(db, schema, "matches", UNIQUE_INDEX_NAME))) {
    try {
      await db.query(
        `ALTER TABLE matches
           ADD UNIQUE KEY \`${UNIQUE_INDEX_NAME}\` (external_fixture_id)`
      );
      applied.push(`index:${UNIQUE_INDEX_NAME}`);
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
    }
  }

  if (!(await indexExists(db, schema, "matches", PROVIDER_INDEX_NAME))) {
    try {
      await db.query(
        `ALTER TABLE matches
           ADD INDEX \`${PROVIDER_INDEX_NAME}\` (provider, provider_status)`
      );
      applied.push(`index:${PROVIDER_INDEX_NAME}`);
    } catch (err) {
      if (!isDuplicateError(err)) throw err;
    }
  }

  await db.query(SYNC_LOGS_SQL);

  if (applied.length && typeof logger?.log === "function") {
    logger.log(`[schema] API-Football schema updated: ${applied.join(", ")}`);
  }

  return { table: "matches", applied, syncLogsEnsured: true };
}

export default ensureApiFootballSchema;
