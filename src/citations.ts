import type { CodeSource } from "./source.ts";

export type CitationStatus =
  | "OK"
  | "MOVED"
  | "CHANGED"
  | "BAD_LINES"
  | "NO_FILE"
  | "NO_COMMIT"
  | "OUT_OF_SCOPE";

export interface Citation {
  url: string;
  ref: string;
  commit: string;
  path: string;
  start: number;
  end: number;
}

export interface ResolvedCitation extends Citation {
  status: CitationStatus;
  auditedStart?: number;
  auditedEnd?: number;
}

export interface Contest {
  source: CodeSource;
  githubRepo: string;
  auditedCommit: string;
  scope: Set<string>;
}

const LINK = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/blob\/([0-9a-fA-F]{7,40}|main|master)\/([^\s#?)\]]+)(?:\?[^\s#)\]]*)?#L(\d+)(?:C\d+)?(?:-L(\d+)(?:C\d+)?)?/g;

const isBranch = (ref: string) => ref === "main" || ref === "master";

// A branch link has no fixed revision; during a contest the default branch is the audited commit.
export function parseCitations(body: string, githubRepo: string, auditedCommit: string): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const m of body.matchAll(LINK)) {
    if (m[1].toLowerCase() !== githubRepo.toLowerCase()) continue;
    const start = Number(m[4]);
    const end = m[5] ? Number(m[5]) : start;
    const key = `${m[2]}:${m[3]}:${start}:${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const ref = m[2];
    const commit = isBranch(ref) ? auditedCommit : ref.toLowerCase();
    out.push({ url: m[0], ref, commit, path: decodeURIComponent(m[3]), start, end });
  }
  return out;
}

const normalize = (lines: string[]) => lines.map((l) => l.trim()).join("\n");

const TRIVIAL = /^[\s{}();]*$/;

// Only a unique, non-trivial match counts as the same code; a lone "}" matches everywhere.
function locate(haystack: string[], needle: string[]): number {
  const target = normalize(needle);
  if (TRIVIAL.test(target)) return -1;
  let found = -1;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (normalize(haystack.slice(i, i + needle.length)) !== target) continue;
    if (found !== -1) return -1;
    found = i + 1;
  }
  return found;
}

export function resolveCitation(c: Citation, contest: Contest): ResolvedCitation {
  if (!contest.scope.has(c.path)) return { ...c, status: "OUT_OF_SCOPE" };
  if (!contest.source.hasCommit(c.commit)) return { ...c, status: "NO_COMMIT" };

  const cited = contest.source.read(c.commit, c.path);
  if (!cited) return { ...c, status: "NO_FILE" };
  if (c.start < 1 || c.end < c.start || c.end > cited.length) return { ...c, status: "BAD_LINES" };

  const audited = contest.source.read(contest.auditedCommit, c.path);
  if (!audited) return { ...c, status: "NO_FILE" };

  const snippet = cited.slice(c.start - 1, c.end);
  const span = c.end - c.start;
  if (normalize(audited.slice(c.start - 1, c.end)) === normalize(snippet)) {
    return { ...c, status: "OK", auditedStart: c.start, auditedEnd: c.end };
  }
  const at = locate(audited, snippet);
  if (at > 0) return { ...c, status: "MOVED", auditedStart: at, auditedEnd: at + span };
  return { ...c, status: "CHANGED" };
}

export function loadScope(source: CodeSource, commit: string): Set<string> {
  const lines = source.read(commit, "scope.txt") ?? [];
  return new Set(lines.map((l) => l.trim()).filter(Boolean));
}

export function auditedSnippet(c: ResolvedCitation, contest: Contest, context = 0): string | null {
  if (c.auditedStart === undefined || c.auditedEnd === undefined) return null;
  const lines = contest.source.read(contest.auditedCommit, c.path);
  if (!lines) return null;
  const from = Math.max(1, c.auditedStart - context);
  const to = Math.min(lines.length, c.auditedEnd + context);
  return lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(4)}  ${l}`)
    .join("\n");
}
