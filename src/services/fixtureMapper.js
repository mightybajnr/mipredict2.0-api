// Pure helpers that normalize API-Football fixture payloads into the shape
// used by Mi Predict's existing `matches` table. All date handling is UTC.

export const PROVIDER = "api-football";

export const TEAM_MAX_LENGTH = 100;
export const COMPETITION_MAX_LENGTH = 120;
export const MAX_GOALS = 255;

// Maps API-Football short status codes onto the application's existing status
// enum. The original provider code is always preserved separately so no
// distinction (e.g. abandoned vs cancelled) is lost.
const STATUS_MAP = {
  TBD: "scheduled",
  NS: "scheduled",
  SCH: "scheduled",

  "1H": "live",
  "2H": "live",
  HT: "live",
  ET: "live",
  BT: "live",
  P: "live",
  SUSP: "live",
  INT: "live",
  LIVE: "live",

  FT: "finished",
  AET: "finished",
  PEN: "finished",
  AWD: "finished",
  WO: "finished",

  PST: "postponed",

  CANC: "cancelled",
  ABD: "cancelled",
};

export function mapProviderStatus(short) {
  const code = String(short || "").toUpperCase();
  const status = STATUS_MAP[code] || "scheduled";

  return {
    providerStatus: code || null,
    status,
    known: Boolean(STATUS_MAP[code]),
    isFinal: status === "finished",
    isLive: status === "live",
  };
}

export function normalizeTeamName(value) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, TEAM_MAX_LENGTH);
}

export function normalizeCompetitionName(value) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, COMPETITION_MAX_LENGTH);
}

// Converts an ISO-8601 timestamp (with any offset) into a UTC
// "YYYY-MM-DD HH:MM:SS" string suitable for the DATETIME column.
export function toUtcDateTime(value) {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function nowUtcDateTime(date = new Date()) {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export function parseScore(value) {
  if (value === null || value === undefined || value === "") return null;

  const score = Number(value);
  return Number.isInteger(score) && score >= 0 && score <= MAX_GOALS
    ? score
    : null;
}

// Accepts a raw API-Football fixture object and returns a normalized object,
// or null when the record is unusable (missing id or kickoff).
export function normalizeFixture(raw) {
  if (!raw || typeof raw !== "object") return null;

  const fixture = raw.fixture || {};
  const league = raw.league || {};
  const teams = raw.teams || {};
  const goals = raw.goals || {};

  if (fixture.id === undefined || fixture.id === null) return null;

  const kickoffAt = toUtcDateTime(fixture.date);
  if (!kickoffAt) return null;

  const status = mapProviderStatus(fixture.status?.short);

  return {
    externalFixtureId: String(fixture.id),
    provider: PROVIDER,
    homeTeam: normalizeTeamName(teams.home?.name) || "Unknown",
    awayTeam: normalizeTeamName(teams.away?.name) || "Unknown",
    competition: normalizeCompetitionName(league.name) || "Unknown",
    leagueId: league.id != null ? Number(league.id) : null,
    season: league.season != null ? Number(league.season) : null,
    kickoffAt,
    status: status.status,
    providerStatus: status.providerStatus,
    isFinal: status.isFinal,
    isLive: status.isLive,
    homeScore: parseScore(goals.home),
    awayScore: parseScore(goals.away),
  };
}
