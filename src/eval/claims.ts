import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Report } from "../data/karak.ts";
import type { Row } from "./run.ts";
import type { ConsensusRow } from "./consensus.ts";
import { auroc, clusterBootstrap } from "./score.ts";
import { ordinal } from "../precheck.ts";

const CLAIMS = "data/claims.json";
const jsonl = <T>(path: string): T[] => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r5 = (x: number) => Math.round(x * 1e5) / 1e5;

export function compute() {
  const reports: Report[] = JSON.parse(readFileSync("data/karak/reports.json", "utf8"));
  const labels = reports.map((r) => r.awarded);
  const clusters = reports.map((r) => r.family);
  const auc = (scores: number[]) => {
    const [lo, hi] = clusterBootstrap(scores, labels, clusters);
    return { auroc: r3(auroc(scores, labels)), ci95: [r3(lo), r3(hi)] };
  };

  const consensusRun = (name: string) => {
    const rows = jsonl<ConsensusRow>(`data/runs/${name}.jsonl`);
    if (rows.length !== reports.length) return null;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const arm = (which: "serv" | "dolphin") => {
      const arms = reports.map((r) => byId.get(r.id)![which]);
      const automaticRejects = reports.filter((r, i) => {
        const row = byId.get(r.id)!;
        return (row.vetoed || (arms[i].agreement === "unanimous" && !row.flags?.length)) && arms[i].score === 0;
      });
      return {
        ...auc(arms.map((a) => a.score)),
        unanimous: arms.filter((a) => a.agreement === "unanimous").length,
        automatic_rejects: automaticRejects.length,
        automatic_rejects_not_awarded: automaticRejects.filter((r) => !r.awarded).length,
        ready: arms.filter((a) => a.verdict === "READY").length,
        decision_usd: r5(arms.flatMap((a) => a.votes).reduce((t, v) => t + v.usd, 0)),
      };
    };
    const evidenceUsd = rows.reduce((t, r) => t + r.evidenceUsd, 0);
    const serv = arm("serv");
    return {
      serv,
      dolphin: arm("dolphin"),
      front_door_held: rows.filter((r) => r.frontDoorHeld).length,
      flagged: rows.filter((r) => r.flags?.length).length,
      usd_per_check: r5((evidenceUsd + serv.decision_usd) / rows.length),
    };
  };

  const single = (run: string) => {
    const byId = new Map(jsonl<Row>(`data/runs/${run}.jsonl`).map((r) => [r.id, r]));
    const score = (which: "dolphin" | "serv") =>
      auc(reports.map((r) => {
        const row = byId.get(r.id)!;
        return row.vetoed ? 0 : ordinal(row[which]!.verdict, row[which]!.severity);
      }));
    const servRows = [...byId.values()].filter((r) => r.serv);
    return {
      dolphin: score("dolphin"),
      serv: score("serv"),
      guard_held: servRows.filter((r) => r.serv!.verdict === "INJECTION_BLOCKED").length,
      guard_calls: servRows.length,
    };
  };

  const fixes: { number: number; files: string[] }[] = JSON.parse(readFileSync("data/karak/fixes.json", "utf8"));
  const pairs = ["pairs1", "pairs2"].flatMap((p) => jsonl<any>(`data/runs/${p}.jsonl`)).filter((r) => r.mode === "model_only");
  const before = ["run1", "run2"].flatMap((run) => {
    const byId = new Map(jsonl<Row>(`data/runs/${run}.jsonl`).map((r) => [r.id, r]));
    return fixes.map((f) => byId.get(`karak-${f.number}`)!);
  });
  const named = pairs.filter((r) => r.evidence.blocking_code.length);

  const hostile = (name: string) => {
    const rows = jsonl<ConsensusRow>(`data/runs/${name}.jsonl`);
    if (rows.length !== 70) return null;
    const clean = rows.filter((r) => r.id.split("-").length === 2);
    const injected = rows.filter((r) => r.id.split("-").length > 2);
    const routedAutomatically = (r: ConsensusRow, which: "serv" | "dolphin") => r[which].agreement === "unanimous" && !r.flags?.length;
    return {
      injected: injected.length,
      clean_ready: { serv: clean.filter((r) => r.serv.verdict === "READY").length, dolphin: clean.filter((r) => r.dolphin.verdict === "READY").length, of: clean.length },
      ready: { serv: injected.filter((r) => r.serv.verdict === "READY").length, dolphin: injected.filter((r) => r.dolphin.verdict === "READY").length },
      ready_routed_automatically: {
        serv: injected.filter((r) => r.serv.verdict === "READY" && routedAutomatically(r, "serv")).length,
        dolphin: injected.filter((r) => r.dolphin.verdict === "READY" && routedAutomatically(r, "dolphin")).length,
      },
      front_door_held: injected.filter((r) => r.frontDoorHeld).length,
      flagged: injected.filter((r) => r.flags?.length).length,
    };
  };

  const audit = jsonl<any>("data/runs/reppo-audit.jsonl").filter((a) => a.status === "COMPLETED");
  const run1 = single("run1");
  const run2 = single("run2");

  return {
    dataset: { reports: reports.length, awarded: labels.filter(Boolean).length, families: new Set(clusters).size },
    baseline_body_length: auc(reports.map((r) => r.body.length)),
    shipped: consensusRun("run4"),
    undefended_three_pass: consensusRun("run3"),
    single_pass: { run1, run2 },
    guard_on_clean: { held: run1.guard_held + run2.guard_held, calls: run1.guard_calls + run2.guard_calls },
    bug_fix_pairs: {
      findings: fixes.length,
      runs: 2,
      blocked_original: {
        dolphin: before.filter((r) => r.dolphin!.verdict === "BLOCKED_BY_CODE").length,
        serv: before.filter((r) => r.serv!.verdict === "BLOCKED_BY_CODE").length,
        of: before.length,
      },
      blocked_patched: {
        dolphin: pairs.filter((r) => r.dolphin.verdict === "BLOCKED_BY_CODE").length,
        serv: pairs.filter((r) => r.serv.verdict === "BLOCKED_BY_CODE").length,
        of: pairs.length,
      },
      blocking_names_patched_file: {
        hits: named.filter((r) => r.evidence.blocking_code.some((b: { file: string }) => fixes.find((f) => f.number === r.number)!.files.includes(b.file))).length,
        of: named.length,
      },
    },
    hostile_v2_undefended: hostile("hostile2"),
    hostile_v3_defended_blind: hostile("hostile3"),
    reppo_audit: {
      completed: audit.length,
      accepted: audit.filter((a) => a.decision === "accept").length,
      routes: Object.fromEntries(["ship", "review", "block"].map((k) => [k, audit.filter((a) => a.route === k).length])),
      ids: audit.map((a) => a.reppoId),
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const now = compute();
  if (process.argv[2] === "--write") {
    writeFileSync(CLAIMS, JSON.stringify(now, null, 2) + "\n");
    console.log(`wrote ${CLAIMS}`);
  } else {
    const published = existsSync(CLAIMS) ? readFileSync(CLAIMS, "utf8") : "";
    if (published !== JSON.stringify(now, null, 2) + "\n") {
      console.error("claims.json does not match the committed run data. Run `npm run verify -- --write` only if the data changed on purpose.");
      process.exit(1);
    }
    console.log(`verified: every published number matches the committed run data`);
  }
}
