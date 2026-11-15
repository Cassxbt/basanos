import type { Evidence } from "./evidence.ts";
import type { Judgment, ModelVerdict } from "./verdict.ts";

export interface Capped {
  verdict: ModelVerdict;
  severity: Judgment["severity_supported"];
  caps: string[];
}

// Code has the last word over the decision model: a verdict may never be stronger than the evidence record allows.
export function applyCaps(j: Judgment, e: Evidence): Capped {
  const caps: string[] = [];
  let verdict = j.verdict;
  let severity = j.severity_supported;

  if (verdict === "READY") {
    const reasons = [
      e.code_supports_claim !== "yes" && `code_supports_claim=${e.code_supports_claim}`,
      e.blocking_code.length > 0 && `blocking code at ${e.blocking_code.map((b) => `${b.file}:${b.line}`).join(", ")}`,
      e.known_issue_match && `matches known issue ${e.known_issue_match}`,
      e.trusted_role_required && "requires a trusted role",
      e.poc === "none" && "no proof of concept",
    ].filter((r): r is string => Boolean(r));
    if (reasons.length) {
      verdict = "NEEDS_PROOF";
      caps.push(`READY capped to NEEDS_PROOF: ${reasons.join("; ")}`);
    }
  }

  if (e.impact === "informational" && severity !== "low_or_none") {
    caps.push(`severity ${severity} capped: evidence impact is informational`);
    severity = "low_or_none";
  }

  return { verdict, severity, caps };
}
