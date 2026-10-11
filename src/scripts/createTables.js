import pool from "../config/db.js";

async function createTables() {
  let connection;

  try {
    connection = await pool.getConnection();

    console.log("Connected to Aiven MySQL.");

    await connection.beginTransaction();

    // Create matches table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS matches (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        home_team VARCHAR(100) NOT NULL,
        away_team VARCHAR(100) NOT NULL,
        competition VARCHAR(120) NOT NULL,
        kickoff_at DATETIME NOT NULL,
        status ENUM(
          'scheduled',
          'live',
          'finished',
          'postponed',
          'cancelled'
        ) NOT NULL DEFAULT 'scheduled',
        home_score TINYINT UNSIGNED NULL,
        away_score TINYINT UNSIGNED NULL,
        provider VARCHAR(50) NULL,
        external_fixture_id VARCHAR(64) NULL,
        provider_status VARCHAR(40) NULL,
        last_synced_at DATETIME NULL,
        home_team_logo VARCHAR(255) NULL,
        away_team_logo VARCHAR(255) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY uniq_matches_external_fixture (external_fixture_id),
        INDEX idx_matches_kickoff (kickoff_at),
        INDEX idx_matches_status_kickoff (status, kickoff_at),
        INDEX idx_matches_provider_status (provider, provider_status)
      ) ENGINE=InnoDB
    `);

    console.log("Matches table created or already exists.");

    // Create predictions table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS predictions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        user_id BIGINT UNSIGNED NOT NULL,
        match_id BIGINT UNSIGNED NOT NULL,
        predicted_home_score TINYINT UNSIGNED NOT NULL,
        predicted_away_score TINYINT UNSIGNED NOT NULL,
        points SMALLINT UNSIGNED NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY unique_user_match (user_id, match_id),
        INDEX idx_predictions_match (match_id),

        CONSTRAINT fk_predictions_user
          FOREIGN KEY (user_id)
          REFERENCES users(id)
          ON DELETE CASCADE,

        CONSTRAINT fk_predictions_match
          FOREIGN KEY (match_id)
          REFERENCES matches(id)
          ON DELETE CASCADE
      ) ENGINE=InnoDB
    `);

    console.log(
      "Predictions table created or already exists."
    );

    await connection.commit();

    // Verify both tables exist
    const [tables] = await connection.query(`
      SHOW TABLES WHERE
        Tables_in_${process.env.DB_NAME} IN
        ('matches', 'predictions')
    `);

    console.log("Verified database tables:");
    console.table(tables);

    // Verify columns
    for (const table of ["matches", "predictions"]) {
      const [columns] = await connection.query(
        `SHOW COLUMNS FROM \`${table}\``
      );

      console.log(`Structure of ${table}:`);
      console.table(columns);
    }

    console.log("Database setup completed successfully.");
  } catch (error) {
    if (connection) {
      await connection.rollback();
    }

    console.error("Database setup failed:", error.message);
    process.exitCode = 1;
  } finally {
    if (connection) connection.release();
    await pool.end();
  }
}

createTables();
