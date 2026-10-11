import { after, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import pool from "../src/config/db.js";
import {
  upsertPrediction,
  listMatches,
  PredictionError,
} from "../src/services/matchService.js";
import { finalizeMatchResult } from "../src/services/scoringService.js";
import {
  listUserPredictions,
  getUserPredictionByMatch,
} from "../src/services/predictionService.js";
import { getDashboardSummary } from "../src/services/dashboardService.js";
import { getUserLeaderboardEntry } from "../src/services/leaderboardService.js";

after(async () => {
  await pool.end();
});

function uniqueEmail(tag) {
  return `itt_${tag}_${Date.now()}_${crypto.randomBytes(3).toString("hex")}@test.local`;
}

function utcDateString(offsetDays) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 19).replace("T", " ");
}

async function createUser(name, email) {
  const [result] = await pool.execute(
    "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
    [name, email, "$2b$10$testtesttesttesttesttesttesttesttesttesttesttesttestte"]
  );
  return result.insertId;
}

async function createMatch({ homeTeam, awayTeam, competition, kickoffAt, status }) {
  const [result] = await pool.execute(
    `INSERT INTO matches (home_team, away_team, competition, kickoff_at, status)
     VALUES (?, ?, ?, ?, ?)`,
    [homeTeam, awayTeam, competition, kickoffAt, status]
  );
  return result.insertId;
}

test("predictions, scoring and dashboard integration", async (t) => {
  const alice = await createUser("ITT Alice", uniqueEmail("alice"));
  const bob = await createUser("ITT Bob", uniqueEmail("bob"));
  const carol = await createUser("ITT Carol", uniqueEmail("carol"));

  const futureMatch = await createMatch({
    homeTeam: "ITT Home",
    awayTeam: "ITT Away",
    competition: "ITT League",
    kickoffAt: utcDateString(2),
    status: "scheduled",
  });
  const pastMatch = await createMatch({
    homeTeam: "ITT Home",
    awayTeam: "ITT Away",
    competition: "ITT League",
    kickoffAt: utcDateString(-1),
    status: "scheduled",
  });
  const scoreMatch = await createMatch({
    homeTeam: "ITT Home",
    awayTeam: "ITT Away",
    competition: "ITT League",
    kickoffAt: utcDateString(3),
    status: "scheduled",
  });
  const cancelledMatch = await createMatch({
    homeTeam: "ITT Home",
    awayTeam: "ITT Away",
    competition: "ITT League",
    kickoffAt: utcDateString(4),
    status: "cancelled",
  });

  try {
    await t.test("create, update and isolate predictions", async () => {
      const created = await upsertPrediction({
        userId: alice,
        matchId: futureMatch,
        homeScore: 2,
        awayScore: 1,
      });
      assert.equal(created.updated, false);
      assert.equal(created.prediction.predicted_home_score, 2);

      const updated = await upsertPrediction({
        userId: alice,
        matchId: futureMatch,
        homeScore: 1,
        awayScore: 1,
      });
      assert.equal(updated.updated, true);

      const aliceList = await listUserPredictions(alice);
      assert.equal(aliceList.length, 1);
      assert.equal(await listUserPredictions(bob).then((rows) => rows.length), 0);

      const mine = await getUserPredictionByMatch(alice, futureMatch);
      assert.equal(mine.predicted_home_score, 1);
      assert.equal(await getUserPredictionByMatch(bob, futureMatch), null);

      assert.equal((await listUserPredictions(alice, "pending")).length, 0);
    });

    await t.test("rejects predictions after kickoff", async () => {
      await assert.rejects(
        upsertPrediction({ userId: alice, matchId: pastMatch, homeScore: 0, awayScore: 0 }),
        (err) => err instanceof PredictionError && err.code === "PREDICTION_LOCKED"
      );
    });

    await t.test("rejects predictions for unknown matches", async () => {
      await assert.rejects(
        upsertPrediction({ userId: alice, matchId: 999999999, homeScore: 0, awayScore: 0 }),
        (err) => err instanceof PredictionError && err.code === "MATCH_NOT_FOUND"
      );
    });

    await t.test("awards 3/1/0 points and is idempotent", async () => {
      await upsertPrediction({ userId: alice, matchId: scoreMatch, homeScore: 2, awayScore: 1 });
      await upsertPrediction({ userId: bob, matchId: scoreMatch, homeScore: 3, awayScore: 0 });
      await upsertPrediction({ userId: carol, matchId: scoreMatch, homeScore: 0, awayScore: 2 });

      const result = await finalizeMatchResult({ matchId: scoreMatch, homeScore: 2, awayScore: 1 });
      assert.equal(result.scoredPredictions, 3);

      assert.equal((await getUserPredictionByMatch(alice, scoreMatch)).points, 3);
      assert.equal((await getUserPredictionByMatch(bob, scoreMatch)).points, 1);
      assert.equal((await getUserPredictionByMatch(carol, scoreMatch)).points, 0);

      await finalizeMatchResult({ matchId: scoreMatch, homeScore: 2, awayScore: 1 });

      assert.equal((await getUserPredictionByMatch(alice, scoreMatch)).points, 3);
      assert.equal((await getUserPredictionByMatch(bob, scoreMatch)).points, 1);
      assert.equal((await getUserPredictionByMatch(carol, scoreMatch)).points, 0);
    });

    await t.test("refuses to finalize cancelled matches", async () => {
      await assert.rejects(
        finalizeMatchResult({ matchId: cancelledMatch, homeScore: 0, awayScore: 0 }),
        (err) => err instanceof PredictionError && err.code === "MATCH_NOT_RESULTABLE"
      );
    });

    await t.test("leaderboard reflects scored points", async () => {
      const entry = await getUserLeaderboardEntry(alice);
      assert.ok(entry);
      assert.equal(entry.user_id, alice);
      assert.equal(entry.total_points, 3);
      assert.ok(entry.scored_predictions >= 1);
    });

    await t.test("dashboard summary aggregates data", async () => {
      const summary = await getDashboardSummary(alice);
      assert.ok(summary.stats.total >= 2);
      assert.equal(summary.stats.points, 3);
      assert.equal(typeof summary.rank, "number");
      assert.ok(summary.upcomingMatches.some((match) => match.id === futureMatch));
      assert.ok(Array.isArray(summary.recentPredictions));
    });

    await t.test("matches list supports pagination and filtering", async () => {
      const page = await listMatches({ status: "scheduled", page: 1, limit: 2 });
      assert.ok(page.matches.length <= 2);
      assert.ok(page.total >= 1);
      assert.ok(page.totalPages >= 1);
      assert.equal(page.matches.length, page.matches.filter((m) => m.id !== null).length);

      const empty = await listMatches({
        status: "finished",
        competition: "ITT NonExistentLeague",
      });
      assert.equal(empty.total, 0);
      assert.equal(empty.matches.length, 0);
    });
  } finally {
    const matchIds = [futureMatch, pastMatch, scoreMatch, cancelledMatch];
    const placeholders = matchIds.map(() => "?").join(", ");
    await pool.execute(`DELETE FROM matches WHERE id IN (${placeholders})`, matchIds);
    await pool.execute("DELETE FROM users WHERE id IN (?, ?, ?)", [alice, bob, carol]);
  }
});