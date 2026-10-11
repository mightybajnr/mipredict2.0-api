import "dotenv/config";

const REQUIRED_DB_ENV = [
  "DB_HOST",
  "DB_PORT",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
];

const REQUIRED_SERVER_ENV = ["FRONTEND_URL"];

export function missingEnvVars(scope = "all") {
  const required =
    scope === "db"
      ? REQUIRED_DB_ENV
      : [...REQUIRED_DB_ENV, ...REQUIRED_SERVER_ENV];

  return required.filter((key) => !process.env[key]);
}