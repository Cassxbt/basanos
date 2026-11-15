import { parseCitations, resolveCitation, markUnrelated, type Contest, type ResolvedCitation } from "./citations.ts";
import { extractEvidence, scopeBundle, DOLPHIN_MODEL, EVIDENCE_MAX_TOKENS, type Evidence } from "./evidence.ts";
import { judge, screen, SERV_MODEL, JUDGE_MAX_TOKENS, SCREEN_MAX_TOKENS, type Judgment, type ModelVerdict } from "./verdict.ts";
import { applyCaps } from "./caps.ts";
import { scanInstructions, proofInReport, capProof } from "./defenses.ts";
import type { MissingItem } from "./obligations.ts";
import { GuardBlocked, price, type Call, type Provider } from "./llm.ts";

// GUARD_HELD is not a rejection: Prompt Guard also holds some clean reports, so a human decides.
export type Verdict = ModelVerdict | "CITATION_BROKEN" | "GUARD_HELD";
export type Agreement = "unanimous" | "majority" | "split";
export type Severity = Judgment["severity_supported"];

export interface Vote {
  verdict: ModelVerdict | "GUARD_HELD";
  severity: Severity | null;
  missing: MissingItem[];
  reason: string;
  caps: string[];
  evidence: Call<Evidence>;
  judgment: Call<Judgment> | null;
}

export interface Precheck {
  verdict: Verdict;
  agreement: Agreement | null;
  severitySupported: Severity | null;
  missing: MissingItem[];
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
  locationExists: (file: string, line: number) => boolean;
  policy: string;
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
  const resolved = parseCitations(body, contest.githubRepo, contest.auditedCommit, contest.aliases).map((c) => resolveCitation(c, contest));
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
  // Unanimity means the same verdict at the same severity; the same word at different strengths is not agreement.
  const sameSeverity = new Set(group.map((v) => v.severity)).size === 1;
  const agreement: Agreement =
    group.length === valid.length && valid.length === votes.length && sameSeverity
      ? "unanimous"
      : group.length * 2 > votes.length
        ? "majority"
        : "split";
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
  signal?: AbortSignal,
): Promise<Vote> {
  try {
    const judgment = await judge(decider.provider, decider.model, p.report, summarizeCitations(p.citations), evidence.value, p.policy, signal);
    const capped = applyCaps(judgment.value, evidence.value, { flags: p.flags, citations: p.citations, locationExists: p.locationExists, policy: p.policy });
    return {
      verdict: capped.verdict,
      severity: capped.severity,
      missing: capped.missing,
      reason: judgment.value.reason,
      caps: capped.caps,
      evidence: { ...evidence, value: capped.evidence },
      judgment,
    };
  } catch (err) {
    if (!(err instanceof GuardBlocked)) throw err;
    return { verdict: "GUARD_HELD", severity: null, missing: [], reason: err.message, caps: [], evidence, judgment: null };
  }
}

// Everything that does not depend on who decides: citations, the instruction scan, SERV's front-door screen,
// and k evidence passes whose proof claim is capped at what the finding itself shows.
export interface Defenses {
  frontDoor: boolean;
  scan: boolean;
  proofCap: boolean;
}

export const ALL_DEFENSES: Defenses = { frontDoor: true, scan: true, proofCap: true };

// The defenses can be switched off one at a time so an ablation can measure what each one adds.
export async function prepare(
  report: { title: string; body: string },
  contest: Contest,
  policy: string,
  k = 3,
  defenses: Defenses = ALL_DEFENSES,
  signal?: AbortSignal,
): Promise<Prepared> {
  const citations = checkCitations(report.body, report.title, contest);
  const locationExists = (file: string, line: number) => {
    if (!contest.scope.has(file)) return false;
    const lines = contest.source.read(contest.auditedCommit, file);
    return !!lines && Number.isInteger(line) && line >= 1 && line <= lines.length;
  };
  const base = { report, citations, flags: [], held: null, evidence: [], locationExists, policy, usd: 0 };
  const veto = citationVeto(citations);
  if (veto) return { ...base, veto };

  const flags = defenses.scan ? scanInstructions(`${report.title}\n${report.body}`) : [];
  let screenUsd = 0;
  if (defenses.frontDoor) {
    try {
      screenUsd = (await screen(report, signal)).usd;
    } catch (err) {
      if (!(err instanceof GuardBlocked)) throw err;
      return { ...base, veto: null, flags, held: err.message };
    }
  }

  const shown = proofInReport(report.body);
  const evidence = (await Promise.all(Array.from({ length: k }, () => extractEvidence(report, citations, contest, policy, signal)))).map(
    (e) => (defenses.proofCap ? { ...e, value: { ...e.value, poc: capProof(e.value.poc, shown) } } : e),
  );
  return { ...base, veto: null, flags, held: null, evidence, usd: screenUsd + evidence.reduce((t, e) => t + e.usd, 0) };
}

export async function decide(p: Prepared, decider = DEFAULT_DECIDER, signal?: AbortSignal): Promise<Precheck> {
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
  const votes = await Promise.all(p.evidence.map((e) => vote(p, e, decider, signal)));
  return { ...consensus(votes), ...shared, votes, usd: p.usd + votes.reduce((t, v) => t + (v.judgment?.usd ?? 0), 0) };
}

export async function precheck(
  report: { title: string; body: string },
  contest: Contest,
  policy: string,
  opts: { k?: number; decider?: { provider: Provider; model: string }; signal?: AbortSignal } = {},
): Promise<Precheck> {
  const p = await prepare(report, contest, policy, opts.k ?? 3, ALL_DEFENSES, opts.signal);
  return decide(p, opts.decider ?? DEFAULT_DECIDER, opts.signal);
}

// An estimate to reserve before a check, not a billing bound: inputs are assumed at 3 characters per token,
// outputs at their maximum, and Prompt Guard's own inference is not reported in usage so it is not counted.
export function estimatedReservationUsd(reportChars: number, contest: Contest, policy: string, k = 3): number {
  const report = reportChars / 3;
  const evidenceIn = (scopeBundle(contest).length + policy.length) / 3 + report + 2000;
  const ev = price(DOLPHIN_MODEL), sv = price(SERV_MODEL);
  const screenUsd = ((report + 3000) * sv.input + SCREEN_MAX_TOKENS * sv.output) / 1e6;
  const evidenceUsd = k * (evidenceIn * ev.input + EVIDENCE_MAX_TOKENS * ev.output) / 1e6;
  const judgeUsd = k * ((report + policy.length / 3 + 8000) * sv.input + JUDGE_MAX_TOKENS.serv * sv.output) / 1e6;
  return screenUsd + evidenceUsd + judgeUsd;
}

export { DOLPHIN_MODEL, SERV_MODEL };
