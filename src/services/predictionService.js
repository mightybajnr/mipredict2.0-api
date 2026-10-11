import pool from "../config/db.js";

const PREDICTION_JOIN = `FROM predictions p
                         JOIN matches m ON m.id = p.match_id`;

const PREDICTION_FILTERS = {
  upcoming: "m.kickoff_at > UTC_TIMESTAMP() AND m.status = 'scheduled'",
  pending: "m.status = 'live'",
  completed: "m.status = 'finished'",
};

export function normalizePredictionFilter(value) {
  return PREDICTION_FILTERS[value] ? value : "all";
}

export async function listUserPredictions(userId, filter = "all") {
  const name = normalizePredictionFilter(filter);
  const condition = PREDICTION_FILTERS[name];
  const where = condition ? `WHERE p.user_id = ? AND ${condition}` : "WHERE p.user_id = ?";

  const [rows] = await pool.execute(
    `SELECT p.id, p.match_id, p.predicted_home_score, p.predicted_away_score,
            p.points, p.created_at, p.updated_at,
            m.home_team, m.away_team, m.competition, m.kickoff_at, m.status,
            m.home_score, m.away_score
       ${PREDICTION_JOIN}
       ${where}
      ORDER BY m.kickoff_at DESC`,
    [userId]
  );

  return rows;
}

export async function getUserPredictionByMatch(userId, matchId) {
  const [rows] = await pool.execute(
    `SELECT p.id, p.match_id, p.predicted_home_score, p.predicted_away_score,
            p.points, p.created_at, p.updated_at,
            m.home_team, m.away_team, m.competition, m.kickoff_at, m.status,
            m.home_score, m.away_score
       ${PREDICTION_JOIN}
      WHERE p.user_id = ? AND p.match_id = ?
      LIMIT 1`,
    [userId, matchId]
  );

  return rows[0] || null;
}