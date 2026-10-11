import pool from "../config/db.js";
import { PredictionError } from "./matchService.js";

export function computeScore(homeScore, awayScore, predictedHomeScore, predictedAwayScore) {
  if (predictedHomeScore === homeScore && predictedAwayScore === awayScore) {
    return 3;
  }

  const actualOutcome = Math.sign(homeScore - awayScore);
  const predictedOutcome = Math.sign(predictedHomeScore - predictedAwayScore);

  return actualOutcome === predictedOutcome ? 1 : 0;
}

export async function finalizeMatchResult({ matchId, homeScore, awayScore }) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT id, status
         FROM matches
        WHERE id = ?
        FOR UPDATE`,
      [matchId]
    );

    const match = rows[0];

    if (!match) {
      throw new PredictionError("MATCH_NOT_FOUND", "Match not found.");
    }

    if (match.status === "postponed" || match.status === "cancelled") {
      throw new PredictionError(
        "MATCH_NOT_RESULTABLE",
        "A postponed or cancelled match cannot be finalized."
      );
    }

    await connection.execute(
      `UPDATE matches
          SET home_score = ?, away_score = ?, status = 'finished'
        WHERE id = ?`,
      [homeScore, awayScore, matchId]
    );

    const [predictions] = await connection.execute(
      `SELECT id, predicted_home_score, predicted_away_score
         FROM predictions
        WHERE match_id = ?`,
      [matchId]
    );

    let scoredPredictions = 0;

    for (const prediction of predictions) {
      const points = computeScore(
        homeScore,
        awayScore,
        prediction.predicted_home_score,
        prediction.predicted_away_score
      );

      await connection.execute("UPDATE predictions SET points = ? WHERE id = ?", [
        points,
        prediction.id,
      ]);

      scoredPredictions += 1;
    }

    await connection.commit();

    return {
      matchId,
      homeScore,
      awayScore,
      scoredPredictions,
    };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}