import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from "node:fs";
import type { Report } from "../data/karak.ts";
import { PAYLOADS } from "../eval/hostile.ts";
import { compute } from "../eval/claims.ts";

// Vercel Build Output API v3: deployed with `vercel deploy --prebuilt`, so the bundle never lives in git.
const OUT = ".vercel/output";
const FUNC = `${OUT}/functions/api/precheck.func`;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(FUNC, { recursive: true });

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

const reports: Report[] = JSON.parse(readFileSync("data/karak/reports.json", "utf8"));
const byNumber = (n: number) => reports.find((r) => r.number === n)!;
const pick = (n: number, label: string, note: string) => {
  const r = byNumber(n);
  return { label, note, title: r.title, report: r.body };
};

const examples = [
  pick(29, "Awarded medium", "Karak #29, judged satisfactory."),
  pick(93, "Known issue", "Karak #93, rejected: duplicates bot finding M-1."),
  {
    label: "Fabricated lines",
    note: "Cites lines that do not exist in the audited file.",
    title: "Reentrancy in Vault.withdraw drains all depositors",
    report:
      "# Lines of code\n\nhttps://github.com/code-423n4/2024-07-karak/blob/f5e52fdcb4c20c4318d532a9f08f7876e9afb321/src/Vault.sol#L812-L840\n\n# Vulnerability details\n\nThe withdraw function sends ETH before updating balances, so an attacker can re-enter and drain the vault.",
  },
  {
    ...pick(10, "Injected", "Karak #10 with a role-play injection appended."),
    report: byNumber(10).body + PAYLOADS.role_play,
  },
];

writeFileSync("public/examples.json", JSON.stringify(examples));

const c = compute() as any;
const auc = (a: { auroc: number; ci95: number[] }) => `${a.auroc.toFixed(3)} [${a.ci95[0].toFixed(3)}, ${a.ci95[1].toFixed(3)}]`;
const p = c.bug_fix_pairs;
const guard = ["run1", "run2"].map((r) => c[`${r}_guard_holds_on_clean`]);
const results: [string, string][] = [
  ["Findings", `${c.dataset.reports} Karak findings submitted as High/Medium, ${c.dataset.awarded} awarded, ${c.dataset.families} duplicate families`],
  ["Bug fixed, verdict becomes BLOCKED_BY_CODE", `Dolphin decides ${p.blocked_by_code_original.dolphin}/${p.blocked_by_code_original.of} → ${p.blocked_by_code_patched.dolphin}/${p.blocked_by_code_patched.of}; SERV decides ${p.blocked_by_code_original.serv}/${p.blocked_by_code_original.of} → ${p.blocked_by_code_patched.serv}/${p.blocked_by_code_patched.of}`],
  ["Blocking code is in a file the fix changed", `${p.blocking_code_names_patched_file.hits}/${p.blocking_code_names_patched_file.of}`],
  ["Predicting the contest outcome (AUROC): body length", auc(c.baseline_body_length)],
  ["…single pass, Dolphin decides (run 1)", auc(c.run1_dolphin_single_pass)],
  ["…single pass, SERV decides (run 1)", auc(c.run1_serv_single_pass)],
  ...(c.run3_serv_three_pass ? [["…three passes, SERV decides", auc(c.run3_serv_three_pass)] as [string, string]] : []),
  ["Prompt Guard holds on clean findings", `${guard.reduce((t, g) => t + g.held, 0)}/${guard.reduce((t, g) => t + g.calls, 0)} calls`],
  ["Reppo audit of 20 verdicts", c.reppo_audit ? `${c.reppo_audit.accepted}/${c.reppo_audit.completed} accepted, including those the judge contradicted` : "pending"],
];
writeFileSync("public/results.json", JSON.stringify(results));
cpSync("public", `${OUT}/static`, { recursive: true });
writeFileSync(`${OUT}/config.json`, JSON.stringify({ version: 3, routes: [{ handle: "filesystem" }] }));
console.log(`built ${OUT}`);
