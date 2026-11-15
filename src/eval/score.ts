import { readFileSync, writeFileSync } from "node:fs";
import type { Report } from "../data/karak.ts";
import type { Row, ArmResult } from "./run.ts";

const ZERO = new Set(["BLOCKED_BY_CODE", "KNOWN_OR_OUT_OF_SCOPE", "CITATION_BROKEN", "INJECTION_BLOCKED"]);

export function ordinal(verdict: string, severity: string | null): number {
  if (ZERO.has(verdict)) return 0;
  if (verdict === "READY") return 3;
  if (verdict === "NEEDS_PROOF") return severity === "high" || severity === "medium" ? 2 : 1;
  throw new Error(`unknown verdict ${verdict}`);
}

// Mann-Whitney AUROC; ties count half.
export function auroc(scores: number[], labels: boolean[]): number {
  const pos = scores.filter((_, i) => labels[i]);
  const neg = scores.filter((_, i) => !labels[i]);
  if (!pos.length || !neg.length) return NaN;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function clusterBootstrap(
  scores: number[], labels: boolean[], clusters: number[], iters = 2000, seed = 7,
): [number, number] {
  const ids = [...new Set(clusters)];
  const members = new Map(ids.map((id) => [id, clusters.flatMap((c, i) => (c === id ? [i] : []))]));
  const rand = rng(seed);
  const stats: number[] = [];
  for (let k = 0; k < iters; k++) {
    const s: number[] = [], l: boolean[] = [];
    for (let n = 0; n < ids.length; n++) {
      for (const i of members.get(ids[Math.floor(rand() * ids.length)])!) { s.push(scores[i]); l.push(labels[i]); }
    }
    const a = auroc(s, l);
    if (!Number.isNaN(a)) stats.push(a);
  }
  stats.sort((a, b) => a - b);
  return [stats[Math.floor(0.025 * stats.length)], stats[Math.floor(0.975 * stats.length)]];
}

function leaveOneFamilyOut(scores: number[], labels: boolean[], clusters: number[]): [number, number] {
  const values = [...new Set(clusters)]
    .map((f) => {
      const keep = clusters.map((c) => c !== f);
      return auroc(scores.filter((_, i) => keep[i]), labels.filter((_, i) => keep[i]));
    })
    .filter((v) => !Number.isNaN(v));
  return [Math.min(...values), Math.max(...values)];
}

const r3 = (x: number) => x.toFixed(3);

function describe(name: string, scores: number[], labels: boolean[], clusters: number[], primaries: boolean[]) {
  const a = auroc(scores, labels);
  const [lo, hi] = clusterBootstrap(scores, labels, clusters);
  const [lmin, lmax] = leaveOneFamilyOut(scores, labels, clusters);
  const fam = auroc(scores.filter((_, i) => primaries[i]), labels.filter((_, i) => primaries[i]));
  return { name, auroc: a, ci: [lo, hi], lofo: [lmin, lmax], familyAuroc: fam, line: `${name.padEnd(28)} AUROC ${r3(a)} [${r3(lo)}, ${r3(hi)}]  LOFO ${r3(lmin)}-${r3(lmax)}  family-level ${r3(fam)}` };
}

function flags(scores: number[], labels: boolean[]) {
  const flagged = scores.map((s) => s <= 1);
  const tp = flagged.filter((f, i) => f && !labels[i]).length;
  const nFlag = flagged.filter(Boolean).length;
  const nNeg = labels.filter((l) => !l).length;
  return { flagged: nFlag, precision: nFlag ? tp / nFlag : NaN, recall: tp / nNeg };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const reports: Report[] = JSON.parse(readFileSync("data/karak/reports.json", "utf8"));
  const runs = process.argv.slice(2).length ? process.argv.slice(2) : ["run1", "run2"];
  const byId = new Map(reports.map((r) => [r.id, r]));
  const labels = reports.map((r) => r.awarded);
  const clusters = reports.map((r) => r.family);
  const primaries = reports.map((r) => r.family === r.number);
  const out: string[] = [];
  const results: Record<string, unknown> = {};

  out.push(`n=${reports.length} awarded=${labels.filter(Boolean).length} families=${new Set(clusters).size}\n`);
  out.push("Baselines");
  const base: Record<string, number[]> = {
    "body length": reports.map((r) => r.body.length),
    "citation count": reports.map((r) => r.citations.length),
    "distinct files cited": reports.map((r) => new Set(r.citations.map((c) => c.path)).size),
    "presort sufficient": reports.map((r) => (r.presort === "sufficient" ? 1 : 0)),
    "code-only (citation veto)": reports.map((r) => (r.citations.some((c) => c.status === "OK" || c.status === "MOVED") ? 1 : 0)),
  };
  for (const [k, v] of Object.entries(base)) {
    const d = describe(k, v, labels, clusters, primaries);
    results[k] = d;
    out.push(d.line);
  }

  for (const run of runs) {
    const rows = new Map<string, Row>(
      readFileSync(`data/runs/${run}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l)).map((r: Row) => [r.id, r]),
    );
    const missing = reports.filter((r) => !rows.has(r.id)).map((r) => r.id);
    out.push(`\n${run}${missing.length ? ` (MISSING ${missing.length}: ${missing.join(",")})` : ""}`);
    const keep = reports.map((r) => rows.has(r.id));
    const L = labels.filter((_, i) => keep[i]);
    const C = clusters.filter((_, i) => keep[i]);
    const P = primaries.filter((_, i) => keep[i]);
    for (const armName of ["dolphin", "serv"] as const) {
      const scored = reports.filter((_, i) => keep[i]).map((r) => {
        const row = rows.get(r.id)!;
        if (row.vetoed) return 0;
        const a = row[armName] as ArmResult;
        return ordinal(a.verdict, a.severity);
      });
      const d = describe(`${armName === "dolphin" ? "B. Dolphin-only" : "C. Dolphin + SERV"}`, scored, L, C, P);
      const f = flags(scored, L);
      const verdicts: Record<string, number> = {};
      for (const r of reports.filter((_, i) => keep[i])) {
        const row = rows.get(r.id)!;
        const v = row.vetoed ?? (row[armName] as ArmResult).verdict;
        verdicts[v] = (verdicts[v] ?? 0) + 1;
      }
      const usd = [...rows.values()].reduce((s, row) => s + (row[armName]?.usd ?? 0), 0);
      const evidenceUsd = [...rows.values()].reduce((s, row) => s + (row.evidence?.usd ?? 0), 0);
      results[`${run}:${armName}`] = { ...d, ...f, verdicts, decisionUsd: usd, evidenceUsd };
      out.push(d.line);
      out.push(`   flag(score<=1): ${f.flagged} flagged, precision ${r3(f.precision)} (base ${r3(L.filter((l) => !l).length / L.length)}), recall ${r3(f.recall)}`);
      out.push(`   verdicts ${JSON.stringify(verdicts)}  decision $${usd.toFixed(4)}  evidence $${evidenceUsd.toFixed(4)}`);
    }
  }
  console.log(out.join("\n"));
  writeFileSync("data/runs/scores.json", JSON.stringify(results, null, 2));
}
