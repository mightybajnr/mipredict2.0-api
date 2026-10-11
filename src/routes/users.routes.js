import { Router } from "express";

import { requireAuth } from "../middleware/auth.js";

const router = Router();

router.get("/me", requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

export default router;