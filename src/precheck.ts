import { parseCitations, resolveCitation, type Contest, type ResolvedCitation } from "./citations.ts";
import { extractEvidence, DOLPHIN_MODEL, type Evidence } from "./evidence.ts";
import { judge, SERV_MODEL, type Judgment, type ModelVerdict } from "./verdict.ts";
import { GuardBlocked, type Call, type Provider } from "./llm.ts";

export type Verdict = ModelVerdict | "CITATION_BROKEN" | "INJECTION_BLOCKED";

export interface Precheck {
  verdict: Verdict;
  severitySupported: Judgment["severity_supported"] | null;
  missing: string[];
  reason: string;
  capped: string | null;
  citations: ResolvedCitation[];
  evidence: Call<Evidence> | null;
  judgment: Call<Judgment> | null;
  usd: number;
}

export interface PrecheckOptions {
  judge?: { provider: Provider; model: string };
}

export function citationVeto(citations: ResolvedCitation[]): { verdict: Verdict; reason: string } | null {
  if (!citations.length) return { verdict: "CITATION_BROKEN", reason: "The report links no code in the contest repository." };
  const usable = citations.filter((c) => c.status === "OK" || c.status === "MOVED");
  if (usable.length) return null;
  if (citations.every((c) => c.status === "OUT_OF_SCOPE")) {
    return { verdict: "KNOWN_OR_OUT_OF_SCOPE", reason: "Every cited file is outside the contest scope." };
  }
  const bad = citations.map((c) => `${c.path}#L${c.start}-L${c.end}: ${c.status}`).join("; ");
  return { verdict: "CITATION_BROKEN", reason: `No citation resolves to the audited code (${bad}).` };
}

export function summarizeCitations(citations: ResolvedCitation[]): string {
  if (!citations.length) return "No code links.";
  return citations
    .map((c) => `${c.status} ${c.path}#L${c.start}-L${c.end}${c.status === "MOVED" ? ` (now L${c.auditedStart}-L${c.auditedEnd})` : ""}`)
    .join("\n");
}

export async function precheck(
  report: { title: string; body: string },
  contest: Contest,
  policy: string,
  opts: PrecheckOptions = {},
): Promise<Precheck> {
  const citations = parseCitations(report.body, contest.githubRepo, contest.auditedCommit).map((c) =>
    resolveCitation(c, contest),
  );
  const base = { citations, evidence: null, judgment: null, severitySupported: null, missing: [], capped: null, usd: 0 };

  const veto = citationVeto(citations);
  if (veto) return { ...base, ...veto };

  const evidence = await extractEvidence(report, citations, contest, policy);
  const { provider, model } = opts.judge ?? { provider: "serv" as const, model: SERV_MODEL };

  let judgment: Call<Judgment>;
  try {
    judgment = await judge(provider, model, report, summarizeCitations(citations), evidence.value);
  } catch (err) {
    if (!(err instanceof GuardBlocked)) throw err;
    return { ...base, evidence, usd: evidence.usd, verdict: "INJECTION_BLOCKED", reason: err.message };
  }

  const j = judgment.value;
  let verdict: Verdict = j.verdict;
  let capped: string | null = null;
  // The model may not promote a claim the full-source read could not support.
  if (verdict === "READY" && (evidence.value.code_supports_claim === "no" || evidence.value.code_supports_claim === "cannot_tell")) {
    verdict = "NEEDS_PROOF";
    capped = `READY capped: evidence record says code_supports_claim=${evidence.value.code_supports_claim}`;
  }

  return {
    ...base,
    verdict,
    capped,
    severitySupported: j.severity_supported,
    missing: j.missing.length ? j.missing : evidence.value.missing_evidence,
    reason: j.reason,
    evidence,
    judgment,
    usd: evidence.usd + judgment.usd,
  };
}

export { DOLPHIN_MODEL, SERV_MODEL };
