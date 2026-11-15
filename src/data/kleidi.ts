import { readFileSync, writeFileSync } from "node:fs";
import { loadScope, type Contest } from "../citations.ts";
import { GitSource, takeSnapshot } from "../source.ts";
import { buildReports, submittedSeverities, type Issue } from "./findings.ts";
import { KLEIDI_ALIASES, KLEIDI_AUDITED, KLEIDI_REPO } from "./constants.ts";

// The amendment-6 holdout: chosen by rule before any amendment-6 output existed.
export function kleidi(): Contest {
  const source = new GitSource("data/kleidi/repo");
  return { source, githubRepo: KLEIDI_REPO, aliases: KLEIDI_ALIASES, auditedCommit: KLEIDI_AUDITED, scope: loadScope(source, KLEIDI_AUDITED) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const contest = kleidi();
  const issues: Issue[] = JSON.parse(readFileSync("data/kleidi/issues.json", "utf8"));
  const submitted = submittedSeverities(`${KLEIDI_REPO}-findings`, issues, "data/kleidi/events/submitted_severity.json");
  const { reports, excluded } = buildReports(issues, submitted, "kleidi", contest);
  writeFileSync("data/kleidi/reports.json", JSON.stringify(reports, null, 2));
  writeFileSync("data/kleidi/excluded.json", JSON.stringify(excluded, null, 2));
  const cited = [...new Set(reports.flatMap((r) => r.citations.map((c) => c.commit)))].filter(
    (c) => c !== KLEIDI_AUDITED && (contest.source as GitSource).hasCommit(c),
  );
  const policyFiles = ["README.md", "4naly3er-report.md", "scope.txt", "KNOWN_ISSUES.md"];
  writeFileSync("data/kleidi/snapshot.json", JSON.stringify({
    ...takeSnapshot(contest.source as GitSource, [KLEIDI_AUDITED], [...contest.scope, ...policyFiles]),
    ...takeSnapshot(contest.source as GitSource, cited, [...contest.scope]),
  }));
  console.log(`kleidi: ${reports.length} reports, ${excluded.length} excluded, ${contest.scope.size} scope files, ${cited.length} other cited commits`);
}
