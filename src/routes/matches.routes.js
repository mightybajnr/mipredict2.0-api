import { Router } from "express";

import { requireAuth } from "../middleware/auth.js";
import {
  listMatches,
  getMatchById,
  upsertPrediction,
  normalizeMatchFilter,
  PredictionError,
} from "../services/matchService.js";
import { getUserPredictionByMatch } from "../services/predictionService.js";
import { validateScore } from "../utils/validation.js";

const router = Router();

function parseMatchId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

router.get("/", async (req, res, next) => {
  try {
    const status = normalizeMatchFilter(req.query.status);
    const result = await listMatches({
      status,
      competition: req.query.competition,
      team: req.query.team,
      date: req.query.date,
      page: req.query.page,
      limit: req.query.limit,
    });

    return res.json({
      matches: result.matches,
      status,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id/predictions/me", requireAuth, async (req, res, next) => {
  try {
    const matchId = parseMatchId(req.params.id);

    if (!matchId) {
      return res.status(400).json({ message: "Invalid match id." });
    }

    const prediction = await getUserPredictionByMatch(req.user.id, matchId);

    return res.json({ prediction });
  } catch (err) {
    return next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const matchId = parseMatchId(req.params.id);

    if (!matchId) {
      return res.status(400).json({ message: "Invalid match id." });
    }

    const match = await getMatchById(matchId);

    if (!match) {
      return res.status(404).json({ message: "Match not found." });
    }

    return res.json({ match });
  } catch (err) {
    return next(err);
  }
});

router.post("/:id/predictions", requireAuth, async (req, res, next) => {
  try {
    const matchId = parseMatchId(req.params.id);

    if (!matchId) {
      return res.status(400).json({ message: "Invalid match id." });
    }

    const body = req.body || {};
    const homeScore = body.predicted_home_score;
    const awayScore = body.predicted_away_score;

    const error =
      validateScore(homeScore, "Home score") ||
      validateScore(awayScore, "Away score");

    if (error) {
      return res.status(400).json({ message: error });
    }

    const result = await upsertPrediction({
      userId: req.user.id,
      matchId,
      homeScore: Number(homeScore),
      awayScore: Number(awayScore),
    });

    return res
      .status(result.updated ? 200 : 201)
      .json({ prediction: result.prediction, updated: result.updated });
  } catch (err) {
    if (err instanceof PredictionError) {
      const status = err.code === "MATCH_NOT_FOUND" ? 404 : 409;
      return res.status(status).json({ message: err.message });
    }

    return next(err);
  }
});

export default router;