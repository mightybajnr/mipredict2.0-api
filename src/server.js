require("dotenv").config();

const express = require("express");
const cors = require("cors");
const pool = require("./config/db.js");

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL,
  })
);

app.use(express.json({ limit: "10kb" }));

app.get("/", (req, res) => {
  res.json({
    message: "Mi Predict API is running",
  });
});

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

const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
  console.log(`Mi Predict API listening on port ${port}`);
});

async function shutdown() {
  await pool.end();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);