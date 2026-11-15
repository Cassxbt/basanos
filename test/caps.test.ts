import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCaps } from "../src/caps.ts";
import { consensus, consensusScore, type Vote } from "../src/precheck.ts";
import type { Evidence } from "../src/evidence.ts";
import type { Judgment } from "../src/verdict.ts";
import type { MissingItem } from "../src/obligations.ts";

const req = (item: string, obligation: MissingItem["obligation"] = 5): MissingItem => ({ item, category: "required", obligation, why: "w", resolves_when: "r" });
const opt = (item: string, obligation: MissingItem["obligation"] = 3): MissingItem => ({ item, category: "strengthens", obligation, why: "w", resolves_when: "r" });

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
const ctx = { flags: [], citations: [], locationExists: (f: string, l: number) => ["src/Vault.sol", "src/Core.sol"].includes(f) && l >= 1 && l <= 365 };

test("READY survives only a clean evidence record", () => {
  assert.equal(applyCaps(ready, evidence, ctx).verdict, "READY");
});

test("each weakness in the evidence caps READY to NEEDS_PROOF", () => {
  const weak: Partial<Evidence>[] = [
    { code_supports_claim: "partly" },
    { code_supports_claim: "no" },
    { blocking_code: [{ file: "src/Core.sol", line: 9, why: "guard" }] },
    { known_issue_match: "M-1" },
    { trusted_role_required: true },
    { poc: "none" },
    { poc: "narrative_only" },
    { missing_evidence: [req("no reproduction")] },
    { root_cause_file: "missing.sol", root_cause_line: 999999 },
  ];
  for (const w of weak) {
    const r = applyCaps(ready, { ...evidence, ...w }, ctx);
    assert.equal(r.verdict, "NEEDS_PROOF", JSON.stringify(w));
    assert.ok(r.caps.some((c) => c.startsWith("READY capped")), JSON.stringify(w));
  }
});

test("READY is capped when the decision itself lists missing proof", () => {
  assert.equal(applyCaps({ ...ready, missing: [req("a test")] }, evidence, ctx).verdict, "NEEDS_PROOF");
});

test("items that only strengthen a supported claim do not block READY", () => {
  const r = applyCaps({ ...ready, missing: [opt("a boundary-case regression test")] }, { ...evidence, missing_evidence: [opt("gas numbers")] }, ctx);
  assert.equal(r.verdict, "READY");
  assert.deepEqual(r.caps, []);
});

test("the decision may not silently drop an obligation the evidence layer requires", () => {
  const r = applyCaps({ ...ready, verdict: "NEEDS_PROOF", missing: [req("numbers", 3)] }, { ...evidence, missing_evidence: [req("trust model clause", 4)] }, ctx);
  assert.match(r.caps.join(" "), /layers disagree: evidence requires obligation 4/);
});

test("READY is capped when any citation does not resolve, even if another does", () => {
  const citations = [
    { status: "OK", url: "", ref: "main", commit: "x", path: "src/Vault.sol", start: 78, end: 88 },
    { status: "BAD_LINES", url: "", ref: "main", commit: "x", path: "src/Vault.sol", start: 99999, end: 99999 },
  ] as any;
  assert.equal(applyCaps(ready, evidence, { ...ctx, citations }).verdict, "NEEDS_PROOF");
});

test("blocking references to code that does not exist are dropped and noted", () => {
  const r = applyCaps({ ...ready, verdict: "BLOCKED_BY_CODE" }, { ...evidence, blocking_code: [{ file: "ghost.sol", line: 4, why: "x" }] }, ctx);
  assert.equal(r.evidence.blocking_code.length, 0);
  assert.match(r.caps.join(" "), /does not exist/);
});

test("informational impact caps severity", () => {
  assert.equal(applyCaps(ready, { ...evidence, impact: "informational" }, ctx).severity, "low_or_none");
});

const v = (verdict: Vote["verdict"], severity: Vote["severity"] = "medium") =>
  ({ verdict, severity, missing: [], reason: verdict, caps: [] }) as unknown as Vote;

test("consensus: unanimous, majority, split, all held", () => {
  assert.equal(consensus([v("BLOCKED_BY_CODE"), v("BLOCKED_BY_CODE"), v("BLOCKED_BY_CODE")]).agreement, "unanimous");
  const maj = consensus([v("NEEDS_PROOF"), v("NEEDS_PROOF"), v("READY")]);
  assert.deepEqual([maj.verdict, maj.agreement], ["NEEDS_PROOF", "majority"]);
  const split = consensus([v("READY"), v("BLOCKED_BY_CODE"), v("KNOWN_OR_OUT_OF_SCOPE")]);
  assert.deepEqual([split.verdict, split.agreement], ["NEEDS_PROOF", "split"]);
  assert.equal(consensus([v("GUARD_HELD", null), v("GUARD_HELD", null), v("GUARD_HELD", null)]).verdict, "GUARD_HELD");
});

test("same verdict at different severities is not unanimous", () => {
  assert.equal(consensus([v("NEEDS_PROOF", "high"), v("NEEDS_PROOF", "high"), v("NEEDS_PROOF", "low_or_none")]).agreement, "majority");
});

test("a guard hold never makes a vote unanimous", () => {
  assert.equal(consensus([v("NEEDS_PROOF"), v("NEEDS_PROOF"), v("GUARD_HELD", null)]).agreement, "majority");
});

test("consensus score averages votes the guard did not hold", () => {
  assert.equal(consensusScore([v("READY", "high"), v("NEEDS_PROOF", "low_or_none"), v("GUARD_HELD", null)]), 2);
  assert.equal(consensusScore([v("GUARD_HELD", null)]), 1);
});
