import rateLimit from "express-rate-limit";

function createLimiter({ windowMs, limit }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (req, res) => {
      res.status(429).json({ message: "Too many requests. Try again later." });
    },
  });
}

export const apiLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  limit: 300,
});

export const authLimiter = createLimiter({
  windowMs: 10 * 60 * 1000,
  limit: 10,
});