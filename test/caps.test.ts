import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCaps } from "../src/caps.ts";
import { consensus, consensusScore, type Vote } from "../src/precheck.ts";
import type { Evidence } from "../src/evidence.ts";
import type { Judgment } from "../src/verdict.ts";

const evidence: Evidence = {
  claim: "c",
  root_cause_file: "src/Vault.sol",
  root_cause_line: 1,
  code_supports_claim: "yes",
  support_reason: "r",
  blocking_code: [],
  poc: "runnable_test",
  impact: "funds_loss",
  preconditions: [],
  trusted_role_required: false,
  known_issue_match: "",
  missing_evidence: [],
};
const ready: Judgment = { verdict: "READY", severity_supported: "high", missing: [], reason: "r" };

test("READY survives only a clean evidence record", () => {
  assert.equal(applyCaps(ready, evidence).verdict, "READY");
});

test("each weakness in the evidence caps READY to NEEDS_PROOF", () => {
  const weak: Partial<Evidence>[] = [
    { code_supports_claim: "partly" },
    { code_supports_claim: "no" },
    { blocking_code: [{ file: "src/Core.sol", line: 9, why: "guard" }] },
    { known_issue_match: "M-1" },
    { trusted_role_required: true },
    { poc: "none" },
  ];
  for (const w of weak) {
    const r = applyCaps(ready, { ...evidence, ...w });
    assert.equal(r.verdict, "NEEDS_PROOF", JSON.stringify(w));
    assert.equal(r.caps.length, 1);
  }
});

test("informational impact caps severity", () => {
  assert.equal(applyCaps(ready, { ...evidence, impact: "informational" }).severity, "low_or_none");
});

const v = (verdict: Vote["verdict"], severity: Vote["severity"] = "medium") =>
  ({ verdict, severity, missing: [verdict], reason: verdict, caps: [] }) as unknown as Vote;

test("consensus: unanimous, majority, split, all held", () => {
  assert.equal(consensus([v("BLOCKED_BY_CODE"), v("BLOCKED_BY_CODE"), v("BLOCKED_BY_CODE")]).agreement, "unanimous");
  const maj = consensus([v("NEEDS_PROOF"), v("NEEDS_PROOF"), v("READY")]);
  assert.deepEqual([maj.verdict, maj.agreement], ["NEEDS_PROOF", "majority"]);
  const split = consensus([v("READY"), v("BLOCKED_BY_CODE"), v("KNOWN_OR_OUT_OF_SCOPE")]);
  assert.deepEqual([split.verdict, split.agreement], ["NEEDS_PROOF", "split"]);
  assert.equal(consensus([v("GUARD_HELD", null), v("GUARD_HELD", null), v("GUARD_HELD", null)]).verdict, "GUARD_HELD");
});

test("a guard hold never makes a vote unanimous", () => {
  assert.equal(consensus([v("NEEDS_PROOF"), v("NEEDS_PROOF"), v("GUARD_HELD", null)]).agreement, "majority");
});

test("consensus score averages votes the guard did not hold", () => {
  assert.equal(consensusScore([v("READY", "high"), v("NEEDS_PROOF", "low_or_none"), v("GUARD_HELD", null)]), 2);
  assert.equal(consensusScore([v("GUARD_HELD", null)]), 1);
});
