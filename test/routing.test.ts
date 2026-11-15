import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { route } from "../src/route.ts";
import { automatic } from "../src/eval/claims.ts";
import type { ConsensusRow } from "../src/eval/consensus.ts";

const negative = (caps: string[]): ConsensusRow["serv"] => ({
  verdict: "KNOWN_OR_OUT_OF_SCOPE",
  agreement: "unanimous",
  score: 0,
  votes: [1, 2, 3].map(() => ({ verdict: "KNOWN_OR_OUT_OF_SCOPE", severity: null, requestId: null, caps, usd: 0 })),
});

test("a unanimous negative verdict with a layer disagreement goes to a person, in production and in evaluation", () => {
  const arm = negative(["layers disagree: evidence requires obligation 2, the decision does not"]);
  const row = { id: "x-1", vetoed: null, evidenceUsd: 0, flags: [], serv: arm, dolphin: arm } as ConsensusRow;
  assert.equal(route({ ...arm, flags: [] }), "human");
  assert.equal(automatic(row, "serv"), false);
});

test("a code veto other than a broken citation goes to a person", () => {
  const arm = { verdict: "KNOWN_OR_OUT_OF_SCOPE", agreement: null, score: 0, votes: [] };
  assert.equal(route({ ...arm, flags: [] }), "human");
});

test("published holdout routing equals production routing on the stored rows", () => {
  const claims = JSON.parse(readFileSync("data/claims.json", "utf8"));
  const rows: ConsensusRow[] = readFileSync("data/runs/holdout-kleidi.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const which of ["serv", "dolphin"] as const) {
    const human = rows.filter((r) => route({ ...r[which], flags: r.flags ?? [] }) === "human").length;
    assert.equal(claims.amendment6.holdout_kleidi[which].human_routed, human, which);
  }
});
