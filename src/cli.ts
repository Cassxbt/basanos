import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadContest, CONTESTS } from "./contests.ts";
import { precheck } from "./precheck.ts";
import { toJson, toText } from "./format.ts";

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
const title = values.title || /^#\s+(.+)$/m.exec(body)?.[1] || "";
const { contest, policy } = loadContest(values.contest!);
const result = await precheck({ title, body }, contest, policy);
console.log(values.json ? JSON.stringify(toJson(result), null, 2) : toText(result));
process.exit(result.verdict === "READY" ? 0 : 1);
