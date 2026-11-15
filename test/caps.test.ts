import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCaps } from "../src/caps.ts";
import { consensus, consensusScore, type Vote } from "../src/precheck.ts";
import type { Evidence } from "../src/evidence.ts";
import { NO_EXCLUSION, type Judgment } from "../src/verdict.ts";
import type { DecisionItem, MissingItem } from "../src/obligations.ts";
import { route } from "../src/route.ts";

const req = (item: string, obligation: MissingItem["obligation"] = 5): MissingItem => ({ item, category: "required", obligation, why: "w", resolves_when: "r" });
const opt = (item: string, obligation: MissingItem["obligation"] = 3): MissingItem => ({ item, category: "strengthens", obligation, why: "w", resolves_when: "r" });
const asked = (m: MissingItem, evidence_ref = ""): DecisionItem => ({ ...m, evidence_ref });

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
const ready: Judgment = { verdict: "READY", severity_supported: "high", missing: [], exclusion: NO_EXCLUSION, reason: "r" };
const policy = "## README.md\nThe owner is trusted to set fees within the documented bounds.\n\n## Bot report findings\n- [M-1] Centralization risk: src/Vault.sol:10";
const ctx = { flags: [], citations: [], policy, locationExists: (f: string, l: number) => ["src/Vault.sol", "src/Core.sol"].includes(f) && l >= 1 && l <= 365 };
const ok = [{ status: "OK", url: "", ref: "main", commit: "x", path: "src/Vault.sol", start: 78, end: 88 }] as any;

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
  assert.equal(applyCaps({ ...ready, missing: [asked(req("a test"))] }, evidence, ctx).verdict, "NEEDS_PROOF");
});

test("items that only strengthen a supported claim do not block READY", () => {
  const r = applyCaps({ ...ready, missing: [asked(opt("a boundary-case regression test"))] }, { ...evidence, missing_evidence: [opt("gas numbers")] }, ctx);
  assert.equal(r.verdict, "READY");
  assert.deepEqual(r.caps, []);
});

test("the decision may not silently drop a requirement the evidence layer raised", () => {
  const r = applyCaps({ ...ready, verdict: "NEEDS_PROOF", missing: [asked(req("numbers", 3))] }, { ...evidence, missing_evidence: [req("trust model clause", 4)] }, ctx);
  assert.match(r.caps.join(" "), /layers disagree: evidence requires E1 \(obligation 4\)/);
});

test("requirements are reconciled item by item, not by obligation number", () => {
  const e = { ...evidence, missing_evidence: [req("a reproduction"), req("the victim's balance after the call")] };
  const carriesOne = applyCaps({ ...ready, verdict: "NEEDS_PROOF", missing: [asked(req("a reproduction"), "E1")] }, e, ctx);
  assert.match(carriesOne.caps.join(" "), /evidence requires E2 \(obligation 5\)/);
  assert.deepEqual(carriesOne.missing.map((m) => m.item), ["a reproduction", "the victim's balance after the call"]);
  const carriesBoth = applyCaps({ ...ready, verdict: "NEEDS_PROOF", missing: [asked(req("a reproduction"), "E1"), asked(req("balances"), "e2")] }, e, ctx);
  assert.ok(!carriesBoth.caps.some((c) => c.startsWith("layers disagree")));
});

test("READY is capped when any citation does not resolve, even if another does", () => {
  const citations = [
    { status: "OK", url: "", ref: "main", commit: "x", path: "src/Vault.sol", start: 78, end: 88 },
    { status: "BAD_LINES", url: "", ref: "main", commit: "x", path: "src/Vault.sol", start: 99999, end: 99999 },
  ] as any;
  assert.equal(applyCaps(ready, evidence, { ...ctx, citations }).verdict, "NEEDS_PROOF");
});

test("BLOCKED_BY_CODE resting only on code that does not exist is capped and goes to a person", () => {
  const r = applyCaps({ ...ready, verdict: "BLOCKED_BY_CODE" }, { ...evidence, blocking_code: [{ file: "ghost.sol", line: 4, why: "x" }] }, ctx);
  assert.equal(r.evidence.blocking_code.length, 0);
  assert.equal(r.verdict, "NEEDS_PROOF");
  assert.match(r.caps.join(" "), /verdict capped/);
  assert.equal(route({ verdict: r.verdict, agreement: "unanimous", flags: [], votes: [{ caps: r.caps }] }), "human");
  const real = applyCaps({ ...ready, verdict: "BLOCKED_BY_CODE" }, { ...evidence, blocking_code: [{ file: "src/Core.sol", line: 9, why: "guard" }] }, ctx);
  assert.equal(real.verdict, "BLOCKED_BY_CODE");
});

test("an exclusion stands only when it quotes the contest policy or names a bot finding in it", () => {
  const known = (clause: string): Judgment => ({ ...ready, verdict: "KNOWN_OR_OUT_OF_SCOPE", exclusion: { clause, actor: "owner", conditions: "c", why_within: "w" } });
  assert.equal(applyCaps(known("The owner is trusted to set fees within the documented bounds."), evidence, ctx).verdict, "KNOWN_OR_OUT_OF_SCOPE");
  assert.equal(applyCaps(known("M-1"), evidence, ctx).verdict, "KNOWN_OR_OUT_OF_SCOPE");
  for (const clause of ["", "The owner is fully trusted in every respect.", "M-7", "trusted"]) {
    const r = applyCaps(known(clause), evidence, ctx);
    assert.equal(r.verdict, "NEEDS_PROOF", clause);
    assert.match(r.caps.join(" "), /verdict capped.*exclusion/, clause);
  }
});

test("obligation-1 items are dropped only when every citation is OK or MOVED", () => {
  const scopeItem = [asked(req("confirm the file is in scope", 1))];
  const r = applyCaps({ ...ready, missing: scopeItem }, evidence, { ...ctx, citations: ok });
  assert.equal(r.verdict, "READY");
  assert.match(r.caps.join(" "), /dropped obligation-1/);
  assert.deepEqual(r.missing, [], "the published checklist is the one code enforced");
  for (const status of ["BAD_LINES", "OUT_OF_SCOPE"]) {
    const mixed = [...ok, { status, url: "", ref: "main", commit: "x", path: "test/Vault.t.sol", start: 1, end: 2 }] as any;
    assert.equal(applyCaps({ ...ready, missing: scopeItem }, evidence, { ...ctx, citations: mixed }).verdict, "NEEDS_PROOF", status);
  }
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
