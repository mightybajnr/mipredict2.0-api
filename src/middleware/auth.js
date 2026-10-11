import crypto from "node:crypto";

import pool from "../config/db.js";

const COOKIE_NAME = "mi_predict_session";

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];

    if (!token) {
      return res.status(401).json({ message: "Not signed in." });
    }

    const [rows] = await pool.execute(
      `SELECT u.id, u.name, u.email
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()
        LIMIT 1`,
      [hashToken(token)]
    );

    if (!rows.length) {
      return res
        .status(401)
        .json({ message: "Your session has expired. Please sign in again." });
    }

    req.user = rows[0];
    return next();
  } catch (err) {
    return next(err);
  }
}

export function requireAdmin(req, res, next) {
  const admins = (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  if (!admins.includes(String(req.user?.email || "").toLowerCase())) {
    return res.status(403).json({ message: "Admins only." });
  }

  return next();
}
