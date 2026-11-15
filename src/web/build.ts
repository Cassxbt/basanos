import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import type { Report } from "../data/karak.ts";
import { PAYLOADS } from "../eval/hostile.ts";

await build({
  entryPoints: ["src/web/handler.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: "api/precheck.mjs",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});

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

mkdirSync("public", { recursive: true });
writeFileSync("public/examples.json", JSON.stringify(examples));
console.log("built api/precheck.mjs and public/examples.json");
