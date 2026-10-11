import pool from "../config/db.js";

// Non-destructive, repeatable migration that adds provider metadata to the
// existing `matches` table and creates the synchronization audit table.
//
// - Uses INFORMATION_SCHEMA guards so re-running is always safe.
// - Never drops or renames columns, never touches local match ids, predictions
//   or existing rows.
// - The unique index on `external_fixture_id` allows many NULLs (manually
//   created matches) while preventing duplicate imported fixtures.

const MATCH_COLUMNS = [
  { name: "provider", ddl: "VARCHAR(50) NULL" },
  { name: "external_fixture_id", ddl: "VARCHAR(64) NULL" },
  { name: "provider_status", ddl: "VARCHAR(40) NULL" },
  { name: "last_synced_at", ddl: "DATETIME NULL" },
];

const UNIQUE_INDEX_NAME = "uniq_matches_external_fixture";
const PROVIDER_INDEX_NAME = "idx_matches_provider_status";

async function tableExists(connection, table) {
  const [rows] = await connection.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
      LIMIT 1`,
    [process.env.DB_NAME, table]
  );
  return rows.length > 0;
}

async function columnExists(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?
      LIMIT 1`,
    [process.env.DB_NAME, table, column]
  );
  return rows.length > 0;
}

async function indexExists(connection, table, index) {
  const [rows] = await connection.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?
      LIMIT 1`,
    [process.env.DB_NAME, table, index]
  );
  return rows.length > 0;
}

async function addMissingColumns(connection) {
  for (const column of MATCH_COLUMNS) {
    if (await columnExists(connection, "matches", column.name)) {
      console.log(`[migrate] matches.${column.name} already exists.`);
      continue;
    }

    await connection.query(
      `ALTER TABLE matches ADD COLUMN \`${column.name}\` ${column.ddl}`
    );
    console.log(`[migrate] added matches.${column.name}.`);
  }
}

async function addMissingIndexes(connection) {
  if (await indexExists(connection, "matches", UNIQUE_INDEX_NAME)) {
    console.log(`[migrate] index ${UNIQUE_INDEX_NAME} already exists.`);
  } else {
    await connection.query(
      `ALTER TABLE matches
         ADD UNIQUE KEY \`${UNIQUE_INDEX_NAME}\` (external_fixture_id)`
    );
    console.log(`[migrate] added unique index ${UNIQUE_INDEX_NAME}.`);
  }

  if (await indexExists(connection, "matches", PROVIDER_INDEX_NAME)) {
    console.log(`[migrate] index ${PROVIDER_INDEX_NAME} already exists.`);
  } else {
    await connection.query(
      `ALTER TABLE matches
         ADD INDEX \`${PROVIDER_INDEX_NAME}\` (provider, provider_status)`
    );
    console.log(`[migrate] added index ${PROVIDER_INDEX_NAME}.`);
  }
}

async function createSyncLogsTable(connection) {
  await connection.query(`
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
  `);
  console.log("[migrate] sync_logs table ready.");
}

async function migrate() {
  let connection;

  try {
    connection = await pool.getConnection();
    console.log("Connected to MySQL for API-Football migration.");

    if (!(await tableExists(connection, "matches"))) {
      throw new Error(
        "The `matches` table does not exist. Run `npm run db:setup` first."
      );
    }

    await addMissingColumns(connection);
    await addMissingIndexes(connection);
    await createSyncLogsTable(connection);

    console.log("API-Football migration completed successfully.");
  } catch (error) {
    console.error("API-Football migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

migrate();
