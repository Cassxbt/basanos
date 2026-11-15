import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCaps } from "../src/caps.ts";
import { route } from "../src/route.ts";
import type { Evidence } from "../src/evidence.ts";
import { NO_EXCLUSION, type Judgment } from "../src/verdict.ts";

// The milestone-3 partner review's offline contract probes, kept as regressions for obligations-v3.1.
const policy = "The protocol supports deposits and withdrawals for all registered users.";
const ctx = { flags: [], citations: [], locationExists: () => true, policy };
const evidence: Evidence = {
  claim: "attack bypasses a defense against compromised owners", root_cause_file: "Vault.sol", root_cause_line: 1,
  code_supports_claim: "yes", support_reason: "supported", blocking_code: [], poc: "runnable_test", impact: "funds_loss",
  preconditions: [], trusted_role_required: false, known_issue_match: "", missing_evidence: [],
};
const ready: Judgment = { verdict: "READY", severity_supported: "high", missing: [], exclusion: NO_EXCLUSION, reason: "supported" };
const routeOf = (caps: string[], verdict: string) => route({ verdict, agreement: "unanimous", flags: [], votes: [{ caps }] });

test("a trusted-role cap names what would resolve it", () => {
  const r = applyCaps(ready, { ...evidence, trusted_role_required: true }, ctx);
  assert.equal(r.verdict, "NEEDS_PROOF");
  assert.equal(r.missing.length, 1);
  assert.match(r.missing[0].item, /does not trust this role for this action, or which stated defense/);
});

test("a quoted but inapplicable clause is never applied automatically", () => {
  const r = applyCaps({ ...ready, verdict: "KNOWN_OR_OUT_OF_SCOPE", exclusion: { clause: policy, actor: "attacker", conditions: "none", why_within: "assertion" } }, evidence, ctx);
  assert.equal(r.verdict, "KNOWN_OR_OUT_OF_SCOPE");
  assert.equal(routeOf(r.caps, r.verdict), "human");
});

test("existing but irrelevant blocking code is never applied automatically", () => {
  const r = applyCaps({ ...ready, verdict: "BLOCKED_BY_CODE" }, { ...evidence, blocking_code: [{ file: "Vault.sol", line: 1, why: "a license comment" }] }, ctx);
  assert.equal(routeOf(r.caps, r.verdict), "human");
});

test("a different requirement labelled with an evidence id does not replace it", () => {
  const item = { item: "prove a victim loses funds", category: "required" as const, obligation: 3 as const, why: "impact absent", resolves_when: "show balances" };
  const r = applyCaps({ ...ready, verdict: "NEEDS_PROOF", missing: [{ ...item, item: "show a gas benchmark", obligation: 5, evidence_ref: "E1" }] }, { ...evidence, missing_evidence: [item] }, ctx);
  assert.match(r.caps.join(" "), /layers disagree: evidence requires E1/);
  assert.ok(r.missing.some((m) => m.item === "prove a victim loses funds"));
  assert.equal(routeOf(r.caps, r.verdict), "human");
});

test("a carried requirement is published in the evidence layer's own words", () => {
  const item = { item: "prove a victim loses funds", category: "required" as const, obligation: 3 as const, why: "impact absent", resolves_when: "show balances" };
  const r = applyCaps({ ...ready, verdict: "NEEDS_PROOF", missing: [{ ...item, item: "paraphrase", why: "decider's reason", evidence_ref: "e1" }] }, { ...evidence, missing_evidence: [item] }, ctx);
  assert.deepEqual(r.missing, [{ ...item, why: "decider's reason" }]);
  assert.ok(!r.caps.some((c) => c.startsWith("layers disagree")));
});

test("an incomplete contest policy sends every result to review", () => {
  const r = applyCaps({ ...ready, verdict: "NEEDS_PROOF" }, evidence, { ...ctx, policy: `${policy}\n[POLICY INCOMPLETE: docs/KNOWN.md could not be included whole]` });
  assert.equal(routeOf(r.caps, r.verdict), "human");
});
