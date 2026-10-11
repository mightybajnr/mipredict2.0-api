import pool from "../config/db.js";
import { PROVIDER } from "./fixtureMapper.js";

// All SQL that touches provider-managed matches lives here. Both the pool and
// a transaction connection implement the same `.execute()` contract, so the
// same repository can run inside or outside a transaction. A fake repository
// can be injected in tests.
export function createMatchRepository(db = pool) {
  return {
    async findProviderMatch(runner, externalFixtureId, { forUpdate = false } = {}) {
      const [rows] = await runner.execute(
        `SELECT id, status, home_score, away_score, kickoff_at
           FROM matches
          WHERE external_fixture_id = ? AND provider = ?
          LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
        [externalFixtureId, PROVIDER]
      );

      return rows[0] || null;
    },

    async insertProviderMatch(runner, fixture) {
      const [result] = await runner.execute(
        `INSERT INTO matches
           (home_team, away_team, competition, kickoff_at, status,
            home_score, away_score, provider, external_fixture_id,
            provider_status, home_team_logo, away_team_logo, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP())`,
        [
          fixture.homeTeam,
          fixture.awayTeam,
          fixture.competition,
          fixture.kickoffAt,
          fixture.status,
          fixture.homeScore,
          fixture.awayScore,
          PROVIDER,
          fixture.externalFixtureId,
          fixture.providerStatus,
          fixture.homeTeamLogo ?? null,
          fixture.awayTeamLogo ?? null,
        ]
      );

      return result.insertId;
    },

    async updateProviderMatch(runner, id, fields) {
      const sets = [
        "home_team = ?",
        "away_team = ?",
        "competition = ?",
        "kickoff_at = ?",
        "status = ?",
        "provider_status = ?",
      ];
      const params = [
        fields.homeTeam,
        fields.awayTeam,
        fields.competition,
        fields.kickoffAt,
        fields.status,
        fields.providerStatus,
      ];

      if (fields.homeTeamLogo !== undefined) {
        sets.push("home_team_logo = ?");
        params.push(fields.homeTeamLogo ?? null);
      }

      if (fields.awayTeamLogo !== undefined) {
        sets.push("away_team_logo = ?");
        params.push(fields.awayTeamLogo ?? null);
      }

      if (fields.updateScores) {
        sets.push("home_score = ?", "away_score = ?");
        params.push(fields.homeScore, fields.awayScore);
      }

      sets.push("last_synced_at = UTC_TIMESTAMP()");
      params.push(id);

      await runner.execute(
        `UPDATE matches SET ${sets.join(", ")} WHERE id = ?`,
        params
      );
    },
  };
}

export default createMatchRepository;
