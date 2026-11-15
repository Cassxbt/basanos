import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface BotFinding {
  id: string;
  title: string;
  instances: string[];
}

export interface Policy {
  readmeSections: string;
  botFindings: BotFinding[];
}

const README_SECTIONS = [
  /^## Automated Findings/,
  /^## Scoping Q/,
  /^## Main invariants/,
  /^## Attack ideas/,
  /^## All trusted roles/,
];

function sections(markdown: string, wanted: RegExp[]): string {
  const out: string[] = [];
  let keep = false;
  for (const line of markdown.split("\n")) {
    if (/^## /.test(line)) keep = wanted.some((w) => w.test(line));
    if (keep) out.push(line);
  }
  return out.join("\n").trim();
}

// 4naly3er blocks look like: ### <a name="M-1"></a>[M-1] Title ... File: src/X.sol \n\n 46: code
function botFindings(report: string): BotFinding[] {
  const out: BotFinding[] = [];
  const blocks = report.split(/^### <a name="/m).slice(1);
  for (const block of blocks) {
    const head = /^([LM]-\d+)"><\/a>\[[LM]-\d+\] (.+)$/m.exec(block);
    if (!head) continue;
    const instances: string[] = [];
    let file = "";
    for (const line of block.split("\n")) {
      const f = /^File: (\S+)/.exec(line);
      if (f) file = f[1];
      const l = /^(\d+):/.exec(line);
      if (l && file) instances.push(`${file}:${l[1]}`);
    }
    out.push({ id: head[1], title: head[2].trim(), instances });
  }
  return out;
}

export function loadPolicy(repoDir: string): Policy {
  const readme = readFileSync(join(repoDir, "README.md"), "utf8");
  const botPath = join(repoDir, "4naly3er-report.md");
  return {
    readmeSections: sections(readme, README_SECTIONS),
    botFindings: existsSync(botPath) ? botFindings(readFileSync(botPath, "utf8")) : [],
  };
}

export function renderPolicy(p: Policy, maxInstances = 6): string {
  const bot = p.botFindings
    .map((b) => {
      const shown = b.instances.slice(0, maxInstances).join(", ");
      const more = b.instances.length > maxInstances ? ` (+${b.instances.length - maxInstances} more)` : "";
      return `- [${b.id}] ${b.title}: ${shown}${more}`;
    })
    .join("\n");
  return `${p.readmeSections}\n\n## Bot report findings (publicly known, ineligible for awards)\n${bot}`;
}
