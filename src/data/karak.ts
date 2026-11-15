import { readFileSync, writeFileSync } from "node:fs";
import { parseCitations, resolveCitation, loadScope, type Contest, type ResolvedCitation } from "../citations.ts";
import { GitSource, type CodeSource } from "../source.ts";
import { loadPolicy, renderPolicy } from "../policy.ts";
import { KARAK_AUDITED as AUDITED, KARAK_REPO } from "./constants.ts";

export function karak(source: CodeSource = new GitSource("data/karak/repo"), auditedCommit = AUDITED): Contest {
  return { source, githubRepo: KARAK_REPO, auditedCommit, scope: loadScope(source, auditedCommit) };
}

export const KARAK = karak();
export const KARAK_POLICY = renderPolicy(loadPolicy(KARAK.source, AUDITED));

interface Issue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}

type Severity = "high" | "medium" | "qa";

export interface Report {
  id: string;
  number: number;
  title: string;
  body: string;
  submittedSeverity: "high" | "medium";
  finalSeverity: Severity | null;
  awarded: boolean;
  judged: "satisfactory" | "unsatisfactory" | null;
  presort: "sufficient" | "insufficient" | null;
  family: number;
  citations: ResolvedCitation[];
}

const JUDGE_AUTHORED = /^\s*Judge has assessed/;

const SEVERITY_LABELS: Record<string, Severity> = {
  "3 (High Risk)": "high",
  "2 (Med Risk)": "medium",
  "QA (Quality Assurance)": "qa",
};

// Current labels are the judge's final call; the first severity label in the issue's history is what the warden submitted.
function toReport(issue: Issue, submitted: Severity | null): Report | { excluded: number; reason: string } {
  const labels = new Set(issue.labels.map((l) => l.name));
  if (submitted !== "high" && submitted !== "medium") return { excluded: issue.number, reason: "not submitted as H/M" };
  const finalSeverity = issue.labels.map((l) => SEVERITY_LABELS[l.name]).find(Boolean) ?? null;
  const body = issue.body ?? "";
  if (JUDGE_AUTHORED.test(body)) return { excluded: issue.number, reason: "judge-authored body" };

  const dup = [...labels].map((l) => /^duplicate-(\d+)$/.exec(l)).find(Boolean);
  return {
    id: `karak-${issue.number}`,
    number: issue.number,
    title: issue.title,
    body,
    submittedSeverity: submitted,
    finalSeverity,
    awarded: labels.has("satisfactory") && (finalSeverity === "high" || finalSeverity === "medium"),
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
  const issues: Issue[] = JSON.parse(readFileSync("data/karak/issues.json", "utf8"));
  const submitted: Record<string, Severity | null> = JSON.parse(
    readFileSync("data/karak/events/submitted_severity.json", "utf8"),
  );
  const reports: Report[] = [];
  const excluded: { excluded: number; reason: string }[] = [];
  for (const issue of issues) {
    const r = toReport(issue, submitted[issue.number]);
    if ("excluded" in r) excluded.push(r);
    else reports.push(r);
  }
  reports.sort((a, b) => a.number - b.number);
  writeFileSync("data/karak/reports.json", JSON.stringify(reports, null, 2));
  writeFileSync("data/karak/excluded.json", JSON.stringify(excluded, null, 2));
  console.log(`reports ${reports.length}, excluded ${excluded.length}`);
}
