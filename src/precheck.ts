import { parseCitations, resolveCitation, markUnrelated, type Contest, type ResolvedCitation } from "./citations.ts";
import { extractEvidence, DOLPHIN_MODEL, type Evidence } from "./evidence.ts";
import { judge, screen, SERV_MODEL, type Judgment, type ModelVerdict } from "./verdict.ts";
import { applyCaps } from "./caps.ts";
import { scanInstructions, proofInReport, capProof } from "./defenses.ts";
import { GuardBlocked, type Call, type Provider } from "./llm.ts";

// GUARD_HELD is not a rejection: Prompt Guard also holds some clean reports, so a human decides.
export type Verdict = ModelVerdict | "CITATION_BROKEN" | "GUARD_HELD";
export type Agreement = "unanimous" | "majority" | "split";
export type Severity = Judgment["severity_supported"];

export interface Vote {
  verdict: ModelVerdict | "GUARD_HELD";
  severity: Severity | null;
  missing: string[];
  reason: string;
  caps: string[];
  evidence: Call<Evidence>;
  judgment: Call<Judgment> | null;
}

export interface Precheck {
  verdict: Verdict;
  agreement: Agreement | null;
  severitySupported: Severity | null;
  missing: string[];
  reason: string;
  citations: ResolvedCitation[];
  flags: string[];
  votes: Vote[];
  decider: { provider: Provider; model: string } | null;
  usd: number;
}

export interface Prepared {
  report: { title: string; body: string };
  citations: ResolvedCitation[];
  veto: { verdict: Verdict; reason: string } | null;
  flags: string[];
  held: string | null;
  evidence: Call<Evidence>[];
  usd: number;
}

export const DEFAULT_DECIDER: { provider: Provider; model: string } = { provider: "serv", model: SERV_MODEL };
const ZERO = new Set(["BLOCKED_BY_CODE", "KNOWN_OR_OUT_OF_SCOPE", "CITATION_BROKEN", "GUARD_HELD"]);
const SEVERITY_RANK: Severity[] = ["low_or_none", "medium", "high"];

export function ordinal(verdict: string, severity: string | null): number {
  if (ZERO.has(verdict) || verdict === "INJECTION_BLOCKED") return 0;
  if (verdict === "READY") return 3;
  if (verdict === "NEEDS_PROOF") return severity === "high" || severity === "medium" ? 2 : 1;
  throw new Error(`unknown verdict ${verdict}`);
}

export function citationVeto(citations: ResolvedCitation[]): { verdict: Verdict; reason: string } | null {
  if (!citations.length) return { verdict: "CITATION_BROKEN", reason: "The report links no code in the contest repository." };
  if (citations.some((c) => c.status === "OK" || c.status === "MOVED")) return null;
  if (citations.every((c) => c.status === "OUT_OF_SCOPE")) {
    return { verdict: "KNOWN_OR_OUT_OF_SCOPE", reason: "Every cited file is outside the contest scope." };
  }
  const bad = citations.map((c) => `${c.path}#L${c.start}-L${c.end}: ${c.status}`).join("; ");
  return { verdict: "CITATION_BROKEN", reason: `No citation points at audited code the report actually discusses (${bad}).` };
}

export function summarizeCitations(citations: ResolvedCitation[]): string {
  if (!citations.length) return "No code links.";
  return citations
    .map((c) => `${c.status} ${c.path}#L${c.start}-L${c.end}${c.status === "MOVED" ? ` (now L${c.auditedStart}-L${c.auditedEnd})` : ""}`)
    .join("\n");
}

export function checkCitations(body: string, title: string, contest: Contest): ResolvedCitation[] {
  const resolved = parseCitations(body, contest.githubRepo, contest.auditedCommit).map((c) => resolveCitation(c, contest));
  return markUnrelated(resolved, `${title}\n${body}`, contest);
}

// Score used by the evaluation: mean ordinal over votes the guard did not hold; all held scores 1.
export function consensusScore(votes: Pick<Vote, "verdict" | "severity">[]): number {
  const valid = votes.filter((v) => v.verdict !== "GUARD_HELD");
  if (!valid.length) return 1;
  return valid.reduce((s, v) => s + ordinal(v.verdict, v.severity), 0) / valid.length;
}

export function consensus(votes: Vote[]): Pick<Precheck, "verdict" | "agreement" | "severitySupported" | "missing" | "reason"> {
  const valid = votes.filter((v) => v.verdict !== "GUARD_HELD");
  if (!valid.length) {
    return {
      verdict: "GUARD_HELD",
      agreement: null,
      severitySupported: null,
      missing: [],
      reason: `SERV Prompt Guard held every pass (${votes.length}). Route this report to a human reviewer.`,
    };
  }
  const counts = new Map<string, Vote[]>();
  for (const v of valid) counts.set(v.verdict, [...(counts.get(v.verdict) ?? []), v]);
  const [top, group] = [...counts].sort((a, b) => b[1].length - a[1].length)[0];
  const agreement: Agreement =
    group.length === valid.length && valid.length === votes.length ? "unanimous" : group.length * 2 > votes.length ? "majority" : "split";
  const pick = agreement === "split" ? valid : group;
  const severities = pick.map((v) => SEVERITY_RANK.indexOf(v.severity ?? "low_or_none")).sort();
  const lead = pick[0];
  return {
    verdict: agreement === "split" ? "NEEDS_PROOF" : (top as ModelVerdict),
    agreement,
    severitySupported: SEVERITY_RANK[severities[Math.floor((severities.length - 1) / 2)]],
    missing: lead.missing,
    reason:
      agreement === "split"
        ? `The passes disagreed (${valid.map((v) => v.verdict).join(", ")}). Route this report to a human reviewer.`
        : lead.reason,
  };
}

async function vote(
  p: Prepared,
  evidence: Call<Evidence>,
  decider: { provider: Provider; model: string },
): Promise<Vote> {
  try {
    const judgment = await judge(decider.provider, decider.model, p.report, summarizeCitations(p.citations), evidence.value);
    const capped = applyCaps(judgment.value, evidence.value, p.flags);
    return {
      verdict: capped.verdict,
      severity: capped.severity,
      missing: judgment.value.missing.length ? judgment.value.missing : evidence.value.missing_evidence,
      reason: judgment.value.reason,
      caps: capped.caps,
      evidence,
      judgment,
    };
  } catch (err) {
    if (!(err instanceof GuardBlocked)) throw err;
    return { verdict: "GUARD_HELD", severity: null, missing: [], reason: err.message, caps: [], evidence, judgment: null };
  }
}

// Everything that does not depend on who decides: citations, the instruction scan, SERV's front-door screen,
// and k evidence passes whose proof claim is capped at what the finding itself shows.
export async function prepare(report: { title: string; body: string }, contest: Contest, policy: string, k = 3): Promise<Prepared> {
  const citations = checkCitations(report.body, report.title, contest);
  const base = { report, citations, flags: [], held: null, evidence: [], usd: 0 };
  const veto = citationVeto(citations);
  if (veto) return { ...base, veto };

  const flags = scanInstructions(`${report.title}\n${report.body}`);
  let screenUsd = 0;
  try {
    screenUsd = (await screen(report)).usd;
  } catch (err) {
    if (!(err instanceof GuardBlocked)) throw err;
    return { ...base, veto: null, flags, held: err.message };
  }

  const shown = proofInReport(report.body);
  const evidence = (await Promise.all(Array.from({ length: k }, () => extractEvidence(report, citations, contest, policy)))).map(
    (e) => ({ ...e, value: { ...e.value, poc: capProof(e.value.poc, shown) } }),
  );
  return { ...base, veto: null, flags, held: null, evidence, usd: screenUsd + evidence.reduce((t, e) => t + e.usd, 0) };
}

export async function decide(p: Prepared, decider = DEFAULT_DECIDER): Promise<Precheck> {
  const shared = { citations: p.citations, flags: p.flags, decider, usd: p.usd };
  if (p.veto) return { ...p.veto, ...shared, agreement: null, severitySupported: null, missing: [], votes: [], decider: null };
  if (p.held) {
    return {
      ...shared,
      verdict: "GUARD_HELD",
      agreement: null,
      severitySupported: null,
      missing: [],
      votes: [],
      reason: `SERV Prompt Guard held the finding at the front door (${p.held}). Route it to a human reviewer.`,
    };
  }
  const votes = await Promise.all(p.evidence.map((e) => vote(p, e, decider)));
  return { ...consensus(votes), ...shared, votes, usd: p.usd + votes.reduce((t, v) => t + (v.judgment?.usd ?? 0), 0) };
}

export async function precheck(
  report: { title: string; body: string },
  contest: Contest,
  policy: string,
  opts: { k?: number; decider?: { provider: Provider; model: string } } = {},
): Promise<Precheck> {
  return decide(await prepare(report, contest, policy, opts.k ?? 3), opts.decider ?? DEFAULT_DECIDER);
}

export { DOLPHIN_MODEL, SERV_MODEL };
