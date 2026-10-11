import pool from "../config/db.js";

export async function getLeaderboard() {
  const [rows] = await pool.query(
    `SELECT u.id, u.name,
            COALESCE(SUM(p.points), 0) AS total_points,
            COUNT(p.id) AS total_predictions,
            COALESCE(SUM(
              CASE
                WHEN m.status = 'finished'
                 AND p.predicted_home_score = m.home_score
                 AND p.predicted_away_score = m.away_score
                THEN 1 ELSE 0
              END
            ), 0) AS correct_predictions,
            COALESCE(SUM(
              CASE WHEN m.status = 'finished' THEN 1 ELSE 0 END
            ), 0) AS scored_predictions
       FROM users u
       JOIN predictions p ON p.user_id = u.id
       JOIN matches m ON m.id = p.match_id
      GROUP BY u.id, u.name
      ORDER BY total_points DESC, correct_predictions DESC,
               total_predictions DESC, u.id ASC`
  );

  return rows.map((row, index) => {
    const totalPredictions = Number(row.total_predictions);
    const correctPredictions = Number(row.correct_predictions);
    const scoredPredictions = Number(row.scored_predictions);

    return {
      rank: index + 1,
      user_id: row.id,
      name: row.name,
      total_points: Number(row.total_points),
      total_predictions: totalPredictions,
      correct_predictions: correctPredictions,
      scored_predictions: scoredPredictions,
      accuracy: scoredPredictions
        ? Math.round((correctPredictions / scoredPredictions) * 100)
        : null,
    };
  });
}

export async function getUserLeaderboardEntry(userId) {
  const leaderboard = await getLeaderboard();
  return leaderboard.find((entry) => entry.user_id === userId) || null;
}