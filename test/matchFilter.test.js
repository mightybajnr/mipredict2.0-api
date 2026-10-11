import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildMatchFilter } from "../src/services/matchService.js";

describe("buildMatchFilter", () => {
  it("defaults to upcoming and orders ascending", () => {
    const { where, params, order } = buildMatchFilter({});
    assert.match(where, /m\.status = 'scheduled'/);
    assert.match(where, /m\.kickoff_at > UTC_TIMESTAMP\(\)/);
    assert.equal(order, "m.kickoff_at ASC");
    assert.deepEqual(params, []);
  });

  it("treats 'all' as unfiltered and orders by most recent", () => {
    const { where, order } = buildMatchFilter({ status: "all" });
    assert.equal(where, "WHERE 1 = 1");
    assert.equal(order, "m.kickoff_at DESC");
  });

  it("escapes LIKE wildcards in competition and team filters", () => {
    const { params } = buildMatchFilter({
      status: "all",
      competition: "Premier%_League",
      team: "50%_off",
    });

    assert.deepEqual(params, [
      "%Premier\\%\\_League%",
      "%50\\%\\_off%",
      "%50\\%\\_off%",
    ]);
  });

  it("matches a team on either side", () => {
    const { where, params } = buildMatchFilter({ status: "all", team: "Barcelona" });
    assert.match(where, /m\.home_team LIKE \?/);
    assert.match(where, /m\.away_team LIKE \?/);
    assert.deepEqual(params, ["%Barcelona%", "%Barcelona%"]);
  });

  it("applies an ISO date filter but ignores malformed dates", () => {
    const applied = buildMatchFilter({ status: "all", date: "2025-08-15" });
    assert.match(applied.where, /DATE\(m\.kickoff_at\) = \?/);
    assert.deepEqual(applied.params, ["2025-08-15"]);

    const ignored = buildMatchFilter({ status: "all", date: "15-08-2025" });
    assert.doesNotMatch(ignored.where, /DATE\(m\.kickoff_at\)/);
    assert.deepEqual(ignored.params, []);
  });
});
