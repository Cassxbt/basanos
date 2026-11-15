import { readFileSync, writeFileSync } from "node:fs";
import { GitSource, takeSnapshot } from "../source.ts";
import { loadScope } from "../citations.ts";
import type { Report } from "./karak.ts";
import { KARAK_AUDITED as AUDITED } from "./constants.ts";
const POLICY_FILES = ["README.md", "4naly3er-report.md", "scope.txt"];

const git = new GitSource("data/karak/repo");
const scope = [...loadScope(git, AUDITED)];
const reports: Report[] = JSON.parse(readFileSync("data/karak/reports.json", "utf8"));
const cited = [...new Set(reports.flatMap((r) => r.citations.map((c) => c.commit)))].filter(
  (c) => c !== AUDITED && git.hasCommit(c),
);

const snapshot = {
  ...takeSnapshot(git, [AUDITED], [...scope, ...POLICY_FILES]),
  ...takeSnapshot(git, cited, scope),
};
writeFileSync("data/karak/snapshot.json", JSON.stringify(snapshot));
console.log(`snapshot: ${Object.keys(snapshot).length} commits, ${scope.length} scope files`);

// The patched-code attack on /judges runs a finding against a branch where its bug is fixed.
const FIX_31 = "27dc62a0ba1bd0a9d34f465ab7242d92b88c59f7";
writeFileSync("data/karak/snapshot-fix31.json", JSON.stringify(takeSnapshot(git, [FIX_31], [...scope, ...POLICY_FILES])));
console.log("snapshot-fix31 written");
