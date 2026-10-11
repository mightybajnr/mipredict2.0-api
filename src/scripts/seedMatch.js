import pool from "../config/db.js";

async function seedMatch() {
  try {
    const [result] = await pool.execute(`
      INSERT INTO matches (
        home_team,
        away_team,
        competition,
        kickoff_at
      )
      VALUES (
        'Mi Predict FC',
        'Demo United',
        'Test Competition',
        DATE_ADD(UTC_TIMESTAMP(), INTERVAL 2 DAY)
      )
    `);

    console.log("Demo match inserted successfully!");
    console.log("Match ID:", result.insertId);

    // Verify the inserted match
    const [matches] = await pool.execute(
      "SELECT * FROM matches WHERE id = ?",
      [result.insertId]
    );

    console.table(matches);
  } catch (error) {
    console.error("Failed to insert match:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

seedMatch();
