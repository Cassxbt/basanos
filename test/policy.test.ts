import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPolicy, renderPolicy, budgetPolicy, groundedClause, POLICY_MAX_CHARS, DOCUMENT_MAX_CHARS } from "../src/policy.ts";
import { SnapshotSource } from "../src/source.ts";
import { loadContest } from "../src/contests.ts";

const snapshot = (files: Record<string, string>) => new SnapshotSource({ c0ffee: files });

test("the bundle carries every Markdown file the README mentions, in order, and drops test sections", () => {
  const source = snapshot({
    "README.md": "# Audit\n## Trust\nSee docs/Known%20Issues.md and EDGECASES.md.\n## Running tests\nforge test\n### Coverage\n90%\n## Scope\nsrc/A.sol",
    "docs/EDGECASES.md": "edge",
    "docs/Known Issues.md": "known",
    "docs/UNMENTIONED.md": "never",
    "4naly3er-report.md": "### <a name=\"M-1\"></a>[M-1] Centralization\nFile: src/A.sol\n\n10: x",
  });
  const p = loadPolicy(source, "c0ffee");
  assert.deepEqual(p.documents.map((d) => d.path), ["docs/Known Issues.md", "docs/EDGECASES.md"]);
  assert.doesNotMatch(p.readme, /forge test|90%/);
  assert.match(p.readme, /## Scope/);
  assert.match(renderPolicy(p), /\[M-1\] Centralization/);
});

test("ordinary documents are shortened; a priority document that cannot fit whole marks the policy incomplete", () => {
  const big = "x".repeat(POLICY_MAX_CHARS);
  const ordinary = budgetPolicy(loadPolicy(snapshot({ "README.md": "see BIG.md", "BIG.md": big }), "c0ffee"));
  assert.deepEqual(ordinary.coverage, [{ path: "BIG.md", priority: false, chars: big.length, included: DOCUMENT_MAX_CHARS }]);
  assert.doesNotMatch(ordinary.text, /POLICY INCOMPLETE/);
  const known = budgetPolicy(loadPolicy(snapshot({ "README.md": "see KNOWN_ISSUES.md", "KNOWN_ISSUES.md": big }), "c0ffee"));
  assert.match(known.text, /\[POLICY INCOMPLETE: KNOWN_ISSUES\.md/);
  assert.ok(known.text.length <= POLICY_MAX_CHARS + 200);
});

test("every contest's priority documents reach the models whole", () => {
  for (const id of ["karak", "kleidi", "wildcat"]) {
    const { contest } = loadContest(id);
    const { coverage, text } = budgetPolicy(loadPolicy(contest.source, contest.auditedCommit));
    assert.doesNotMatch(text, /POLICY INCOMPLETE/, id);
    for (const c of coverage.filter((c) => c.priority)) assert.equal(c.included, c.chars, `${id} ${c.path}`);
  }
  assert.match(loadContest("wildcat").policy, /## docs\/Known Issues\.md/);
});

test("Kleidi's known issues in docs/ now reach the policy", () => {
  assert.match(loadContest("kleidi").policy, /## docs\/KNOWN_ISSUES\.md/);
});

test("a grounded clause is a verbatim quote of at least twenty characters, or a bot id present in the policy", () => {
  const policy = "The guardian may pause the system for up to 30 days.\n- [L-2] Missing events";
  assert.ok(groundedClause("the guardian may pause   the system", policy));
  assert.ok(groundedClause("“The guardian may pause the system for up to 30 days.”", policy));
  assert.ok(groundedClause("L-2", policy));
  assert.ok(!groundedClause("guardian", policy));
  assert.ok(!groundedClause("M-1", policy));
  assert.ok(!groundedClause("The guardian is fully trusted to do anything.", policy));
});
