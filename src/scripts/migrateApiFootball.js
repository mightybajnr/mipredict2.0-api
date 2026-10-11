import pool from "../config/db.js";
import { ensureApiFootballSchema } from "../services/schemaService.js";

// CLI wrapper around `ensureApiFootballSchema`. The same idempotent migration
// also runs automatically on server startup, so this script exists mainly for
// manual/CI use and for provisioning a fresh database.

async function migrate() {
  try {
    console.log("Connected to MySQL for API-Football migration.");

    const result = await ensureApiFootballSchema();

    console.log(
      result.applied.length
        ? `API-Football migration applied: ${result.applied.join(", ")}`
        : "API-Football migration already up to date."
    );
    console.log("API-Football migration completed successfully.");
  } catch (error) {
    console.error("API-Football migration failed:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
