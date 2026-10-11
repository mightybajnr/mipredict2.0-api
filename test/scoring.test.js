import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeScore } from "../src/services/scoringService.js";

describe("computeScore", () => {
  it("awards 3 points for an exact score", () => {
    assert.equal(computeScore(2, 1, 2, 1), 3);
    assert.equal(computeScore(0, 0, 0, 0), 3);
  });

  it("awards 1 point for a correct outcome with the wrong score", () => {
    assert.equal(computeScore(2, 1, 3, 0), 1);
    assert.equal(computeScore(1, 0, 3, 1), 1);
    assert.equal(computeScore(2, 2, 0, 0), 1);
    assert.equal(computeScore(0, 1, 1, 3), 1);
  });

  it("awards 0 points for a wrong outcome", () => {
    assert.equal(computeScore(2, 1, 0, 1), 0);
    assert.equal(computeScore(2, 1, 1, 1), 0);
    assert.equal(computeScore(1, 1, 2, 1), 0);
    assert.equal(computeScore(0, 0, 2, 1), 0);
  });

  it("is deterministic and order-independent between runs", () => {
    const a = computeScore(3, 2, 2, 3);
    const b = computeScore(3, 2, 2, 3);
    assert.equal(a, b);
  });
});