import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

// Every file whose change can alter a verdict, a route, or which rows a run evaluates.
export const BEHAVIOR_FILES = [
  "src/evidence.ts", "src/verdict.ts", "src/caps.ts", "src/defenses.ts", "src/precheck.ts", "src/citations.ts",
  "src/obligations.ts", "src/policy.ts", "src/llm.ts", "src/route.ts", "src/format.ts", "src/contests.ts",
  "src/source.ts", "src/eval/consensus.ts",
];

export const sha16 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);

export const behaviorHashes = () => Object.fromEntries(BEHAVIOR_FILES.map((f) => [f, sha16(f)]));

export interface Release {
  pipeline: string;
  development_run: string;
  evaluation_run: string;
}

interface ManifestEntry {
  pipeline: string;
  contest: string;
  passes: number;
  ablation: string;
  sources?: Record<string, string>;
  data?: Record<string, string>;
}

// The build ships only code and inputs whose exact hashes produced the release's evidence, with every expected row present once.
export function releaseProblems(
  release: Release,
  manifest: Record<string, ManifestEntry>,
  hash: (file: string) => string | null,
  rowIds: (run: string) => string[],
  reportIds: (contest: string) => string[],
): string[] {
  const problems: string[] = [];
  for (const run of [release.development_run, release.evaluation_run]) {
    const m = manifest[run];
    if (!m) { problems.push(`${run}: no manifest entry`); continue; }
    if (m.pipeline !== release.pipeline) problems.push(`${run}: pipeline ${m.pipeline}, release ${release.pipeline}`);
    if (m.passes !== 3 || m.ablation !== "none") problems.push(`${run}: passes ${m.passes}, ablation ${m.ablation}`);
    for (const f of BEHAVIOR_FILES) if (m.sources?.[f] !== hash(f)) problems.push(`${run}: ${f} differs from the code that produced it`);
    const data = Object.entries(m.data ?? {});
    if (!data.length) problems.push(`${run}: no input hashes recorded`);
    for (const [f, h] of data) if (hash(f) !== h) problems.push(`${run}: ${f} differs from the input that produced it`);
    const rows = rowIds(run), expected = reportIds(m.contest);
    if (new Set(rows).size !== rows.length) problems.push(`${run}: duplicate rows`);
    if (rows.length !== expected.length || expected.some((id) => !rows.includes(id))) problems.push(`${run}: rows do not match the ${m.contest} reports`);
  }
  return problems;
}

export function assertReleaseMatchesCode(release: Release) {
  const manifest = JSON.parse(readFileSync("data/runs/manifest.json", "utf8"));
  const lines = (f: string) => readFileSync(f, "utf8").trim().split("\n").filter(Boolean);
  const problems = releaseProblems(
    release,
    manifest,
    (f) => (existsSync(f) ? sha16(f) : null),
    (run) => lines(`data/runs/${run}.jsonl`).map((l) => JSON.parse(l).id),
    (contest) => JSON.parse(readFileSync(`data/${contest}/reports.json`, "utf8")).map((r: { id: string }) => r.id),
  );
  if (problems.length) throw new Error(`release gate:\n${problems.join("\n")}`);
}
