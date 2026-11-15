import { readFileSync, appendFileSync, existsSync, writeFileSync } from "node:fs";
import { KARAK, type Report } from "../data/karak.ts";
import { auditedSnippet } from "../citations.ts";
import { submitAction, waitFor } from "../reppo.ts";
import type { Row } from "./run.ts";

const OUT = "data/runs/reppo-audit.jsonl";
// Every submission is charged, so its id is written before polling starts and never resubmitted.
const IDS = "data/runs/reppo-ids.json";
const MAX_INPUT = 45_000;

function auditInput(r: Report, row: Row): string {
  const s = row.serv!;
  const code = r.citations
    .slice(0, 6)
    .map((c) => `${c.path}:${c.auditedStart ?? c.start}\n${auditedSnippet(c, KARAK, 3) ?? "(unresolved)"}`)
    .join("\n\n");
  const text = [
    "What the user asked for: before submitting this smart-contract audit finding to a Code4rena contest, check it against the audited code and say whether the evidence is enough for a judge to accept it at the claimed severity, and what proof is missing.",
    "",
    `What the agent did: returned verdict ${s.verdict} (evidence supports severity: ${s.severity ?? "n/a"}).`,
    `Agent's reason: ${s.reason}`,
    `Missing proof the agent listed: ${s.missing.length ? s.missing.map((m, i) => `${i + 1}. ${m}`).join(" ") : "none"}`,
    "",
    "Evaluate whether this verdict and the missing-proof list are correct and useful, given the finding and the cited code below.",
    "",
    `Evidence record the agent built from the full source: ${JSON.stringify(row.evidence!.value)}`,
    "",
    `Cited code at the audited commit:\n${code}`,
    "",
    `The finding (title: ${r.title}):\n${r.body}`,
  ].join("\n");
  return text.length > MAX_INPUT ? text.slice(0, MAX_INPUT) + "\n[truncated]" : text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reports: Report[] = JSON.parse(readFileSync("data/karak/reports.json", "utf8"));
  const rows = new Map<string, Row>(
    readFileSync("data/runs/run1.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r: Row) => [r.id, r]),
  );
  const eligible = reports
    .filter((r) => {
      const row = rows.get(r.id);
      return row && !row.vetoed && row.serv && row.serv.verdict !== "INJECTION_BLOCKED";
    })
    .sort((a, b) => a.number - b.number);
  const sample = [...eligible.filter((r) => r.awarded).slice(0, 10), ...eligible.filter((r) => !r.awarded).slice(0, 10)];
  const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : []);

  const known: Record<string, string> = existsSync(IDS) ? JSON.parse(readFileSync(IDS, "utf8")) : {};
  const idFor = new Map(Object.entries(known).map(([reppoId, reportId]) => [reportId, reppoId]));
  await Promise.all(
    sample.filter((r) => !done.has(r.id)).map(async (r) => {
      const row = rows.get(r.id)!;
      let reppoId = idFor.get(r.id);
      if (!reppoId) {
        reppoId = await submitAction(auditInput(r, row));
        known[reppoId] = r.id;
        writeFileSync(IDS, JSON.stringify(known, null, 1));
      }
      const res = await waitFor(reppoId);
      const line = {
        id: r.id,
        awarded: r.awarded,
        servVerdict: row.serv!.verdict,
        servSeverity: row.serv!.severity,
        reppoId,
        status: res.status,
        score: res.result ? res.score : null,
        route: res.route,
        decision: res.result?.decision ?? null,
        confidence: res.result?.confidence ?? null,
        reason: res.result?.reason ?? null,
        rubric: res.result?.rubric_scores ?? null,
        credits: res.creditsCharged,
      };
      appendFileSync(OUT, JSON.stringify(line) + "\n");
      console.log(`${r.id} awarded=${r.awarded} basanos=${line.servVerdict}/${line.servSeverity} reppo=${line.route} ${line.score} (${line.decision})`);
    }),
  );
}
