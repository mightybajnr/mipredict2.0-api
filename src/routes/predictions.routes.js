import { Router } from "express";

import { requireAuth } from "../middleware/auth.js";
import {
  listUserPredictions,
  normalizePredictionFilter,
} from "../services/predictionService.js";

const router = Router();

async function getMyPredictions(req, res, next) {
  try {
    const status = normalizePredictionFilter(req.query.status);
    const predictions = await listUserPredictions(req.user.id, status);

    return res.json({ predictions, status });
  } catch (err) {
    return next(err);
  }
}

router.get("/", requireAuth, getMyPredictions);
router.get("/me", requireAuth, getMyPredictions);

export default router;