import pool from "../config/db.js";

async function createUsersTable() {
  try {
    console.log("Connecting to Aiven MySQL...");

    // Verify database connection
    const [db] = await pool.query(
      "SELECT DATABASE() AS database_name"
    );

    console.log("Connected to:", db[0].database_name);

    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        name VARCHAR(100) NOT NULL,
        email VARCHAR(254) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,

        PRIMARY KEY (id),
        UNIQUE KEY unique_users_email (email)
      )
    `);

    console.log("Users table created successfully.");

    // Verify table exists
    const [tables] = await pool.execute(
      "SHOW TABLES LIKE 'users'"
    );

    if (tables.length === 0) {
      throw new Error("Users table does not exist.");
    }

    // Display table structure
    const [columns] = await pool.query(
      "DESCRIBE users"
    );

    console.log("Verified users table structure:");
    console.table(columns);

  } catch (error) {
    console.error("Database setup failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

createUsersTable();