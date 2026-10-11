import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  ensureApiFootballSchema,
  MATCH_COLUMNS,
  UNIQUE_INDEX_NAME,
  PROVIDER_INDEX_NAME,
} from "../src/services/schemaService.js";

const silent = { log() {}, error() {} };

// Stateful fake of the `pool.query` / pool.execute` contract used by the
// schema service. `execute` answers INFORMATION_SCHEMA probes; `query` records
// DDL so the test can assert exactly what was applied without a database.
function createFakeDb({
  matchesExists = true,
  columns = [],
  indexes = [],
  alterError = null,
} = {}) {
  const alters = [];
  const creates = [];

  return {
    alters,
    creates,
    async execute(sql, params) {
      if (/INFORMATION_SCHEMA.TABLES/i.test(sql)) {
        return [matchesExists ? [{ present: 1 }] : [], []];
      }

      if (/INFORMATION_SCHEMA.COLUMNS/i.test(sql)) {
        return [columns.includes(params[2]) ? [{ present: 1 }] : [], []];
      }

      if (/INFORMATION_SCHEMA.STATISTICS/i.test(sql)) {
        return [indexes.includes(params[2]) ? [{ present: 1 }] : [], []];
      }

      return [[], []];
    },
    async query(sql) {
      if (/ALTER TABLE/i.test(sql)) {
        if (alterError) throw alterError;
        alters.push(sql);
      } else if (/CREATE TABLE/i.test(sql)) {
        creates.push(sql);
      }

      return [{}, []];
    },
  };
}

describe("ensureApiFootballSchema", () => {
  it("throws a clear error when the matches table is missing", async () => {
    await assert.rejects(
      () => ensureApiFootballSchema({ db: createFakeDb({ matchesExists: false }), schema: "defaultdb", logger: silent }),
      /matches` table does not exist/
    );
  });

  it("adds every missing column, both indexes and the sync_logs table", async () => {
    const db = createFakeDb();
    const result = await ensureApiFootballSchema({ db, schema: "defaultdb", logger: silent });

    assert.equal(db.alters.length, MATCH_COLUMNS.length + 2);
    assert.equal(db.creates.length, 1);
    assert.match(db.creates[0], /CREATE TABLE IF NOT EXISTS sync_logs/i);

    for (const column of MATCH_COLUMNS) {
      assert.ok(
        db.alters.some((sql) => sql.includes(`\`${column.name}\``)),
        `expected ALTER for ${column.name}`
      );
    }

    assert.ok(result.applied.includes("column:provider"));
    assert.ok(result.applied.includes("column:home_team_logo"));
    assert.ok(result.applied.includes("column:away_team_logo"));
    assert.ok(result.applied.includes(`index:${UNIQUE_INDEX_NAME}`));
    assert.ok(result.applied.includes(`index:${PROVIDER_INDEX_NAME}`));
    assert.equal(result.syncLogsEnsured, true);
  });

  it("is idempotent: applies nothing when the schema is already present", async () => {
    const db = createFakeDb({
      columns: MATCH_COLUMNS.map((column) => column.name),
      indexes: [UNIQUE_INDEX_NAME, PROVIDER_INDEX_NAME],
    });

    const result = await ensureApiFootballSchema({ db, schema: "defaultdb", logger: silent });

    assert.equal(db.alters.length, 0);
    assert.deepEqual(result.applied, []);
    // CREATE TABLE IF NOT EXISTS still runs but is a no-op.
    assert.equal(db.creates.length, 1);
  });

  it("is race-safe: swallows duplicate column/index errors from concurrent startups", async () => {
    const duplicate = Object.assign(new Error("duplicate"), {
      code: "ER_DUP_FIELDNAME",
    });

    const result = await ensureApiFootballSchema({
      db: createFakeDb({ alterError: duplicate }),
      schema: "defaultdb",
      logger: silent,
    });

    assert.deepEqual(result.applied, []);
  });
});
