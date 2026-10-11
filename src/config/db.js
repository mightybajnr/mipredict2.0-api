import "dotenv/config";
import mysql from "mysql2/promise";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { missingEnvVars } from "./env.js";

const missing = missingEnvVars("db");

if (missing.length) {
  throw new Error(
    `[env] Missing required database environment variable(s): ${missing.join(
      ", "
    )}.`
  );
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadCaCert() {
  if (process.env.DB_CA_CERT) {
    return process.env.DB_CA_CERT.replace(/\\n/g, "\n");
  }

  const caPath = path.join(__dirname, "../../certs/ca.pem");
  return fs.readFileSync(caPath, "utf8");
}

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  ssl: {
    ca: loadCaCert(),
    rejectUnauthorized: true,
  },

  timezone: "Z",

  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export default pool;