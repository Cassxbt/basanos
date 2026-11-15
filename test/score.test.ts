import { test } from "node:test";
import assert from "node:assert/strict";
import { auroc, ordinal } from "../src/eval/score.ts";

test("auroc: perfect, inverted, all-tied", () => {
  assert.equal(auroc([3, 2, 1, 0], [true, true, false, false]), 1);
  assert.equal(auroc([0, 1, 2, 3], [true, true, false, false]), 0);
  assert.equal(auroc([1, 1, 1, 1], [true, false, true, false]), 0.5);
});

test("ordinal maps verdicts as pre-registered", () => {
  assert.equal(ordinal("READY", "high"), 3);
  assert.equal(ordinal("NEEDS_PROOF", "medium"), 2);
  assert.equal(ordinal("NEEDS_PROOF", "low_or_none"), 1);
  assert.equal(ordinal("BLOCKED_BY_CODE", null), 0);
});
