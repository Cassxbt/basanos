import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCitations, resolveCitation, loadScope } from "../src/citations.ts";
import { KARAK } from "../src/data/karak.ts";

KARAK.scope = loadScope(KARAK.repoDir, KARAK.auditedCommit);
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
