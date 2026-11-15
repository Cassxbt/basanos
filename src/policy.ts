import type { CodeSource } from "./source.ts";

export interface BotFinding {
  id: string;
  title: string;
  instances: string[];
}

export interface Policy {
  readme: string;
  documents: { path: string; text: string }[];
  botFindings: BotFinding[];
}

export const POLICY_MAX_CHARS = 40_000;

const NOT_POLICY = /running tests|coverage/i;

// Drops each section whose heading mentions tests or coverage, down to the next heading of the same or higher level.
function stripTestSections(markdown: string): string {
  const out: string[] = [];
  let skipLevel = 0;
  for (const line of markdown.split("\n")) {
    const h = /^(#{1,6}) (.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      if (skipLevel && level <= skipLevel) skipLevel = 0;
      if (!skipLevel && NOT_POLICY.test(h[2])) skipLevel = level;
    }
    if (!skipLevel) out.push(line);
  }
  return out.join("\n").trim();
}

// A policy document is any Markdown file in the audited commit whose file name the README mentions, in order of first mention.
function mentionedDocuments(readme: string, paths: string[]): string[] {
  const at = (path: string) => {
    const name = path.split("/").pop()!;
    const hits = [name, encodeURIComponent(name), name.replaceAll(" ", "%20")].map((n) => readme.indexOf(n)).filter((i) => i >= 0);
    return hits.length ? Math.min(...hits) : -1;
  };
  return paths
    .filter((p) => p !== "README.md" && !p.endsWith("4naly3er-report.md"))
    .map((p) => ({ p, i: at(p) }))
    .filter(({ i }) => i >= 0)
    .sort((a, b) => a.i - b.i || a.p.localeCompare(b.p))
    .map(({ p }) => p);
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

export function loadPolicy(source: CodeSource, commit: string): Policy {
  const readme = source.read(commit, "README.md")?.join("\n") ?? "";
  const bot = source.read(commit, "4naly3er-report.md")?.join("\n");
  return {
    readme: stripTestSections(readme),
    documents: mentionedDocuments(readme, source.markdown(commit)).map((path) => ({ path, text: source.read(commit, path)!.join("\n").trim() })),
    botFindings: bot ? botFindings(bot) : [],
  };
}

// README first, then the bot findings, then the documents, so a long document is what gets truncated.
export function renderPolicy(p: Policy, maxInstances = 6): string {
  const bot = p.botFindings
    .map((b) => {
      const shown = b.instances.slice(0, maxInstances).join(", ");
      const more = b.instances.length > maxInstances ? ` (+${b.instances.length - maxInstances} more)` : "";
      return `- [${b.id}] ${b.title}: ${shown}${more}`;
    })
    .join("\n");
  const full = [
    `## README.md\n${p.readme}`,
    `## Bot report findings (publicly known, ineligible for awards)\n${bot}`,
    ...p.documents.map((d) => `## ${d.path}\n${d.text}`),
  ].join("\n\n");
  if (full.length <= POLICY_MAX_CHARS) return full;
  return `${full.slice(0, POLICY_MAX_CHARS)}\n\n[POLICY TRUNCATED at ${POLICY_MAX_CHARS} of ${full.length} characters]`;
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// An exclusion is grounded when its clause is a verbatim quote from the policy bundle or names a bot-report finding in it.
export function groundedClause(clause: string, policy: string): boolean {
  const c = clause.trim().replace(/^\[|\]$/g, "");
  if (/^[LM]-\d+$/.test(c)) return policy.includes(`[${c}]`);
  const quote = squash(clause).replace(/^["'“”]+|["'“”]+$/g, "");
  return quote.length >= 20 && squash(policy).includes(quote);
}
