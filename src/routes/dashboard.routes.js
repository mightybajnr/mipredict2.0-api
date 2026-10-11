import { Router } from "express";

import { requireAuth } from "../middleware/auth.js";
import { getDashboardSummary } from "../services/dashboardService.js";

const router = Router();

router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const summary = await getDashboardSummary(req.user.id);
    return res.json(summary);
  } catch (err) {
    return next(err);
  }
});

export default router;