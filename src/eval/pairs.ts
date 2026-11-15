import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { karak, KARAK_POLICY, type Report } from "../data/karak.ts";
import { GitSource } from "../source.ts";
import { parseCitations, resolveCitation, type Contest } from "../citations.ts";
import { extractEvidence, DOLPHIN_MODEL } from "../evidence.ts";
import { judge, SERV_MODEL } from "../verdict.ts";
import { citationVeto, summarizeCitations } from "../precheck.ts";
import { GuardBlocked, type Provider } from "../llm.ts";

interface Fix {
  number: number;
  commit: string;
  unfixable_in_code?: boolean;
}

type Mode = "full" | "model_only";

async function decide(provider: Provider, model: string, r: Report, citationText: string, evidence: any) {
  try {
    const j = await judge(provider, model, r, citationText, evidence);
    return { verdict: j.value.verdict, severity: j.value.severity_supported, reason: j.value.reason, requestId: j.requestId, usd: j.usd };
  } catch (err) {
    if (!(err instanceof GuardBlocked)) throw err;
    return { verdict: "INJECTION_BLOCKED", severity: null, reason: err.message, requestId: null, usd: 0 };
  }
}

// In model_only mode the citation statuses are withheld, so only a read of the patched source can reveal the fix.
async function check(r: Report, contest: Contest, mode: Mode) {
  const citations = parseCitations(r.body, contest.githubRepo, "f5e52fdcb4c20c4318d532a9f08f7876e9afb321").map((c) =>
    resolveCitation(c, contest),
  );
  if (mode === "full") {
    const veto = citationVeto(citations);
    if (veto) return { vetoed: veto.verdict, citations: citations.map((c) => c.status) };
  }
  const shown = mode === "full" ? citations : null;
  const citationText = mode === "full" ? summarizeCitations(citations) : "Citation check withheld for this test.";
  const e = await extractEvidence(r, shown, contest, KARAK_POLICY);
  const [dolphin, serv] = await Promise.all([
    decide("dolphin", DOLPHIN_MODEL, r, citationText, e.value),
    decide("serv", SERV_MODEL, r, citationText, e.value),
  ]);
  return { vetoed: null, citations: citations.map((c) => c.status), evidence: e.value, dolphin, serv };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const run = process.argv[2] ?? "pairs1";
  const out = `data/runs/${run}.jsonl`;
  const fixes: Fix[] = JSON.parse(readFileSync("data/karak/fixes.json", "utf8")).filter((f: Fix) => !f.unfixable_in_code && f.commit);
  const reports: Report[] = JSON.parse(readFileSync("data/karak/reports.json", "utf8"));
  const git = new GitSource("data/karak/repo");
  const done = new Set(existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).key) : []);
  const jobs = fixes.flatMap((f) => (["full", "model_only"] as Mode[]).map((mode) => ({ f, mode, key: `${f.number}:${mode}` })));
  const queue = jobs.filter((j) => !done.has(j.key));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      const { f, mode, key } = job;
      const r = reports.find((x) => x.number === f.number)!;
      const result = await check(r, karak(git, f.commit), mode);
      appendFileSync(out, JSON.stringify({ key, number: f.number, mode, fixCommit: f.commit, ...result }) + "\n");
      console.log(`${key} ${result.vetoed ?? `dolphin=${result.dolphin!.verdict}/${result.dolphin!.severity} serv=${result.serv!.verdict}/${result.serv!.severity}`}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
}
