import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  mapProviderStatus,
  normalizeFixture,
  normalizeTeamName,
  normalizeCompetitionName,
  normalizeLogoUrl,
  deriveSeason,
  parseScore,
  toUtcDateTime,
  nowUtcDateTime,
} from "../src/services/fixtureMapper.js";

describe("toUtcDateTime", () => {
  it("converts UTC ISO timestamps to MySQL DATETIME strings", () => {
    assert.equal(toUtcDateTime("2025-08-15T15:00:00+00:00"), "2025-08-15 15:00:00");
    assert.equal(toUtcDateTime("2025-08-15T15:00:00Z"), "2025-08-15 15:00:00");
  });

  it("normalizes non-UTC offsets to UTC", () => {
    assert.equal(toUtcDateTime("2025-08-15T17:00:00+02:00"), "2025-08-15 15:00:00");
    assert.equal(toUtcDateTime("2025-08-15T10:00:00-05:00"), "2025-08-15 15:00:00");
  });

  it("returns null for missing or invalid input", () => {
    assert.equal(toUtcDateTime(null), null);
    assert.equal(toUtcDateTime(""), null);
    assert.equal(toUtcDateTime("not-a-date"), null);
  });
});

describe("nowUtcDateTime", () => {
  it("formats a fixed date deterministically", () => {
    assert.equal(
      nowUtcDateTime(new Date("2025-01-02T03:04:05Z")),
      "2025-01-02 03:04:05"
    );
  });
});

describe("mapProviderStatus", () => {
  const cases = [
    ["NS", "scheduled"],
    ["TBD", "scheduled"],
    ["1H", "live"],
    ["HT", "live"],
    ["2H", "live"],
    ["ET", "live"],
    ["P", "live"],
    ["FT", "finished"],
    ["AET", "finished"],
    ["PEN", "finished"],
    ["AWD", "finished"],
    ["WO", "finished"],
    ["PST", "postponed"],
    ["CANC", "cancelled"],
    ["ABD", "cancelled"],
  ];

  for (const [code, expected] of cases) {
    it(`maps ${code} to ${expected}`, () => {
      const result = mapProviderStatus(code);
      assert.equal(result.status, expected);
      assert.equal(result.providerStatus, code);
      assert.equal(result.known, true);
    });
  }

  it("preserves the raw provider code and flags final/live", () => {
    assert.equal(mapProviderStatus("FT").isFinal, true);
    assert.equal(mapProviderStatus("1H").isLive, true);
    assert.equal(mapProviderStatus("NS").isFinal, false);
  });

  it("is case-insensitive and defaults unknown codes to scheduled", () => {
    assert.equal(mapProviderStatus("ft").status, "finished");
    const unknown = mapProviderStatus("ZZZ");
    assert.equal(unknown.status, "scheduled");
    assert.equal(unknown.known, false);
  });
});

describe("score and name normalization", () => {
  it("parses valid scores and rejects invalid ones", () => {
    assert.equal(parseScore(0), 0);
    assert.equal(parseScore("3"), 3);
    assert.equal(parseScore(null), null);
    assert.equal(parseScore(""), null);
    assert.equal(parseScore(-1), null);
    assert.equal(parseScore(2.5), null);
    assert.equal(parseScore(9999), null);
  });

  it("collapses whitespace and trims team names", () => {
    assert.equal(normalizeTeamName("  Real   Madrid  "), "Real Madrid");
  });

  it("enforces column length limits", () => {
    assert.equal(normalizeTeamName("x".repeat(200)).length, 100);
    assert.equal(normalizeCompetitionName("y".repeat(200)).length, 120);
  });
});

describe("normalizeLogoUrl", () => {
  it("keeps absolute http(s) URLs", () => {
    assert.equal(
      normalizeLogoUrl("https://media.api-sports.io/football/teams/529.png"),
      "https://media.api-sports.io/football/teams/529.png"
    );
    assert.equal(normalizeLogoUrl("http://example.com/a.png"), "http://example.com/a.png");
  });

  it("rejects unsafe, relative, empty and oversized values", () => {
    assert.equal(normalizeLogoUrl("javascript:alert(1)"), null);
    assert.equal(normalizeLogoUrl("data:image/png;base64,AAAA"), null);
    assert.equal(normalizeLogoUrl("/relative/logo.png"), null);
    assert.equal(normalizeLogoUrl(""), null);
    assert.equal(normalizeLogoUrl(null), null);
    assert.equal(normalizeLogoUrl(`https://x.com/${"a".repeat(300)}.png`), null);
  });
});

describe("deriveSeason", () => {
  it("uses the starting year of the European season", () => {
    assert.equal(deriveSeason(new Date("2025-08-15T00:00:00Z")), 2025);
    assert.equal(deriveSeason(new Date("2025-12-31T00:00:00Z")), 2025);
    assert.equal(deriveSeason(new Date("2026-02-15T00:00:00Z")), 2025);
    assert.equal(deriveSeason(new Date("2026-06-30T00:00:00Z")), 2025);
    assert.equal(deriveSeason(new Date("2026-07-01T00:00:00Z")), 2026);
  });
});

describe("normalizeFixture", () => {
  const raw = {
    fixture: {
      id: 123456,
      date: "2025-08-15T17:00:00+02:00",
      status: { long: "Not Started", short: "NS" },
    },
    league: { id: 39, name: "  Premier   League ", season: 2025 },
    teams: {
      home: { id: 1, name: "Arsenal", logo: "https://media.api-sports.io/football/teams/42.png" },
      away: { id: 2, name: "Chelsea", logo: "https://media.api-sports.io/football/teams/49.png" },
    },
    goals: { home: null, away: null },
  };

  it("normalizes a complete fixture", () => {
    const normalized = normalizeFixture(raw);
    assert.equal(normalized.externalFixtureId, "123456");
    assert.equal(normalized.provider, "api-football");
    assert.equal(normalized.homeTeam, "Arsenal");
    assert.equal(normalized.awayTeam, "Chelsea");
    assert.equal(normalized.competition, "Premier League");
    assert.equal(normalized.kickoffAt, "2025-08-15 15:00:00");
    assert.equal(normalized.status, "scheduled");
    assert.equal(normalized.providerStatus, "NS");
    assert.equal(normalized.homeScore, null);
    assert.equal(normalized.awayScore, null);
    assert.equal(
      normalized.homeTeamLogo,
      "https://media.api-sports.io/football/teams/42.png"
    );
    assert.equal(
      normalized.awayTeamLogo,
      "https://media.api-sports.io/football/teams/49.png"
    );
  });

  it("nulls logos when absent or unsafe", () => {
    const normalized = normalizeFixture({
      ...raw,
      teams: {
        home: { id: 1, name: "Arsenal" },
        away: { id: 2, name: "Chelsea", logo: "javascript:alert(1)" },
      },
    });
    assert.equal(normalized.homeTeamLogo, null);
    assert.equal(normalized.awayTeamLogo, null);
  });

  it("captures scores for finished fixtures", () => {
    const normalized = normalizeFixture({
      ...raw,
      fixture: { ...raw.fixture, status: { short: "FT" } },
      goals: { home: 2, away: 1 },
    });
    assert.equal(normalized.status, "finished");
    assert.equal(normalized.isFinal, true);
    assert.equal(normalized.homeScore, 2);
    assert.equal(normalized.awayScore, 1);
  });

  it("returns null for unusable records", () => {
    assert.equal(normalizeFixture(null), null);
    assert.equal(normalizeFixture({}), null);
    assert.equal(
      normalizeFixture({ fixture: { id: 1, date: "invalid" } }),
      null
    );
  });
});
