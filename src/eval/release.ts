import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Every file whose change can alter a verdict, a route, or which rows a run evaluates.
export const BEHAVIOR_FILES = [
  "src/evidence.ts", "src/verdict.ts", "src/caps.ts", "src/defenses.ts", "src/precheck.ts", "src/citations.ts",
  "src/obligations.ts", "src/policy.ts", "src/llm.ts", "src/route.ts", "src/format.ts", "src/contests.ts",
  "src/source.ts", "src/eval/consensus.ts",
];

export const sha16 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

export const behaviorHashes = () => Object.fromEntries(BEHAVIOR_FILES.map((f) => [f, sha16(f)]));

// The build ships only code whose exact behavior files produced the release's evidence.
export function assertReleaseMatchesCode(release: { pipeline: string; development_run: string; evaluation_run: string }) {
  const manifest = JSON.parse(readFileSync("data/runs/manifest.json", "utf8"));
  const now = behaviorHashes();
  for (const run of [release.development_run, release.evaluation_run]) {
    const recorded = manifest[run]?.sources ?? {};
    const changed = BEHAVIOR_FILES.filter((f) => recorded[f] !== now[f]);
    if (changed.length) throw new Error(`release run ${run} was not produced by this code (${changed.join(", ")} differ)`);
  }
}
