import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  importFixtures,
  persistFixtures,
  resolveImportTargets,
} from "../src/services/fixtureSyncService.js";
import { ApiFootballError } from "../src/services/apiFootballClient.js";

const silent = { error() {}, log() {} };

function createFakeDb() {
  const connection = {
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  };

  const logs = [];

  return {
    logs,
    getConnection: async () => connection,
    async execute(sql, params) {
      if (/INSERT INTO sync_logs/i.test(sql)) logs.push(params);
      return [{ insertId: logs.length }, []];
    },
    async query() {
      return [[], []];
    },
  };
}

function createFakeRepository(seed = []) {
  const rows = new Map();
  const inserts = [];
  const updates = [];
  let nextId = 1;

  for (const row of seed) {
    const id = row.id ?? nextId++;
    rows.set(String(row.externalFixtureId), { id, ...row });
    nextId = Math.max(nextId, id + 1);
  }

  return {
    rows,
    inserts,
    updates,
    async findProviderMatch(_runner, externalFixtureId) {
      return rows.get(String(externalFixtureId)) || null;
    },
    async insertProviderMatch(_runner, fixture) {
      const id = nextId++;
      const row = {
        id,
        externalFixtureId: fixture.externalFixtureId,
        status: fixture.status,
        home_score: fixture.homeScore,
        away_score: fixture.awayScore,
        provider_status: fixture.providerStatus,
        kickoff_at: fixture.kickoffAt,
      };
      rows.set(String(fixture.externalFixtureId), row);
      inserts.push(row);
      return id;
    },
    async updateProviderMatch(_runner, id, fields) {
      updates.push({ id, fields });
      for (const row of rows.values()) {
        if (row.id === id) {
          row.status = fields.status;
          row.provider_status = fields.providerStatus;
          row.kickoff_at = fields.kickoffAt;
          if (fields.updateScores) {
            row.home_score = fields.homeScore;
            row.away_score = fields.awayScore;
          }
        }
      }
    },
  };
}

function createFakeClient({ fixtures = [], configured = true, error = null } = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: () => configured,
    async getFixtures(params) {
      calls.push(params);
      if (error) throw error;
      return { response: fixtures };
    },
  };
}

function rawFixture(id, { short = "NS", date = "2025-08-15T15:00:00Z", home = null, away = null } = {}) {
  return {
    fixture: { id, date, status: { short } },
    league: { id: 39, name: "Premier League", season: 2025 },
    teams: { home: { name: "Home FC" }, away: { name: "Away FC" } },
    goals: { home, away },
  };
}

function normalized(overrides = {}) {
  return {
    externalFixtureId: "1001",
    provider: "api-football",
    homeTeam: "Home FC",
    awayTeam: "Away FC",
    competition: "Premier League",
    kickoffAt: "2025-08-15 15:00:00",
    status: "scheduled",
    providerStatus: "NS",
    isFinal: false,
    isLive: false,
    homeScore: null,
    awayScore: null,
    ...overrides,
  };
}

describe("resolveImportTargets", () => {
  const saved = {
    leagues: process.env.API_FOOTBALL_LEAGUES,
    seasons: process.env.API_FOOTBALL_SEASONS,
  };

  afterEach(() => {
    process.env.API_FOOTBALL_LEAGUES = saved.leagues;
    process.env.API_FOOTBALL_SEASONS = saved.seasons;
  });

  it("prefers explicit targets and falls back to configuration", () => {
    process.env.API_FOOTBALL_LEAGUES = "39,140";
    process.env.API_FOOTBALL_SEASONS = "2025";

    assert.deepEqual(resolveImportTargets({ leagues: ["99"], seasons: ["2024"] }), {
      leagueList: ["99"],
      seasonList: ["2024"],
    });
    assert.deepEqual(resolveImportTargets({}), {
      leagueList: ["39", "140"],
      seasonList: ["2025"],
    });
  });
});

describe("persistFixtures", () => {
  it("inserts new fixtures and prevents duplicates on re-import", async () => {
    const db = createFakeDb();
    const repository = createFakeRepository();

    const first = await persistFixtures({
      fixtures: [normalized(), normalized({ externalFixtureId: "1002" })],
      db,
      repository,
    });

    assert.equal(first.inserted, 2);
    assert.equal(first.updated, 0);
    assert.equal(repository.rows.size, 2);

    const second = await persistFixtures({
      fixtures: [normalized(), normalized({ externalFixtureId: "1002" })],
      db,
      repository,
    });

    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 2);
    assert.equal(repository.rows.size, 2, "no duplicate rows created");
  });

  it("preserves a locally finalized score on re-import", async () => {
    const db = createFakeDb();
    const repository = createFakeRepository([
      {
        id: 5,
        externalFixtureId: "1001",
        status: "finished",
        home_score: 2,
        away_score: 1,
        provider_status: "FT",
      },
    ]);

    await persistFixtures({
      fixtures: [
        normalized({ status: "finished", providerStatus: "FT", homeScore: 3, awayScore: 1 }),
      ],
      db,
      repository,
    });

    const update = repository.updates.find((entry) => entry.id === 5);
    assert.ok(update);
    assert.equal(update.fields.updateScores, false);
    assert.equal(repository.rows.get("1001").home_score, 2);
    assert.equal(repository.rows.get("1001").away_score, 1);
  });
});

describe("importFixtures", () => {
  const saved = {
    leagues: process.env.API_FOOTBALL_LEAGUES,
    seasons: process.env.API_FOOTBALL_SEASONS,
  };

  afterEach(() => {
    process.env.API_FOOTBALL_LEAGUES = saved.leagues;
    process.env.API_FOOTBALL_SEASONS = saved.seasons;
  });

  beforeEach(() => {
    delete process.env.API_FOOTBALL_LEAGUES;
    delete process.env.API_FOOTBALL_SEASONS;
  });

  it("skips cleanly when no leagues or seasons are configured", async () => {
    const client = createFakeClient({ fixtures: [rawFixture(1)] });
    const result = await importFixtures({
      leagues: [],
      seasons: [],
      client,
      db: createFakeDb(),
      repository: createFakeRepository(),
      logger: silent,
    });

    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "no-leagues-or-seasons-configured");
    assert.equal(client.calls.length, 0, "provider must not be called");
  });

  it("throws a clear MISSING_KEY error when unconfigured", async () => {
    await assert.rejects(
      () =>
        importFixtures({
          leagues: ["39"],
          seasons: ["2025"],
          client: createFakeClient({ configured: false }),
          db: createFakeDb(),
          repository: createFakeRepository(),
          logger: silent,
        }),
      (err) => err instanceof ApiFootballError && err.code === "MISSING_KEY"
    );
  });

  it("imports fixtures and records a sync log", async () => {
    const db = createFakeDb();
    const repository = createFakeRepository();
    const client = createFakeClient({ fixtures: [rawFixture(1), rawFixture(2)] });

    const result = await importFixtures({
      leagues: ["39"],
      seasons: ["2025"],
      client,
      db,
      repository,
      logger: silent,
    });

    assert.equal(result.status, "success");
    assert.equal(result.inserted, 2);
    assert.equal(repository.rows.size, 2);
    assert.equal(client.calls.length, 1);
    assert.equal(db.logs.length, 1, "one sync log entry recorded");
  });

  it("degrades gracefully on provider errors", async () => {
    const client = createFakeClient({
      error: new ApiFootballError("PROVIDER_ERROR", "upstream down"),
    });

    const result = await importFixtures({
      leagues: ["39"],
      seasons: ["2025"],
      client,
      db: createFakeDb(),
      repository: createFakeRepository(),
      logger: silent,
    });

    assert.equal(result.errors, 1);
    assert.equal(result.inserted, 0);
    assert.equal(result.status, "error");
  });
});
