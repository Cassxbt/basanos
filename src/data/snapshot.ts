import { readFileSync, writeFileSync } from "node:fs";
import { GitSource, takeSnapshot } from "../source.ts";
import { loadScope } from "../citations.ts";
import type { Report } from "./karak.ts";

const AUDITED = "f5e52fdcb4c20c4318d532a9f08f7876e9afb321";
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
