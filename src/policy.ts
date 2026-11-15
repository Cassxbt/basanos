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

export const POLICY_MAX_CHARS = 72_000;
export const DOCUMENT_MAX_CHARS = 12_000;
export const POLICY_INCOMPLETE = "[POLICY INCOMPLETE";

// Documents that can decide whether a finding is excluded are never shortened.
const PRIORITY = /known|issue|trust|scope|edge|invariant|requirement|security|threat|acl|role/i;

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

export interface Coverage {
  path: string;
  priority: boolean;
  chars: number;
  included: number;
}

// README and bot findings first, then priority documents whole, then the rest, each shortened to a fixed share.
export function budgetPolicy(p: Policy, maxInstances = 6): { text: string; coverage: Coverage[] } {
  const bot = p.botFindings
    .map((b) => {
      const shown = b.instances.slice(0, maxInstances).join(", ");
      const more = b.instances.length > maxInstances ? ` (+${b.instances.length - maxInstances} more)` : "";
      return `- [${b.id}] ${b.title}: ${shown}${more}`;
    })
    .join("\n");
  const parts = [`## README.md\n${p.readme}`, `## Bot report findings (publicly known, ineligible for awards)\n${bot}`];
  let used = parts.join("\n\n").length;
  const coverage: Coverage[] = [];
  const priority = p.documents.filter((d) => PRIORITY.test(d.path.split("/").pop()!));
  const rest = p.documents.filter((d) => !priority.includes(d));
  for (const d of [...priority, ...rest]) {
    const isPriority = priority.includes(d);
    const room = POLICY_MAX_CHARS - used - d.path.length - 8;
    const wanted = isPriority ? d.text.length : Math.min(d.text.length, DOCUMENT_MAX_CHARS);
    const take = Math.max(0, Math.min(wanted, room));
    coverage.push({ path: d.path, priority: isPriority, chars: d.text.length, included: take });
    if (!take) continue;
    const cut = take < d.text.length ? `\n[shortened to ${take} of ${d.text.length} characters]` : "";
    parts.push(`## ${d.path}\n${d.text.slice(0, take)}${cut}`);
    used += parts[parts.length - 1].length + 2;
  }
  const missing = coverage.filter((c) => c.priority && c.included < c.chars).map((c) => c.path);
  if (missing.length) parts.push(`${POLICY_INCOMPLETE}: ${missing.join(", ")} could not be included whole]`);
  return { text: parts.join("\n\n"), coverage };
}

export const renderPolicy = (p: Policy, maxInstances = 6) => budgetPolicy(p, maxInstances).text;

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

// An exclusion is grounded when its clause is a verbatim quote from the policy bundle or names a bot-report finding in it.
export function groundedClause(clause: string, policy: string): boolean {
  const c = clause.trim().replace(/^\[|\]$/g, "");
  if (/^[LM]-\d+$/.test(c)) return policy.includes(`[${c}]`);
  const quote = squash(clause).replace(/^["'“”]+|["'“”]+$/g, "");
  return quote.length >= 20 && squash(policy).includes(quote);
}
