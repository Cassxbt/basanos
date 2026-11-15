import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { loadContest } from "../contests.ts";
import { precheck } from "../precheck.ts";
import { toReport } from "../format.ts";
import type { Report } from "../data/karak.ts";

// The repair loop: check a finding, hand its checklist to a repair agent, check the revised finding again.
export const REPAIR_SET = [7, 49, 28, 41, 55, 4, 26];

async function check(n: number, stage: "before" | "after") {
  const reports: Report[] = JSON.parse(readFileSync("data/karak/reports.json", "utf8"));
  const r = reports.find((x) => x.number === n)!;
  const dir = `data/repair/${n}`;
  mkdirSync(dir, { recursive: true });
  const body = stage === "before" ? r.body : readFileSync(`${dir}/revised.md`, "utf8");
  const { contest, policy } = loadContest("karak");
  const result = await precheck({ title: r.title, body }, contest, policy);
  const report = toReport(result, "karak", contest.auditedCommit, r.title, body);
  writeFileSync(`${dir}/${stage}.json`, JSON.stringify(report, null, 2));
  console.log(`#${n} ${stage}: ${report.verdict} (${report.agreement}, ${report.route})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stage = process.argv[2] as "before" | "after";
  const only = process.argv.slice(3).map(Number);
  const set = (only.length ? only : REPAIR_SET).filter((n) => stage === "before" || existsSync(`data/repair/${n}/revised.md`));
  await Promise.all(set.map((n) => check(n, stage)));
}
