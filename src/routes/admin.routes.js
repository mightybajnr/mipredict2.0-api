import { Router } from "express";

import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { PredictionError } from "../services/matchService.js";
import { finalizeMatchResult } from "../services/scoringService.js";
import { validateScore } from "../utils/validation.js";

const router = Router();

router.post(
  "/matches/:id/result",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const matchId = Number(req.params.id);

      if (!Number.isInteger(matchId) || matchId <= 0) {
        return res.status(400).json({ message: "Invalid match id." });
      }

      const body = req.body || {};
      const homeScore = body.home_score;
      const awayScore = body.away_score;

      const error =
        validateScore(homeScore, "Home score") ||
        validateScore(awayScore, "Away score");

      if (error) {
        return res.status(400).json({ message: error });
      }

      const result = await finalizeMatchResult({
        matchId,
        homeScore: Number(homeScore),
        awayScore: Number(awayScore),
      });

      return res.json({
        message: "Match result finalized and predictions scored.",
        result,
      });
    } catch (err) {
      if (err instanceof PredictionError) {
        const status = err.code === "MATCH_NOT_FOUND" ? 404 : 409;
        return res.status(status).json({ message: err.message });
      }

      return next(err);
    }
  }
);

export default router;