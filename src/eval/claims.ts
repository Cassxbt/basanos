import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Report } from "../data/karak.ts";
import type { Row } from "./run.ts";
import type { ConsensusRow } from "./consensus.ts";
import { auroc, clusterBootstrap } from "./score.ts";
import { ordinal } from "../precheck.ts";

const CLAIMS = "data/claims.json";
const jsonl = <T>(path: string): T[] => readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function compute() {
  const reports: Report[] = JSON.parse(readFileSync("data/karak/reports.json", "utf8"));
  const labels = reports.map((r) => r.awarded);
  const clusters = reports.map((r) => r.family);
  const auc = (scores: number[]) => {
    const [lo, hi] = clusterBootstrap(scores, labels, clusters);
    return { auroc: r3(auroc(scores, labels)), ci95: [r3(lo), r3(hi)] };
  };
  const out: Record<string, unknown> = {
    dataset: { reports: reports.length, awarded: labels.filter(Boolean).length, families: new Set(clusters).size },
    baseline_body_length: auc(reports.map((r) => r.body.length)),
  };

  for (const run of ["run1", "run2"]) {
    const rows = new Map(jsonl<Row>(`data/runs/${run}.jsonl`).map((r) => [r.id, r]));
    for (const arm of ["dolphin", "serv"] as const) {
      const scores = reports.map((r) => {
        const row = rows.get(r.id)!;
        return row.vetoed ? 0 : ordinal(row[arm]!.verdict, row[arm]!.severity);
      });
      out[`${run}_${arm}_single_pass`] = auc(scores);
    }
    const servCalls = [...rows.values()].filter((r) => r.serv);
    out[`${run}_guard_holds_on_clean`] = { held: servCalls.filter((r) => r.serv!.verdict === "INJECTION_BLOCKED").length, calls: servCalls.length };
  }

  const run3 = existsSync("data/runs/run3.jsonl") ? jsonl<ConsensusRow>("data/runs/run3.jsonl") : [];
  // A partial consensus run is never published.
  if (run3.length === reports.length) {
    const rows = new Map(run3.map((r) => [r.id, r]));
    for (const arm of ["dolphin", "serv"] as const) {
      const scores = reports.map((r) => rows.get(r.id)![arm].score);
      const arms = reports.map((r) => rows.get(r.id)![arm]);
      const automatic = reports.filter((r, i) => (arms[i].agreement === "unanimous" || rows.get(r.id)!.vetoed) && arms[i].score === 0);
      out[`run3_${arm}_three_pass`] = {
        ...auc(scores),
        unanimous: arms.filter((a) => a.agreement === "unanimous").length,
        automatic_reject_routes: automatic.length,
        automatic_reject_not_awarded: automatic.filter((r) => !r.awarded).length,
        decision_usd: r3(arms.flatMap((a) => a.votes).reduce((t, v) => t + v.usd, 0) * 1000) / 1000,
      };
    }
    out.run3_evidence_usd = r3([...rows.values()].reduce((t, r) => t + r.evidenceUsd, 0) * 1000) / 1000;
  }

  const fixes: { number: number; files: string[] }[] = JSON.parse(readFileSync("data/karak/fixes.json", "utf8"));
  const pairs = ["pairs1", "pairs2"].flatMap((p) => jsonl<any>(`data/runs/${p}.jsonl`)).filter((r) => r.mode === "model_only");
  const before = ["run1", "run2"].flatMap((run) => {
    const rows = new Map(jsonl<Row>(`data/runs/${run}.jsonl`).map((r) => [r.id, r]));
    return fixes.map((f) => rows.get(`karak-${f.number}`)!);
  });
  const named = pairs.filter((r) => r.evidence.blocking_code.length);
  out.bug_fix_pairs = {
    findings: fixes.length,
    runs: 2,
    blocked_by_code_original: { dolphin: before.filter((r) => r.dolphin!.verdict === "BLOCKED_BY_CODE").length, serv: before.filter((r) => r.serv!.verdict === "BLOCKED_BY_CODE").length, of: before.length },
    blocked_by_code_patched: { dolphin: pairs.filter((r) => r.dolphin.verdict === "BLOCKED_BY_CODE").length, serv: pairs.filter((r) => r.serv.verdict === "BLOCKED_BY_CODE").length, of: pairs.length },
    blocking_code_names_patched_file: {
      hits: named.filter((r) => r.evidence.blocking_code.some((b: { file: string }) => fixes.find((f) => f.number === r.number)!.files.includes(b.file))).length,
      of: named.length,
    },
  };

  if (existsSync("data/runs/reppo-audit.jsonl")) {
    const audit = jsonl<any>("data/runs/reppo-audit.jsonl").filter((a) => a.status === "COMPLETED");
    out.reppo_audit = {
      completed: audit.length,
      accepted: audit.filter((a) => a.decision === "accept").length,
      routes: Object.fromEntries(["ship", "review", "block"].map((k) => [k, audit.filter((a) => a.route === k).length])),
    };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = compute();
  if (process.argv[2] === "--write") {
    writeFileSync(CLAIMS, JSON.stringify(now, null, 2) + "\n");
    console.log(`wrote ${CLAIMS}`);
  } else {
    const published = JSON.parse(readFileSync(CLAIMS, "utf8"));
    const a = JSON.stringify(published, null, 2), b = JSON.stringify(now, null, 2);
    if (a !== b) {
      console.error("claims.json does not match the committed run data. Run `npm run verify -- --write` only if the data changed on purpose.");
      process.exit(1);
    }
    console.log(`verified: ${Object.keys(now).length} claim groups match the committed run data`);
  }
}
