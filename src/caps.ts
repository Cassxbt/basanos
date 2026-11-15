import type { Evidence } from "./evidence.ts";
import type { Judgment, ModelVerdict } from "./verdict.ts";
import type { ResolvedCitation } from "./citations.ts";
import { requiredItems } from "./obligations.ts";

export interface Capped {
  verdict: ModelVerdict;
  severity: Judgment["severity_supported"];
  caps: string[];
  evidence: Evidence;
}

export interface CapContext {
  flags: string[];
  citations: ResolvedCitation[];
  locationExists: (file: string, line: number) => boolean;
}

const USABLE = new Set(["OK", "MOVED"]);

// Code has the last word over the decision model: a verdict may never be stronger than the evidence record allows,
// and the evidence record may not point at code that does not exist.
export function applyCaps(j: Judgment, e: Evidence, ctx: CapContext): Capped {
  const caps: string[] = [];
  let verdict = j.verdict;
  let severity = j.severity_supported;

  const realBlocking = e.blocking_code.filter((b) => ctx.locationExists(b.file, b.line));
  if (realBlocking.length < e.blocking_code.length) {
    caps.push(`dropped ${e.blocking_code.length - realBlocking.length} blocking reference(s) to code that does not exist`);
  }
  const evidence = { ...e, blocking_code: realBlocking };
  const rootExists = ctx.locationExists(e.root_cause_file, e.root_cause_line);

  if (verdict === "READY") {
    // Links to out-of-scope files (tests, interfaces) are allowed alongside in-scope ones; every other failure blocks READY.
    const broken = ctx.citations.filter((c) => !USABLE.has(c.status) && c.status !== "OUT_OF_SCOPE");
    const reasons = [
      e.code_supports_claim !== "yes" && `code_supports_claim=${e.code_supports_claim}`,
      !rootExists && `root cause ${e.root_cause_file}:${e.root_cause_line} is not in the audited source`,
      realBlocking.length < e.blocking_code.length && "the evidence record cites code that does not exist",
      realBlocking.length > 0 && `blocking code at ${realBlocking.map((b) => `${b.file}:${b.line}`).join(", ")}`,
      e.known_issue_match && `matches known issue ${e.known_issue_match}`,
      e.trusted_role_required && "requires a trusted role",
      (e.poc === "none" || e.poc === "narrative_only") && "no test or concrete steps in the finding",
      requiredItems(e.missing_evidence).length > 0 && `evidence record lists ${requiredItems(e.missing_evidence).length} required item(s)`,
      requiredItems(j.missing).length > 0 && `the decision lists ${requiredItems(j.missing).length} required item(s)`,
      broken.length > 0 && `${broken.length} citation(s) do not resolve (${broken.map((c) => c.status).join(", ")})`,
      ctx.flags.length > 0 && `finding contains text addressed to the reviewer (${ctx.flags.join(", ")})`,
    ].filter((r): r is string => Boolean(r));
    if (reasons.length) {
      verdict = "NEEDS_PROOF";
      caps.push(`READY capped to NEEDS_PROOF: ${reasons.join("; ")}`);
    }
  }

  // The decision may not quietly drop an obligation the evidence layer marked as required: a person reconciles them.
  const decided = new Set(requiredItems(j.missing).map((i) => i.obligation));
  const dropped = [...new Set(requiredItems(e.missing_evidence).map((i) => i.obligation))].filter((o) => !decided.has(o));
  if (dropped.length) caps.push(`layers disagree: evidence requires obligation ${dropped.join(", ")}, the decision does not`);

  if (e.impact === "informational" && severity !== "low_or_none") {
    caps.push(`severity ${severity} capped: evidence impact is informational`);
    severity = "low_or_none";
  }

  return { verdict, severity, caps, evidence };
}
