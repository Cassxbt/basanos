import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { KARAK, type Report } from "../data/karak.ts";
import { loadScope } from "../citations.ts";
import { loadPolicy, renderPolicy } from "../policy.ts";
import { extractEvidence, DOLPHIN_MODEL } from "../evidence.ts";
import { judge, SERV_MODEL } from "../verdict.ts";
import { citationVeto, summarizeCitations } from "../precheck.ts";
import { GuardBlocked } from "../llm.ts";

export interface ArmResult {
  verdict: string;
  severity: string | null;
  reason: string;
  missing: string[];
  requestId: string | null;
  usd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface Row {
  id: string;
  run: string;
  vetoed: string | null;
  evidence: { value: unknown; usd: number; inputTokens: number; outputTokens: number; requestId: string | null } | null;
  dolphin: ArmResult | null;
  serv: ArmResult | null;
}

async function arm(provider: "dolphin" | "serv", model: string, r: Report, evidence: any): Promise<ArmResult> {
  try {
    const j = await judge(provider, model, r, summarizeCitations(r.citations), evidence);
    return {
      verdict: j.value.verdict,
      severity: j.value.severity_supported,
      reason: j.value.reason,
      missing: j.value.missing,
      requestId: j.requestId,
      usd: j.usd,
      inputTokens: j.inputTokens,
      outputTokens: j.outputTokens,
    };
  } catch (err) {
    if (!(err instanceof GuardBlocked)) throw err;
    return { verdict: "INJECTION_BLOCKED", severity: null, reason: err.message, missing: [], requestId: null, usd: 0, inputTokens: 0, outputTokens: 0 };
  }
}

export async function evaluate(r: Report, run: string, policy: string): Promise<Row> {
  const veto = citationVeto(r.citations);
  if (veto) return { id: r.id, run, vetoed: veto.verdict, evidence: null, dolphin: null, serv: null };
  const e = await extractEvidence(r, r.citations, KARAK, policy);
  const [dolphin, serv] = await Promise.all([
    arm("dolphin", DOLPHIN_MODEL, r, e.value),
    arm("serv", SERV_MODEL, r, e.value),
  ]);
  return {
    id: r.id,
    run,
    vetoed: null,
    evidence: { value: e.value, usd: e.usd, inputTokens: e.inputTokens, outputTokens: e.outputTokens, requestId: e.requestId },
    dolphin,
    serv,
  };
}

async function pool<T>(items: T[], size: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = process.argv[2] ?? "run1";
  const input = process.argv[3] ?? "data/karak/reports.json";
  const out = process.argv[4] ?? `data/runs/${run}.jsonl`;
  KARAK.scope = loadScope(KARAK.repoDir, KARAK.auditedCommit);
  const policy = renderPolicy(loadPolicy(KARAK.repoDir));
  const reports: Report[] = JSON.parse(readFileSync(input, "utf8"));
  mkdirSync("data/runs", { recursive: true });
  const done = new Set(
    existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).id) : [],
  );
  const todo = reports.filter((r) => !done.has(r.id));
  console.log(`${run}: ${todo.length} to go (${done.size} cached)`);
  let n = 0;
  await pool(todo, 4, async (r) => {
    try {
      const row = await evaluate(r, run, policy);
      appendFileSync(out, JSON.stringify(row) + "\n");
      n++;
      console.log(`${n}/${todo.length} ${r.id} dolphin=${row.dolphin?.verdict ?? row.vetoed} serv=${row.serv?.verdict ?? row.vetoed}`);
    } catch (err) {
      console.error(`FAIL ${r.id}: ${(err as Error).message}`);
    }
  });
  if (!existsSync(out)) writeFileSync(out, "");
}
