import pool from "../config/db.js";

async function createSessionsTable() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        token_hash CHAR(64) NOT NULL,
        expires_at DATETIME NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY unique_sessions_token_hash (token_hash),
        KEY idx_sessions_user_id (user_id),
        KEY idx_sessions_expires_at (expires_at),
        CONSTRAINT fk_sessions_user
          FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log("Sessions table ready.");
  } catch (error) {
    console.error("Failed to create sessions table:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

createSessionsTable();