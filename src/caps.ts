import type { Evidence } from "./evidence.ts";
import type { Judgment, ModelVerdict } from "./verdict.ts";
import type { ResolvedCitation } from "./citations.ts";
import { requiredItems, type DecisionItem, type MissingItem } from "./obligations.ts";
import { groundedClause, POLICY_INCOMPLETE } from "./policy.ts";

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

  let readyCapped: string[] = [];
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
      readyCapped = reasons;
    }
  }

  // A reference proves the clause or line exists, not that it applies, so negative advice always goes to the user's own review.
  if (verdict === "KNOWN_OR_OUT_OF_SCOPE" || verdict === "BLOCKED_BY_CODE") {
    caps.push("review required: negative advice is shown with its grounds and never applied automatically");
  }
  if (ctx.policy.includes(POLICY_INCOMPLETE)) caps.push("review required: contest policy incomplete");

  // A decision item carries an evidence requirement only if it names a required item with the same obligation;
  // the evidence item's own text is then what gets published, so a relabelled item cannot replace it.
  const byId = new Map(evidenceItems.map((i) => [i.id, i]));
  const carries = (d: DecisionItem) => {
    const ev = byId.get(d.evidence_ref.trim().toUpperCase());
    return ev && ev.category === "required" && d.category === "required" && ev.obligation === d.obligation ? ev : null;
  };
  const carried = new Set(j.missing.map((d) => carries(d)?.id).filter(Boolean));
  const uncarried = requiredItems(evidenceItems).filter((i) => !carried.has(i.id));
  if (uncarried.length) {
    caps.push(`layers disagree: evidence requires ${uncarried.map((i) => `${i.id} (obligation ${i.obligation})`).join(", ")}, the decision does not`);
  }

  if (e.impact === "informational" && severity !== "low_or_none") {
    caps.push(`severity ${severity} capped: evidence impact is informational`);
    severity = "low_or_none";
  }

  const published = new Set<string>();
  const decided: MissingItem[] = j.missing.flatMap((d) => {
    const ev = carries(d);
    const { evidence_ref: _, ...own } = d;
    if (!ev) return [own];
    if (published.has(ev.id)) return [];
    published.add(ev.id);
    const { id: __, ...item } = ev;
    return [{ ...item, why: d.why }];
  });
  const missing = [...decided, ...uncarried.map(({ id: _, ...item }) => item)];

  // A capped READY always says what would resolve it, never an empty checklist.
  if (readyCapped.length && requiredItems(missing).length === 0) {
    if (e.trusted_role_required) {
      missing.push({
        item: "Show that the contest policy does not trust this role for this action, or which stated defense against a compromised role the attack defeats",
        category: "required",
        obligation: 2,
        why: "The path needs a role the policy lists as trusted; that is acceptable only if the policy limits the role here or promises a defense the attack breaks.",
        resolves_when: "The finding quotes the policy clause that limits the role, or names the guardian, delay, recovery or veto it bypasses and shows the bypass.",
      });
    }
    const other = readyCapped.filter((r) => r !== "requires a trusted role");
    if (other.length) {
      missing.push({ item: `Resolve what code found: ${other.join("; ")}`, category: "required", obligation: 5, why: "Code checks on the evidence did not pass.", resolves_when: "Each listed check passes on the revised finding." });
    }
  }
  return { verdict, severity, caps, evidence, missing };
}
