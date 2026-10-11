import pool from "../config/db.js";
import { getLeaderboard } from "./leaderboardService.js";

export async function getDashboardSummary(userId) {
  const [predictions] = await pool.execute(
    `SELECT p.id, p.points, p.created_at,
            p.predicted_home_score, p.predicted_away_score,
            m.home_team, m.away_team, m.competition, m.kickoff_at, m.status,
            m.home_score, m.away_score
       FROM predictions p
       JOIN matches m ON m.id = p.match_id
      WHERE p.user_id = ?
      ORDER BY p.updated_at DESC, p.id DESC`,
    [userId]
  );

  let resolved = 0;
  let correct = 0;
  let points = 0;

  for (const prediction of predictions) {
    points += Number(prediction.points) || 0;

    if (prediction.status === "finished") {
      resolved += 1;

      if (
        Number(prediction.predicted_home_score) === Number(prediction.home_score) &&
        Number(prediction.predicted_away_score) === Number(prediction.away_score)
      ) {
        correct += 1;
      }
    }
  }

  const [recentRows] = await pool.execute(
    `SELECT p.id, p.match_id, p.predicted_home_score, p.predicted_away_score,
            p.points, p.created_at, p.updated_at,
            m.home_team, m.away_team, m.competition, m.kickoff_at, m.status,
            m.home_score, m.away_score
       FROM predictions p
       JOIN matches m ON m.id = p.match_id
      WHERE p.user_id = ?
      ORDER BY p.created_at DESC
      LIMIT 5`,
    [userId]
  );

  const [upcomingRows] = await pool.execute(
    `SELECT id, home_team, away_team, competition, kickoff_at, status,
            home_score, away_score
       FROM matches
      WHERE status = 'scheduled' AND kickoff_at > UTC_TIMESTAMP()
      ORDER BY kickoff_at ASC
      LIMIT 5`
  );

  const leaderboard = await getLeaderboard();
  const myEntry = leaderboard.find((entry) => entry.user_id === userId);

  return {
    stats: {
      total: predictions.length,
      resolved,
      correct,
      accuracy: resolved ? Math.round((correct / resolved) * 100) : null,
      points,
    },
    rank: myEntry?.rank ?? null,
    recentPredictions: recentRows,
    upcomingMatches: upcomingRows,
  };
}