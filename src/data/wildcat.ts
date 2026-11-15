import { readFileSync, writeFileSync } from "node:fs";
import { loadScope, type Contest } from "../citations.ts";
import { GitSource, takeSnapshot } from "../source.ts";
import { buildReports, submittedSeverities, type Issue } from "./findings.ts";
import { WILDCAT_AUDITED, WILDCAT_REPO } from "./constants.ts";

// The amendment-7 holdout: chosen by rule before any amendment-7 code existed.
export function wildcat(): Contest {
  const source = new GitSource("data/wildcat/repo");
  return { source, githubRepo: WILDCAT_REPO, auditedCommit: WILDCAT_AUDITED, scope: loadScope(source, WILDCAT_AUDITED) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const contest = wildcat();
  const git = contest.source as GitSource;
  const issues: Issue[] = JSON.parse(readFileSync("data/wildcat/issues.json", "utf8"));
  const submitted = submittedSeverities(`${WILDCAT_REPO}-findings`, issues, "data/wildcat/events/submitted_severity.json");
  const { reports, excluded } = buildReports(issues, submitted, "wildcat", contest);
  writeFileSync("data/wildcat/reports.json", JSON.stringify(reports, null, 2));
  writeFileSync("data/wildcat/excluded.json", JSON.stringify(excluded, null, 2));
  const cited = [...new Set(reports.flatMap((r) => r.citations.map((c) => c.commit)))].filter((c) => c !== WILDCAT_AUDITED && git.hasCommit(c));
  const policyFiles = ["README.md", "4naly3er-report.md", "scope.txt", ...git.markdown(WILDCAT_AUDITED)];
  writeFileSync("data/wildcat/snapshot.json", JSON.stringify({
    ...takeSnapshot(git, [WILDCAT_AUDITED], [...contest.scope, ...policyFiles]),
    ...takeSnapshot(git, cited, [...contest.scope]),
  }));
  console.log(`wildcat: ${reports.length} reports, ${excluded.length} excluded, ${contest.scope.size} scope files, ${cited.length} other cited commits`);
}
