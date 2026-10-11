import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import { missingEnvVars } from "./config/env.js";
import pool from "./config/db.js";
import { apiLimiter, authLimiter } from "./middleware/rateLimit.js";
import {
  setCsrfCookie,
  csrfProtection,
  noStore,
  csrfTokenBootstrap,
} from "./middleware/csrf.js";
import { securityHeaders } from "./middleware/securityHeaders.js";
import authRouter from "./routes/auth.routes.js";
import matchesRouter from "./routes/matches.routes.js";
import predictionsRouter from "./routes/predictions.routes.js";
import leaderboardRouter from "./routes/leaderboard.routes.js";
import dashboardRouter from "./routes/dashboard.routes.js";
import usersRouter from "./routes/users.routes.js";
import adminRouter from "./routes/admin.routes.js";
import syncRouter from "./routes/sync.routes.js";
import { startSyncScheduler } from "./services/syncScheduler.js";
import { ensureApiFootballSchema } from "./services/schemaService.js";
import { apiFootballConfig } from "./config/apiFootball.js";
import { apiFootballClient } from "./services/apiFootballClient.js";
import { importFixtureWindow } from "./services/fixtureSyncService.js";
import { syncResults } from "./services/resultSyncService.js";

dotenv.config();

const missing = missingEnvVars();

if (missing.length) {
  console.error(
    `[env] Missing required environment variable(s): ${missing.join(", ")}`
  );
  process.exit(1);
}

const app = express();

app.disable("x-powered-by");

const rawTrustProxy = process.env.TRUST_PROXY;
const trustProxy =
  rawTrustProxy == null
    ? 1
    : rawTrustProxy === "0" || rawTrustProxy.toLowerCase() === "false"
      ? false
      : Number(rawTrustProxy) || true;

app.set("trust proxy", trustProxy);

const allowedOrigins = process.env.FRONTEND_URL.split(",")
  .map((origin) => origin.trim().toLowerCase())
  .filter(Boolean);

app.use("/api", noStore);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "X-CSRF-Token"],
    credentials: true,
  })
);

app.use(securityHeaders);
app.use(express.json({ limit: "10kb" }));
app.use(cookieParser());

app.use(setCsrfCookie);

// Rate limits run before CSRF checks so malformed requests are still
// throttled instead of bypassing the limiters.
app.use("/api", apiLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signup", authLimiter);
app.use("/api/auth/logout", authLimiter);

app.use(csrfProtection);

app.get("/", (req, res) => {
  res.json({
    message: "Mi Predict API is running",
  });
});

app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/api/csrf-token", csrfTokenBootstrap);

app.get("/api/health/db", async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT 1 AS connected");

    res.json({
      status: "ok",
      database: rows[0].connected === 1 ? "connected" : "unknown",
    });
  } catch (error) {
    console.error("Database health check failed:", error.code);

    res.status(503).json({
      status: "error",
      message: "Database connection unavailable",
    });
  }
});

app.use("/api/auth", authRouter);
app.use("/api/matches", matchesRouter);
app.use("/api/predictions", predictionsRouter);
app.use("/api/leaderboard", leaderboardRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/users", usersRouter);
app.use("/api/admin", adminRouter);
app.use("/api/admin/sync", syncRouter);

app.use((req, res) => {
  res.status(404).json({ message: "Not found." });
});

app.use((err, req, res, next) => {
  const isProd = process.env.NODE_ENV === "production";
  const status =
    err?.type === "entity.parse.failed"
      ? 400
      : err?.type === "entity.too.large"
        ? 413
        : err?.statusCode && err.statusCode >= 400 && err.statusCode < 500
          ? err.statusCode
          : 500;

  if (status >= 500) {
    console.error(err);
  }

  const message =
    status >= 500
      ? isProd
        ? "Something went wrong."
        : err?.message || "Something went wrong."
      : status === 413
        ? "Request body too large."
        : "Invalid or malformed request.";

  res.status(status).json({ message });
});

const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
  console.log(`Mi Predict API listening on port ${port}`);

  bootstrap();
});

// Guarantees the API-Football schema before any sync runs, then starts the
// optional scheduler and/or the one-shot startup import.
async function bootstrap() {
  try {
    const result = await ensureApiFootballSchema();

    if (result.applied.length) {
      console.log(`[schema] applied: ${result.applied.join(", ")}`);
    }
  } catch (err) {
    // Never crash the API because of a provisioning problem; sync endpoints
    // will surface a clear error until the schema is available.
    console.error(`[schema] ensure failed: ${err.code || err.message}`);
  }

  // Disabled by default; see SYNC_SCHEDULE_ENABLED. A guarded singleton with a
  // MySQL advisory lock avoids duplicate loops across restarts/scaling.
  startSyncScheduler();

  maybeRunStartupSync();
}

// Populates real fixtures on a fresh production deploy even when the optional
// in-process scheduler is disabled. Never runs in tests/dev (NODE_ENV guard),
// does nothing without an API key, and defers to the scheduler when enabled.
function maybeRunStartupSync() {
  const config = apiFootballConfig();

  if (process.env.NODE_ENV !== "production") return;
  if (!config.startupSyncEnabled) return;
  if (!apiFootballClient.isConfigured()) return;
  if (config.scheduleEnabled) return;

  runStartupSync().catch((err) => {
    console.error(`[startup-sync] failed: ${err.code || err.message}`);
  });
}

async function runStartupSync() {
  console.log("[startup-sync] importing fixtures for the current window...");

  const fixtures = await importFixtureWindow();

  console.log(
    `[startup-sync] fixtures inserted=${fixtures.inserted} updated=${fixtures.updated} errors=${fixtures.errors} (${fixtures.from}..${fixtures.to})`
  );

  await syncResults({ mode: "live" }).catch((err) => {
    console.error(`[startup-sync] results failed: ${err.code || err.message}`);
  });
}

async function shutdown() {
  await pool.end();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);