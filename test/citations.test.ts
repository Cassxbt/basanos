import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCitations, resolveCitation, markUnrelated } from "../src/citations.ts";
import { loadContest } from "../src/contests.ts";
import { citationVeto } from "../src/precheck.ts";

// Runs from the committed snapshot, so a fresh clone needs no contest checkout.
const KARAK = loadContest("karak").contest;

const base = "https://github.com/code-423n4/2024-07-karak/blob";
const INIT = "d19a4de35bcaf31ccec8bccd36e2d26594d05aad";

const resolve = (link: string) => {
  const [c] = parseCitations(link, KARAK.githubRepo, KARAK.auditedCommit);
  assert.ok(c, `no citation parsed from ${link}`);
  return resolveCitation(c, KARAK);
};

test("parses ranges, single lines, branch refs, and ignores other repos", () => {
  const body = [
    `${base}/ab18e1f6c03e118158369527baa2487b2b4616b1/src/Vault.sol#L78-L88`,
    `${base}/main/src/Core.sol#L146`,
    `https://github.com/vectorized/solady/blob/main/src/tokens/ERC4626.sol#L10`,
    `${base}/main/src/Core.sol#L146`,
  ].join("\n");
  const cs = parseCitations(body, KARAK.githubRepo, KARAK.auditedCommit);
  assert.equal(cs.length, 2);
  assert.deepEqual([cs[0].start, cs[0].end], [78, 88]);
  assert.equal(cs[1].ref, "main");
  assert.equal(cs[1].commit, KARAK.auditedCommit);
});

test("a citation to a later commit with identical source resolves OK (report #93)", () => {
  assert.equal(resolve(`${base}/ab18e1f6c03e118158369527baa2487b2b4616b1/src/Vault.sol#L78-L88`).status, "OK");
});

test("lines shifted by added comments resolve as MOVED to the audited position", () => {
  const r = resolve(`${base}/${INIT}/src/Vault.sol#L225-L227`);
  assert.equal(r.status, "MOVED");
  assert.equal(r.auditedStart, 227);
});

test("code rewritten before the audited commit is CHANGED", () => {
  assert.equal(resolve(`${base}/${INIT}/src/Core.sol#L140`).status, "CHANGED");
});

test("test files are OUT_OF_SCOPE (report #58)", () => {
  assert.equal(resolve(`${base}/main/test/nativeRestaking/nativeVault.t.sol#L221`).status, "OUT_OF_SCOPE");
});

test("fabricated line numbers are BAD_LINES", () => {
  assert.equal(resolve(`${base}/main/src/Vault.sol#L9000-L9010`).status, "BAD_LINES");
});

test("an unknown commit is NO_COMMIT", () => {
  assert.equal(resolve(`${base}/deadbeefdeadbeef/src/Vault.sol#L1`).status, "NO_COMMIT");
});

test("column-qualified ranges keep both line numbers", () => {
  const [c] = parseCitations(`${base}/main/src/NativeVault.sol#L168C14-L170C43`, KARAK.githubRepo, KARAK.auditedCommit);
  assert.deepEqual([c.start, c.end], [168, 170]);
});

test("a brace-only span never counts as MOVED", () => {
  const r = resolve(`${base}/${INIT}/src/Vault.sol#L228`);
  assert.notEqual(r.status, "MOVED");
});

test("?plain=1 permalinks and uppercase SHAs parse", () => {
  const [a] = parseCitations(`${base}/main/src/Vault.sol?plain=1#L78`, KARAK.githubRepo, KARAK.auditedCommit);
  assert.equal(a.path, "src/Vault.sol");
  const [b] = parseCitations(`${base}/F5E52FDCB4C20C4318D532A9F08F7876E9AFB321/src/Vault.sol#L78`, KARAK.githubRepo, KARAK.auditedCommit);
  assert.equal(b.commit, KARAK.auditedCommit);
});

test("in-range lines the prose never discusses are UNRELATED and vetoed", () => {
  const body = `Reentrancy in Vault.withdraw drains all depositors.\n${base}/main/src/Core.sol#L200-L210`;
  const cs = markUnrelated(parseCitations(body, KARAK.githubRepo, KARAK.auditedCommit).map((c) => resolveCitation(c, KARAK)), body, KARAK);
  assert.equal(cs[0].status, "UNRELATED");
  assert.equal(citationVeto(cs)?.verdict, "CITATION_BROKEN");
});

test("a citation whose code the prose names stays OK", () => {
  const body = `Vault.deposit forwards assets before checking balances.\n${base}/main/src/Vault.sol#L78-L88`;
  const cs = markUnrelated(parseCitations(body, KARAK.githubRepo, KARAK.auditedCommit).map((c) => resolveCitation(c, KARAK)), body, KARAK);
  assert.equal(cs[0].status, "OK");
  assert.equal(citationVeto(cs), null);
});
