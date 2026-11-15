import type { Precheck } from "./precheck.ts";

export function toJson(p: Precheck) {
  return {
    verdict: p.verdict,
    severity_supported: p.severitySupported,
    missing: p.missing,
    reason: p.reason,
    capped: p.capped,
    citations: p.citations.map((c) => ({
      status: c.status,
      path: c.path,
      lines: [c.start, c.end],
      audited_lines: c.auditedStart ? [c.auditedStart, c.auditedEnd] : null,
    })),
    evidence: p.evidence && {
      model: p.evidence.model,
      tokens_read: p.evidence.inputTokens,
      ...p.evidence.value,
    },
    decision: p.judgment && {
      provider: p.judgment.provider,
      model: p.judgment.model,
      serv_request_id: p.judgment.provider === "serv" ? p.judgment.requestId : null,
      prompt_guard: p.judgment.provider === "serv",
    },
    usd: Number(p.usd.toFixed(6)),
  };
}

export function toText(p: Precheck): string {
  const lines: string[] = [];
  const sev = p.severitySupported ? `  (evidence supports: ${p.severitySupported.replaceAll("_", " ")})` : "";
  lines.push(`${p.verdict}${sev}`, "", p.reason);
  if (p.capped) lines.push(`(${p.capped})`);
  if (p.missing.length) {
    lines.push("", "Missing before you submit:");
    p.missing.forEach((m, i) => lines.push(`  ${i + 1}. ${m}`));
  }
  const counts = new Map<string, number>();
  for (const c of p.citations) counts.set(c.status, (counts.get(c.status) ?? 0) + 1);
  lines.push("", `Citations: ${[...counts].map(([s, n]) => `${n} ${s}`).join(", ") || "none"}`);
  for (const c of p.citations.filter((c) => c.status !== "OK")) {
    lines.push(`  ${c.status} ${c.path}#L${c.start}-L${c.end}${c.auditedStart ? ` -> L${c.auditedStart}` : ""}`);
  }
  if (p.evidence) {
    const e = p.evidence.value;
    lines.push(
      "",
      `Evidence (${p.evidence.model}, read ${p.evidence.inputTokens.toLocaleString()} tokens of source):`,
      `  code supports claim: ${e.code_supports_claim}  |  PoC: ${e.poc.replaceAll("_", " ")}  |  known issue: ${e.known_issue_match || "none"}`,
    );
    for (const b of e.blocking_code) lines.push(`  blocked at ${b.file}:${b.line}: ${b.why}`);
  }
  if (p.judgment) {
    const guard = p.judgment.provider === "serv" ? " + Prompt Guard" : "";
    lines.push(`Decision: ${p.judgment.provider} ${p.judgment.model}${guard}${p.judgment.provider === "serv" ? `  request ${p.judgment.requestId}` : ""}`);
  }
  lines.push(`Cost: $${p.usd.toFixed(5)}`);
  return lines.join("\n");
}
