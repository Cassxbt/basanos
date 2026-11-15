import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { loadContest } from "../contests.ts";
import { precheck } from "../precheck.ts";
import { toReport } from "../format.ts";
import type { Report } from "../data/findings.ts";
import { PIPELINE_VERSION } from "../obligations.ts";

// Strict v1 results live in before.json/after.json; later pipelines write alongside them, never over them.
const tag = (stage: string) => `${stage}.${PIPELINE_VERSION.replace("obligations-", "")}.json`;

// The repair loop: check a finding, hand its checklist to a repair agent, check the revised finding again.
const CONTEST = process.env.BASANOS_CONTEST ?? "karak";
// Karak's set was the development set; Kleidi's and Wildcat's were fixed by rule before any holdout check (EVAL.md 6.1, 7).
export const REPAIR_SETS: Record<string, number[]> = {
  karak: [7, 49, 28, 41, 55, 4, 26],
  kleidi: [9, 17, 24, 7, 8, 10],
  wildcat: [11, 49, 52, 57, 60, 62, 64, 77, 121, 3, 4, 5],
};
const ROOT = CONTEST === "karak" ? "data/repair" : `data/repair-${CONTEST}`;

async function check(n: number, stage: "before" | "after") {
  const reports: Report[] = JSON.parse(readFileSync(`data/${CONTEST}/reports.json`, "utf8"));
  const r = reports.find((x) => x.number === n)!;
  const dir = `${ROOT}/${n}`;
  mkdirSync(dir, { recursive: true });
  const body = stage === "before" ? r.body : readFileSync(`${dir}/revised.md`, "utf8");
  const { contest, policy } = loadContest(CONTEST);
  const result = await precheck({ title: r.title, body }, contest, policy);
  const report = toReport(result, CONTEST, contest.auditedCommit, r.title, body);
  writeFileSync(`${dir}/${tag(stage)}`, JSON.stringify(report, null, 2));
  console.log(`#${n} ${stage}: ${report.verdict} (${report.agreement}, ${report.route})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stage = process.argv[2] as "before" | "after";
  const only = process.argv.slice(3).map(Number);
  const set = (only.length ? only : REPAIR_SETS[CONTEST]).filter((n) => stage === "before" || existsSync(`${ROOT}/${n}/revised.md`));
  await Promise.all(set.map((n) => check(n, stage)));
}
