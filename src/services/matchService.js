import pool from "../config/db.js";

export class PredictionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PredictionError";
    this.code = code;
  }
}

const MATCH_COLUMNS = `m.id, m.home_team, m.away_team, m.competition, m.kickoff_at,
                       m.status, m.home_score, m.away_score`;

const MATCH_FILTERS = {
  upcoming: {
    where: "m.status = 'scheduled' AND m.kickoff_at > UTC_TIMESTAMP()",
    order: "m.kickoff_at ASC",
  },
  live: {
    where: "m.status = 'live'",
    order: "m.kickoff_at ASC",
  },
  finished: {
    where: "m.status = 'finished'",
    order: "m.kickoff_at DESC",
  },
  all: {
    where: "1 = 1",
    order: "m.kickoff_at DESC",
  },
};

export function normalizeMatchFilter(value) {
  return MATCH_FILTERS[value] ? value : "upcoming";
}

function toPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
}

export async function listMatches({
  status = "upcoming",
  competition,
  page = 1,
  limit = 50,
} = {}) {
  const pageNum = toPositiveInt(page, 1);
  const limitNum = Math.min(100, toPositiveInt(limit, 50));
  const filter = MATCH_FILTERS[normalizeMatchFilter(status)];

  const conditions = [filter.where];
  const params = [];

  if (competition) {
    conditions.push("m.competition LIKE ? ESCAPE '\\\\'");
    params.push(`%${escapeLike(competition)}%`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const offset = (pageNum - 1) * limitNum;

  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
       FROM matches m
       ${whereClause}`,
    params
  );

  const [rows] = await pool.query(
    `SELECT ${MATCH_COLUMNS}
       FROM matches m
       ${whereClause}
      ORDER BY ${filter.order}
      LIMIT ? OFFSET ?`,
    [...params, limitNum, offset]
  );

  return {
    matches: rows,
    total: Number(total),
    page: pageNum,
    limit: limitNum,
    totalPages: Math.max(1, Math.ceil(Number(total) / limitNum)),
  };
}

export function listUpcomingMatches() {
  return listMatches({ status: "upcoming" });
}

export async function getMatchById(id) {
  const [rows] = await pool.execute(
    `SELECT id, home_team, away_team, competition, kickoff_at, status,
            home_score, away_score, created_at, updated_at
       FROM matches
      WHERE id = ?
      LIMIT 1`,
    [id]
  );

  return rows[0] || null;
}

export async function upsertPrediction({
  userId,
  matchId,
  homeScore,
  awayScore,
}) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const [rows] = await connection.execute(
      `SELECT status, kickoff_at, (kickoff_at > UTC_TIMESTAMP()) AS before_kickoff
         FROM matches
        WHERE id = ?
        FOR UPDATE`,
      [matchId]
    );

    const match = rows[0];

    if (!match) {
      throw new PredictionError("MATCH_NOT_FOUND", "Match not found.");
    }

    if (match.status !== "scheduled" || !Number(match.before_kickoff)) {
      throw new PredictionError(
        "PREDICTION_LOCKED",
        "Predictions are closed for this match."
      );
    }

    const [existingRows] = await connection.execute(
      `SELECT id
         FROM predictions
        WHERE user_id = ? AND match_id = ?
        LIMIT 1`,
      [userId, matchId]
    );

    const updated = existingRows.length > 0;

    if (updated) {
      await connection.execute(
        `UPDATE predictions
            SET predicted_home_score = ?, predicted_away_score = ?
          WHERE user_id = ? AND match_id = ?`,
        [homeScore, awayScore, userId, matchId]
      );
    } else {
      await connection.execute(
        `INSERT INTO predictions
           (user_id, match_id, predicted_home_score, predicted_away_score)
         VALUES (?, ?, ?, ?)`,
        [userId, matchId, homeScore, awayScore]
      );
    }

    const [predictionRows] = await connection.execute(
      `SELECT id, user_id, match_id, predicted_home_score,
              predicted_away_score, points, created_at, updated_at
         FROM predictions
        WHERE user_id = ? AND match_id = ?
        LIMIT 1`,
      [userId, matchId]
    );

    await connection.commit();

    return { prediction: predictionRows[0], updated };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}