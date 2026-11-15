import { readFileSync, writeFileSync } from "node:fs";
import { parseCitations, resolveCitation, loadScope, type Contest, type ResolvedCitation } from "../citations.ts";

export const KARAK: Contest = {
  repoDir: "data/karak/repo",
  githubRepo: "code-423n4/2024-07-karak",
  auditedCommit: "f5e52fdcb4c20c4318d532a9f08f7876e9afb321",
  scope: new Set(),
};

interface Issue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}

export interface Report {
  id: string;
  number: number;
  title: string;
  body: string;
  submittedSeverity: "high" | "medium";
  judged: "satisfactory" | "unsatisfactory" | null;
  presort: "sufficient" | "insufficient" | null;
  family: number;
  citations: ResolvedCitation[];
}

const JUDGE_AUTHORED = /^\s*Judge has assessed/;

function toReport(issue: Issue): Report | { excluded: number; reason: string } {
  const labels = new Set(issue.labels.map((l) => l.name));
  const severity = labels.has("3 (High Risk)") ? "high" : labels.has("2 (Med Risk)") ? "medium" : null;
  if (!severity) return { excluded: issue.number, reason: "not H/M" };
  const body = issue.body ?? "";
  if (JUDGE_AUTHORED.test(body)) return { excluded: issue.number, reason: "judge-authored body" };

  const dup = [...labels].map((l) => /^duplicate-(\d+)$/.exec(l)).find(Boolean);
  return {
    id: `karak-${issue.number}`,
    number: issue.number,
    title: issue.title,
    body,
    submittedSeverity: severity,
    judged: labels.has("satisfactory") ? "satisfactory" : labels.has("unsatisfactory") ? "unsatisfactory" : null,
    presort: labels.has("sufficient quality report")
      ? "sufficient"
      : labels.has("insufficient quality report")
        ? "insufficient"
        : null,
    family: dup ? Number(dup[1]) : issue.number,
    citations: parseCitations(body, KARAK.githubRepo, KARAK.auditedCommit).map((c) => resolveCitation(c, KARAK)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  KARAK.scope = loadScope(KARAK.repoDir, KARAK.auditedCommit);
  const issues: Issue[] = JSON.parse(readFileSync("data/karak/issues.json", "utf8"));
  const reports: Report[] = [];
  const excluded: { excluded: number; reason: string }[] = [];
  for (const issue of issues) {
    const r = toReport(issue);
    if ("excluded" in r) excluded.push(r);
    else reports.push(r);
  }
  reports.sort((a, b) => a.number - b.number);
  writeFileSync("data/karak/reports.json", JSON.stringify(reports, null, 2));
  writeFileSync("data/karak/excluded.json", JSON.stringify(excluded, null, 2));
  console.log(`reports ${reports.length}, excluded ${excluded.length}`);
}
