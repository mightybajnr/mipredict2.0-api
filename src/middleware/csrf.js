import crypto from "node:crypto";

const isProd = process.env.NODE_ENV === "production";

export const CSRF_COOKIE_NAME = "XSRF-TOKEN";
export const CSRF_HEADER = "x-csrf-token";

const CSRF_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function csrfCookieOptions() {
  return {
    httpOnly: false,
    sameSite: isProd ? "none" : "lax",
    secure: isProd,
    path: "/",
    maxAge: CSRF_TTL_MS,
  };
}

export function generateCsrfToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function setCsrfCookie(req, res, next) {
  if (!req.cookies?.[CSRF_COOKIE_NAME]) {
    const token = generateCsrfToken();
    res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions());

    // Mirror the fresh token into req.cookies so the first response
    // (e.g. GET /api/auth/me) can echo it back to the client from the
    // body, which is required for cross-origin (subdomain) deployments
    // where document.cookie cannot be read by the frontend.
    req.cookies = req.cookies || {};
    req.cookies[CSRF_COOKIE_NAME] = token;
  }

  return next();
}

export function rotateCsrfCookie(res) {
  const token = generateCsrfToken();
  res.locals.csrfToken = token;
  res.cookie(CSRF_COOKIE_NAME, token, csrfCookieOptions());
  return token;
}

export function csrfTokenFrom(req, res) {
  return res.locals?.csrfToken || req.cookies?.[CSRF_COOKIE_NAME] || null;
}

export function csrfProtection(req, res, next) {
  if (!UNSAFE_METHODS.has(req.method)) {
    return next();
  }

  const cookieToken = req.cookies?.[CSRF_COOKIE_NAME];
  const headerToken = req.headers[CSRF_HEADER];

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({
      message: "Invalid or missing CSRF token.",
    });
  }

  return next();
}