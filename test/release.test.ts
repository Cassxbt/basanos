import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseProblems, BEHAVIOR_FILES, type Release } from "../src/eval/release.ts";

const release: Release = { pipeline: "obligations-v3.1", development_run: "dev", evaluation_run: "eval" };
const sources = Object.fromEntries(BEHAVIOR_FILES.map((f) => [f, "s"]));
const entry = { pipeline: "obligations-v3.1", contest: "c", passes: 3, ablation: "none", sources, data: { "data/c/snapshot.json": "d" } };
const hashes: Record<string, string> = { ...sources, "data/c/snapshot.json": "d" };
const check = (over: { hash?: Record<string, string | null>; rows?: string[]; manifest?: object } = {}) =>
  releaseProblems(
    release,
    (over.manifest ?? { dev: entry, eval: entry }) as any,
    (f) => (over.hash && f in over.hash ? over.hash[f] : hashes[f] ?? null),
    () => over.rows ?? ["c-1", "c-2"],
    () => ["c-1", "c-2"],
  );

test("a release whose code, inputs and rows match passes the gate", () => {
  assert.deepEqual(check(), []);
});

test("the gate fails on changed code, a changed or missing snapshot, other settings, and missing or duplicated rows", () => {
  assert.match(check({ hash: { "src/caps.ts": "x" } }).join(), /src\/caps\.ts differs/);
  assert.match(check({ hash: { "data/c/snapshot.json": "x" } }).join(), /snapshot\.json differs from the input/);
  assert.match(check({ hash: { "data/c/snapshot.json": null } }).join(), /snapshot\.json differs from the input/);
  assert.match(check({ manifest: { dev: { ...entry, passes: 1 }, eval: entry } }).join(), /passes 1/);
  assert.match(check({ manifest: { dev: { ...entry, pipeline: "obligations-v3" }, eval: entry } }).join(), /pipeline obligations-v3/);
  assert.match(check({ rows: ["c-1"] }).join(), /rows do not match/);
  assert.match(check({ rows: ["c-1", "c-1", "c-2"] }).join(), /duplicate rows/);
});
