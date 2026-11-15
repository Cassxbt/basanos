import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { parseCitations, resolveCitation, type Contest, type ResolvedCitation } from "../citations.ts";

export interface Issue {
  number: number;
  title: string;
  body: string | null;
  labels: { name: string }[];
}

export type Severity = "high" | "medium" | "qa";

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
export function toReport(issue: Issue, submitted: Severity | null, prefix: string, contest: Contest): Report | { excluded: number; reason: string } {
  const labels = new Set(issue.labels.map((l) => l.name));
  if (submitted !== "high" && submitted !== "medium") return { excluded: issue.number, reason: "not submitted as H/M" };
  const finalSeverity = issue.labels.map((l) => SEVERITY_LABELS[l.name]).find(Boolean) ?? null;
  const body = issue.body ?? "";
  if (JUDGE_AUTHORED.test(body)) return { excluded: issue.number, reason: "judge-authored body" };

  const dup = [...labels].map((l) => /^duplicate-(\d+)$/.exec(l)).find(Boolean);
  return {
    id: `${prefix}-${issue.number}`,
    number: issue.number,
    title: issue.title,
    body,
    submittedSeverity: submitted,
    finalSeverity,
    // Partial-credit duplicates are paid without a "satisfactory" label; nullified reports are not paid.
    awarded:
      (labels.has("satisfactory") || [...labels].some((l) => /^partial-\d+$/.test(l))) &&
      !labels.has("nullified") &&
      (finalSeverity === "high" || finalSeverity === "medium"),
    judged: labels.has("satisfactory") ? "satisfactory" : labels.has("unsatisfactory") ? "unsatisfactory" : null,
    presort: labels.has("sufficient quality report")
      ? "sufficient"
      : labels.has("insufficient quality report")
        ? "insufficient"
        : null,
    family: dup ? Number(dup[1]) : issue.number,
    citations: parseCitations(body, contest.githubRepo, contest.auditedCommit, contest.aliases).map((c) => resolveCitation(c, contest)),
  };
}

function withRetry<T>(fn: () => T, attempts = 4): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i === attempts) throw err;
    }
  }
}

// Reads each issue's label history once and caches it; GitHub only exposes the submitted severity there.
export function submittedSeverities(findingsRepo: string, issues: Issue[], cachePath: string): Record<string, Severity | null> {
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8"));
  const out: Record<string, Severity | null> = {};
  for (const issue of issues) {
    const raw = withRetry(() => execFileSync("gh", ["api", "--paginate", `repos/${findingsRepo}/issues/${issue.number}/events?per_page=100`], { encoding: "utf8" }));
    const events: { event: string; label?: { name: string } }[] = JSON.parse(`[${raw.replace(/\]\s*\[/g, ",").slice(1, -1)}]`);
    out[issue.number] = events.filter((e) => e.event === "labeled").map((e) => SEVERITY_LABELS[e.label?.name ?? ""]).find(Boolean) ?? null;
  }
  mkdirSync(cachePath.split("/").slice(0, -1).join("/"), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(out, null, 1));
  return out;
}

export function buildReports(issues: Issue[], submitted: Record<string, Severity | null>, prefix: string, contest: Contest) {
  const reports: Report[] = [];
  const excluded: { excluded: number; reason: string }[] = [];
  for (const issue of issues) {
    const r = toReport(issue, submitted[issue.number], prefix, contest);
    if ("excluded" in r) excluded.push(r);
    else reports.push(r);
  }
  reports.sort((a, b) => a.number - b.number);
  return { reports, excluded };
}
