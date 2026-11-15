import { readFileSync, writeFileSync } from "node:fs";
import { loadScope, type Contest } from "../citations.ts";
import { buildReports, type Issue, type Severity } from "./findings.ts";
import { GitSource, type CodeSource } from "../source.ts";
import { loadPolicy, renderPolicy } from "../policy.ts";
import { KARAK_AUDITED as AUDITED, KARAK_REPO } from "./constants.ts";

export function karak(source: CodeSource = new GitSource("data/karak/repo"), auditedCommit = AUDITED): Contest {
  return { source, githubRepo: KARAK_REPO, auditedCommit, scope: loadScope(source, auditedCommit) };
}

export const KARAK = karak();
export const KARAK_POLICY = renderPolicy(loadPolicy(KARAK.source, AUDITED));

export type { Report } from "./findings.ts";

if (import.meta.url === `file://${process.argv[1]}`) {
  const issues: Issue[] = JSON.parse(readFileSync("data/karak/issues.json", "utf8"));
  const submitted: Record<string, Severity | null> = JSON.parse(
    readFileSync("data/karak/events/submitted_severity.json", "utf8"),
  );
  const { reports, excluded } = buildReports(issues, submitted, "karak", KARAK);
  writeFileSync("data/karak/reports.json", JSON.stringify(reports, null, 2));
  writeFileSync("data/karak/excluded.json", JSON.stringify(excluded, null, 2));
  console.log(`reports ${reports.length}, excluded ${excluded.length}`);
}
