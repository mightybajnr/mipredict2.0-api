import crypto from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";

import pool from "../config/db.js";
import { rotateCsrfCookie, csrfTokenFrom } from "../middleware/csrf.js";
import {
  validateName,
  validateEmail,
  validatePassword,
} from "../utils/validation.js";

const COOKIE_NAME = "mi_predict_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const isProd = process.env.NODE_ENV === "production";

const router = Router();

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function toPublicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
  };
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  await pool.execute(
    "INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [userId, hashToken(token), expiresAt]
  );

  res.cookie(COOKIE_NAME, token, cookieOptions());
  rotateCsrfCookie(res);
}

async function findSessionUser(token) {
  const [rows] = await pool.execute(
    `SELECT u.id, u.name, u.email
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP()
      LIMIT 1`,
    [hashToken(token)]
  );

  return rows.length ? toPublicUser(rows[0]) : null;
}

router.post("/signup", async (req, res) => {
  const body = req.body || {};
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  const error =
    validateName(name) || validateEmail(email) || validatePassword(password);

  if (error) {
    return res.status(400).json({ message: error });
  }

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const [result] = await pool.execute(
      "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
      [name, email, passwordHash]
    );

    await createSession(res, result.insertId);

    return res.status(201).json({
      user: { id: result.insertId, name, email },
      csrfToken: csrfTokenFrom(req, res),
    });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res
        .status(409)
        .json({ message: "An account with this email already exists." });
    }

    throw err;
  }
});

router.post("/login", async (req, res) => {
  const body = req.body || {};
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (validateEmail(email) || validatePassword(password)) {
    return res.status(400).json({ message: "Enter a valid email and password." });
  }

  const [rows] = await pool.execute(
    "SELECT id, name, email, password_hash FROM users WHERE email = ? LIMIT 1",
    [email]
  );

  const user = rows[0];
  const passwordMatches =
    user && (await bcrypt.compare(password, user.password_hash));

  if (!passwordMatches) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  await createSession(res, user.id);

  return res.json({ user: toPublicUser(user), csrfToken: csrfTokenFrom(req, res) });
});

router.get("/me", async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];

  if (!token) {
    return res.status(401).json({
      message: "Not signed in.",
      csrfToken: csrfTokenFrom(req, res),
    });
  }

  const user = await findSessionUser(token);

  if (!user) {
    return res.status(401).json({
      message: "Your session has expired. Please sign in again.",
      csrfToken: csrfTokenFrom(req, res),
    });
  }

  return res.json({ user, csrfToken: csrfTokenFrom(req, res) });
});

router.post("/logout", async (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];

  if (token) {
    await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [
      hashToken(token),
    ]);
  }

  res.clearCookie(COOKIE_NAME, cookieOptions());
  rotateCsrfCookie(res);

  return res.json({ success: true, csrfToken: csrfTokenFrom(req, res) });
});

export default router;