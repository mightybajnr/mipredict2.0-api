import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  syncResults,
  buildResultQuery,
} from "../src/services/resultSyncService.js";
import { ApiFootballError } from "../src/services/apiFootballClient.js";

const silent = { error() {}, log() {} };

function createFakeDb() {
  const logs = [];
  return {
    logs,
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
  const updates = [];

  for (const row of seed) {
    rows.set(String(row.externalFixtureId), { ...row });
  }

  return {
    rows,
    updates,
    async findProviderMatch(_runner, externalFixtureId) {
      return rows.get(String(externalFixtureId)) || null;
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

function createFakeClient({ fixtures = [], configured = true } = {}) {
  const calls = [];
  return {
    calls,
    isConfigured: () => configured,
    async getFixtures(params) {
      calls.push(params);
      return { response: fixtures };
    },
  };
}

function rawFixture(id, { short = "NS", home = null, away = null } = {}) {
  return {
    fixture: { id, date: "2025-08-15T15:00:00Z", status: { short } },
    league: { id: 39, name: "Premier League", season: 2025 },
    teams: { home: { name: "Home FC" }, away: { name: "Away FC" } },
    goals: { home, away },
  };
}

function finalizeSpy() {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
  };
  fn.calls = calls;
  return fn;
}

describe("buildResultQuery", () => {
  it("builds a live query by default", () => {
    assert.deepEqual(buildResultQuery({}), { live: "all" });
    assert.deepEqual(buildResultQuery({ mode: "unknown" }), { live: "all" });
  });

  it("builds date and league queries", () => {
    assert.deepEqual(buildResultQuery({ mode: "date", date: "2025-08-15", league: 39 }), {
      date: "2025-08-15",
      league: 39,
    });
    assert.deepEqual(buildResultQuery({ mode: "league", league: 39, season: 2025 }), {
      league: 39,
      season: 2025,
    });
  });
});

describe("syncResults", () => {
  it("updates live scores and status without awarding points", async () => {
    const repository = createFakeRepository([
      { id: 10, externalFixtureId: "2001", status: "scheduled", home_score: null, away_score: null },
    ]);
    const finalize = finalizeSpy();

    const result = await syncResults({
      client: createFakeClient({ fixtures: [rawFixture(2001, { short: "2H", home: 1, away: 0 })] }),
      db: createFakeDb(),
      repository,
      finalize,
      logger: silent,
    });

    assert.equal(result.updated, 1);
    assert.equal(result.finalized, 0);
    assert.equal(finalize.calls.length, 0);
    assert.equal(repository.rows.get("2001").status, "live");
    assert.equal(repository.rows.get("2001").home_score, 1);
    assert.equal(repository.rows.get("2001").away_score, 0);
  });

  it("finalizes finished results through the scoring path", async () => {
    const repository = createFakeRepository([
      { id: 11, externalFixtureId: "2002", status: "live", home_score: 2, away_score: 0 },
    ]);
    const finalize = finalizeSpy();

    const result = await syncResults({
      client: createFakeClient({ fixtures: [rawFixture(2002, { short: "FT", home: 2, away: 1 })] }),
      db: createFakeDb(),
      repository,
      finalize,
      logger: silent,
    });

    assert.equal(result.finalized, 1);
    assert.equal(finalize.calls.length, 1);
    assert.equal(finalize.calls[0].matchId, 11);
    assert.equal(finalize.calls[0].homeScore, 2);
    assert.equal(finalize.calls[0].awayScore, 1);
    assert.equal(finalize.calls[0].providerStatus, "FT");
  });

  it("does not re-finalize an already finalized identical result", async () => {
    const repository = createFakeRepository([
      { id: 12, externalFixtureId: "2003", status: "finished", home_score: 2, away_score: 1 },
    ]);
    const finalize = finalizeSpy();

    const result = await syncResults({
      client: createFakeClient({ fixtures: [rawFixture(2003, { short: "FT", home: 2, away: 1 })] }),
      db: createFakeDb(),
      repository,
      finalize,
      logger: silent,
    });

    assert.equal(result.finalized, 0);
    assert.equal(result.updated, 1);
    assert.equal(finalize.calls.length, 0, "idempotent: no repeated scoring");
  });

  it("skips fixtures that were never imported", async () => {
    const result = await syncResults({
      client: createFakeClient({ fixtures: [rawFixture(9999, { short: "FT", home: 1, away: 0 })] }),
      db: createFakeDb(),
      repository: createFakeRepository(),
      finalize: finalizeSpy(),
      logger: silent,
    });

    assert.equal(result.skipped, 1);
    assert.equal(result.finalized, 0);
  });

  it("never clears awarded scores on postponed matches", async () => {
    const repository = createFakeRepository([
      { id: 13, externalFixtureId: "2004", status: "finished", home_score: 2, away_score: 1 },
    ]);
    const finalize = finalizeSpy();

    await syncResults({
      client: createFakeClient({ fixtures: [rawFixture(2004, { short: "PST" })] }),
      db: createFakeDb(),
      repository,
      finalize,
      logger: silent,
    });

    assert.equal(repository.rows.get("2004").home_score, 2);
    assert.equal(repository.rows.get("2004").away_score, 1);
    assert.equal(repository.rows.get("2004").status, "postponed");
    assert.equal(finalize.calls.length, 0);
  });

  it("throws MISSING_KEY when unconfigured", async () => {
    await assert.rejects(
      () =>
        syncResults({
          client: createFakeClient({ configured: false }),
          db: createFakeDb(),
          repository: createFakeRepository(),
          finalize: finalizeSpy(),
          logger: silent,
        }),
      (err) => err instanceof ApiFootballError && err.code === "MISSING_KEY"
    );
  });

  it("records a sync log entry", async () => {
    const db = createFakeDb();

    await syncResults({
      client: createFakeClient({ fixtures: [] }),
      db,
      repository: createFakeRepository(),
      finalize: finalizeSpy(),
      logger: silent,
    });

    assert.equal(db.logs.length, 1);
  });
});
