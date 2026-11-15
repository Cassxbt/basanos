import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, rmSync, cpSync } from "node:fs";
import type { Report } from "../data/karak.ts";
import type { ConsensusRow } from "../eval/consensus.ts";
import { EVIDENCE_PAYLOAD } from "../eval/consensus.ts";
import { renderPages } from "../site/render.ts";

// Vercel Build Output API v3: deployed with `vercel deploy --prebuilt`, so generated files never live in git.
const OUT = ".vercel/output";
const STATIC = `${OUT}/static`;
const FUNC = `${OUT}/functions/api/precheck.func`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(FUNC, { recursive: true });
mkdirSync(`${STATIC}/assets`, { recursive: true });
mkdirSync(`${STATIC}/data`, { recursive: true });

await build({
  entryPoints: ["src/web/handler.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: `${FUNC}/index.mjs`,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
writeFileSync(`${FUNC}/package.json`, JSON.stringify({ type: "module" }));
writeFileSync(
  `${FUNC}/.vc-config.json`,
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: 60, shouldAddHelpers: true }),
);

await build({
  entryPoints: ["site", "check", "judges", "proof", "agents"].map((n) => `src/site/client/${n}.ts`),
  bundle: true,
  splitting: true,
  format: "esm",
  target: "es2022",
  minify: true,
  outdir: `${STATIC}/assets`,
});
cpSync("site/assets/site.css", `${STATIC}/assets/site.css`);
cpSync("site/data/cli-93.txt", `${STATIC}/data/cli-93.txt`);

const jsonl = <T>(p: string): T[] => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const reports: Report[] = JSON.parse(readFileSync("data/karak/reports.json", "utf8"));
const byNumber = (n: number) => reports.find((r) => r.number === n)!;
const finding = (n: number) => ({ title: byNumber(n).title, report: byNumber(n).body });

const fabricated = {
  title: "Reentrancy in Vault.withdraw drains all depositors",
  report:
    "# Lines of code\n\nhttps://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Vault.sol#L812-L840\n\n# Vulnerability details\n\nThe withdraw function sends ETH before updating balances, so an attacker can re-enter and drain the vault.",
};
const unrelated = {
  title: "Reentrancy in Vault.withdraw drains all depositors",
  report:
    "# Lines of code\n\nhttps://github.com/code-423n4/2024-07-karak/blob/main/src/Core.sol#L200-L210\n\n# Vulnerability details\n\nThe withdraw function sends ETH before updating balances, so an attacker can re-enter and drain the vault.",
};
const injected = { title: byNumber(10).title, report: byNumber(10).body + EVIDENCE_PAYLOAD };

writeFileSync(`${STATIC}/data/examples.json`, JSON.stringify([
  { label: "Awarded medium", note: "Karak #29, judged satisfactory", ...finding(29) },
  { label: "Known issue", note: "Karak #93, a duplicate of bot finding M-1", ...finding(93) },
  { label: "Fabricated lines", note: "Cites lines past the end of the audited file", ...fabricated },
  { label: "Unrelated span", note: "Real lines the finding never discusses", ...unrelated },
  { label: "Injected", note: "Karak #10 with a note aimed at the evidence step", ...injected },
]));
writeFileSync(`${STATIC}/data/attacks.json`, JSON.stringify([
  { key: "fabricated", contest: "karak", ...fabricated },
  { key: "known", contest: "karak", ...finding(93) },
  { key: "injected", contest: "karak", ...injected },
  { key: "patched", contest: "karak-fix31", ...finding(31) },
]));

const shippedRun = JSON.parse(readFileSync("data/claims.json", "utf8")).shipped_source ?? "run4";
const run4 = new Map(jsonl<ConsensusRow>(`data/runs/${shippedRun}.jsonl`).map((r) => [r.id, r]));
const arm = (a: ConsensusRow["serv"]) => ({
  score: a.score,
  verdict: a.verdict,
  agreement: a.agreement,
  reason: a.reason ?? null,
  missing: a.missing ?? [],
  votes: a.votes.map((v) => ({ verdict: v.verdict, id: v.requestId, caps: v.caps, reason: v.reason ?? null, missing: v.missing ?? [] })),
});
const fixes: { number: number; files: string[]; summary: string }[] = JSON.parse(readFileSync("data/karak/fixes.json", "utf8"));
writeFileSync(`${STATIC}/data/proof.json`, JSON.stringify({
  rows: reports.map((r) => {
    const row = run4.get(r.id)!;
    return {
      id: r.id, n: r.number, title: r.title, family: r.family, awarded: r.awarded, final: r.finalSeverity,
      len: r.body.length, flags: row.flags ?? [], held: Boolean(row.frontDoorHeld), vetoed: Boolean(row.vetoed),
      serv: arm(row.serv), dolphin: arm(row.dolphin),
    };
  }),
  pairs: ["pairs1", "pairs2"].flatMap((p) => jsonl<any>(`data/runs/${p}.jsonl`)).filter((r) => r.mode === "model_only").map((r) => ({
    number: r.number,
    serv: r.serv.verdict,
    dolphin: r.dolphin.verdict,
    blocking: r.evidence.blocking_code.map((b: { file: string }) => b.file),
    fixFiles: fixes.find((f) => f.number === r.number)!.files,
  })),
  fixes: fixes.map((f) => ({ number: f.number, summary: f.summary })),
  hostile3: jsonl<ConsensusRow>("data/runs/hostile3.jsonl").map((r) => ({
    id: r.id,
    injected: r.id.split("-").length > 2,
    servVerdict: r.serv.verdict,
    servAgreement: r.serv.agreement,
    flagged: Boolean(r.flags?.length),
  })),
}));
cpSync("data/claims.json", `${STATIC}/data/claims.json`);

const pages = renderPages("site/pages", STATIC);
writeFileSync(`${OUT}/config.json`, JSON.stringify({
  version: 3,
  routes: [
    { src: "^/(judges|proof|how|agents)$", status: 308, headers: { Location: "/$1/" } },
    { handle: "filesystem" },
  ],
}));
console.log(`built ${OUT}: ${pages.join(" ")}`);
