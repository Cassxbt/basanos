import type { Precheck } from "./precheck.ts";

// Only a unanimous verdict on text that addresses no one but the reader is routed without a human.
const route = (p: Precheck) =>
  p.verdict === "CITATION_BROKEN" || (p.agreement === "unanimous" && p.flags.length === 0) ? "automatic" : "human";

export function toJson(p: Precheck) {
  const lead = p.votes.find((v) => v.verdict === p.verdict) ?? p.votes[0];
  return {
    verdict: p.verdict,
    agreement: p.agreement,
    route: route(p),
    severity_supported: p.severitySupported,
    missing: p.missing,
    reason: p.reason,
    caps: [...new Set(p.votes.flatMap((v) => v.caps))],
    flags: p.flags,
    citations: p.citations.map((c) => ({
      status: c.status,
      path: c.path,
      lines: [c.start, c.end],
      audited_lines: c.auditedStart ? [c.auditedStart, c.auditedEnd] : null,
    })),
    votes: p.votes.map((v) => ({
      verdict: v.verdict,
      severity: v.severity,
      request_id: v.judgment?.requestId ?? null,
    })),
    evidence: lead && {
      model: lead.evidence.model,
      tokens_read: lead.evidence.inputTokens,
      ...lead.evidence.value,
    },
    decision: p.decider && {
      provider: p.decider.provider,
      model: p.decider.model,
      prompt_guard_requested: p.decider.provider === "serv",
    },
    usd: Number(p.usd.toFixed(6)),
  };
}

export function toText(p: Precheck): string {
  const j = toJson(p);
  const lines: string[] = [];
  const sev = j.severity_supported ? `  (evidence supports: ${j.severity_supported.replaceAll("_", " ")})` : "";
  lines.push(`${j.verdict}${sev}`);
  if (j.agreement) lines.push(`${j.votes.length} passes, ${j.agreement}: ${j.route === "automatic" ? "safe to route automatically" : "send to a human"}`);
  lines.push("", j.reason);
  for (const c of j.caps) lines.push(`(${c})`);
  if (j.flags.length) lines.push(`(text addressed to the reviewer: ${j.flags.join(", ")})`);
  if (j.missing.length) {
    lines.push("", "Missing before you submit:");
    j.missing.forEach((m, i) => lines.push(`  ${i + 1}. ${m}`));
  }
  const counts = new Map<string, number>();
  for (const c of j.citations) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  lines.push("", `Citations: ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ") || "none"}`);
  for (const c of j.citations.filter((c) => c.status !== "OK")) {
    lines.push(`  ${c.status} ${c.path}#L${c.lines[0]}-L${c.lines[1]}${c.audited_lines ? ` -> L${c.audited_lines[0]}` : ""}`);
  }
  if (j.evidence) {
    const e = j.evidence;
    lines.push(
      "",
      `Evidence (${e.model}, read ${e.tokens_read.toLocaleString()} tokens):`,
      `  code supports claim: ${e.code_supports_claim}  |  PoC: ${e.poc.replaceAll("_", " ")}  |  known issue: ${e.known_issue_match || "none"}`,
    );
    for (const b of e.blocking_code) lines.push(`  blocked at ${b.file}:${b.line}: ${b.why}`);
  }
  if (j.decision) {
    const ids = j.votes.map((v) => v.request_id).filter(Boolean).join(", ");
    lines.push(`Decision: ${j.decision.provider} ${j.decision.model}${j.decision.prompt_guard_requested ? " + Prompt Guard" : ""}${ids ? `  requests ${ids}` : ""}`);
  }
  lines.push(`Cost: $${p.usd.toFixed(5)}`);
  return lines.join("\n");
}
