import { Router } from "express";

import { requireAuth } from "../middleware/auth.js";
import {
  getLeaderboard,
  getUserLeaderboardEntry,
} from "../services/leaderboardService.js";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const leaderboard = await getLeaderboard();
    return res.json({ leaderboard });
  } catch (err) {
    return next(err);
  }
});

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const entry = await getUserLeaderboardEntry(req.user.id);
    return res.json({ entry });
  } catch (err) {
    return next(err);
  }
});

export default router;