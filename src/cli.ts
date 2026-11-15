#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadContest, CONTESTS } from "./contests.ts";
import { precheck } from "./precheck.ts";
import { toReport, toText, route } from "./format.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env in the working directory; keys may already be in the environment.
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    contest: { type: "string", default: "karak" },
    title: { type: "string", default: "" },
    json: { type: "boolean", default: false },
    contests: { type: "boolean", default: false },
  },
});

if (values.contests) {
  for (const c of CONTESTS) console.log(`${c.id}\t${c.name}\t${c.githubRepo}@${c.auditedCommit.slice(0, 9)}`);
  process.exit(0);
}

const file = positionals[0];
if (!file) {
  console.error("usage: basanos <report.md | -> [--contest karak] [--title ...] [--json]");
  process.exit(2);
}
const body = readFileSync(file === "-" ? 0 : file, "utf8");
const C4_HEADINGS = /^(lines of code|vulnerability details|impact|proof of concept|tools used|recommended mitigation steps?)$/i;
const title = values.title || [...body.matchAll(/^#\s+(.+)$/gm)].map((m) => m[1].trim()).find((h) => !C4_HEADINGS.test(h)) || "";
// Exit codes: 0 READY and safe to route automatically, 1 anything else, 2 usage, 3 the check itself failed.
try {
  const { contest, policy } = loadContest(values.contest!);
  const result = await precheck({ title, body }, contest, policy);
  console.log(values.json ? JSON.stringify(toReport(result, values.contest!, contest.auditedCommit, title, body), null, 2) : toText(result));
  process.exit(result.verdict === "READY" && route(result) === "automatic" ? 0 : 1);
} catch (err) {
  console.error(`basanos: ${(err as Error).message}`);
  process.exit(3);
}
