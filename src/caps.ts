import type { Evidence } from "./evidence.ts";
import type { Judgment, ModelVerdict } from "./verdict.ts";
import type { ResolvedCitation } from "./citations.ts";
import { requiredItems, type MissingItem } from "./obligations.ts";
import { groundedClause } from "./policy.ts";

export interface Capped {
  verdict: ModelVerdict;
  severity: Judgment["severity_supported"];
  caps: string[];
  evidence: Evidence;
  // The checklist code enforced: the decision's items after code drops, plus evidence requirements it did not carry.
  missing: MissingItem[];
}

export interface CapContext {
  flags: string[];
  citations: ResolvedCitation[];
  locationExists: (file: string, line: number) => boolean;
  policy: string;
}

const USABLE = new Set(["OK", "MOVED"]);

// Code has the last word over the decision model: a verdict may never be stronger than the evidence record allows,
// and the evidence record may not point at code that does not exist.
export function applyCaps(judgment: Judgment, evidenceRecord: Evidence, ctx: CapContext): Capped {
  let j = judgment;
  let e = evidenceRecord;
  const caps: string[] = [];
  let verdict = j.verdict;
  let severity = j.severity_supported;

  // Evidence items are numbered before anything is dropped, matching the ids the decider was shown.
  const numbered = e.missing_evidence.map((item, i) => ({ ...item, id: `E${i + 1}` }));

  // Obligation 1 (scope, references resolve) is decided by code, not by a model, but only when every citation settles it.
  const codeOwnsScope = ctx.citations.length > 0 && ctx.citations.every((c) => USABLE.has(c.status));
  const keep = (i: { obligation: number }) => !codeOwnsScope || i.obligation !== 1;
  if (codeOwnsScope && [...e.missing_evidence, ...j.missing].some((i) => !keep(i))) {
    caps.push("dropped obligation-1 items: code verified every citation resolves in scope");
  }
  const evidenceItems = numbered.filter(keep);
  e = { ...e, missing_evidence: evidenceItems.map(({ id: _, ...item }) => item) };
  j = { ...j, missing: j.missing.filter(keep) };

  const realBlocking = e.blocking_code.filter((b) => ctx.locationExists(b.file, b.line));
  if (realBlocking.length < e.blocking_code.length) {
    caps.push(`dropped ${e.blocking_code.length - realBlocking.length} blocking reference(s) to code that does not exist`);
  }
  const evidence = { ...e, blocking_code: realBlocking };
  const rootExists = ctx.locationExists(e.root_cause_file, e.root_cause_line);

  // A negative verdict is held to the same standard as READY: it must rest on real code or a quotable clause.
  if (verdict === "BLOCKED_BY_CODE" && realBlocking.length === 0) {
    verdict = "NEEDS_PROOF";
    caps.push("verdict capped to NEEDS_PROOF: BLOCKED_BY_CODE names no blocking code that exists in the audited source");
  }
  if (verdict === "KNOWN_OR_OUT_OF_SCOPE" && !groundedClause(j.exclusion.clause, ctx.policy)) {
    verdict = "NEEDS_PROOF";
    caps.push("verdict capped to NEEDS_PROOF: the exclusion does not quote a clause or bot finding from the contest policy");
  }

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

  // The decision may not quietly drop a requirement the evidence layer raised: each one is matched by id, and a person reconciles any gap.
  const carried = new Set(requiredItems(j.missing).map((i) => i.evidence_ref.trim().toUpperCase()));
  const uncarried = requiredItems(evidenceItems).filter((i) => !carried.has(i.id));
  if (uncarried.length) {
    caps.push(`layers disagree: evidence requires ${uncarried.map((i) => `${i.id} (obligation ${i.obligation})`).join(", ")}, the decision does not`);
  }

  if (e.impact === "informational" && severity !== "low_or_none") {
    caps.push(`severity ${severity} capped: evidence impact is informational`);
    severity = "low_or_none";
  }

  const missing = [...j.missing.map(({ evidence_ref: _, ...item }) => item), ...uncarried.map(({ id: _, ...item }) => item)];
  return { verdict, severity, caps, evidence, missing };
}
