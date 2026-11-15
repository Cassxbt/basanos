import { execFileSync } from "node:child_process";

export interface CodeSource {
  hasCommit(commit: string): boolean;
  read(commit: string, path: string): string[] | null;
}

export class GitSource implements CodeSource {
  private files = new Map<string, string[] | null>();
  private commits = new Map<string, boolean>();

  constructor(private repoDir: string) {}

  hasCommit(commit: string): boolean {
    if (!this.commits.has(commit)) {
      try {
        execFileSync("git", ["-C", this.repoDir, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
        this.commits.set(commit, true);
      } catch {
        this.commits.set(commit, false);
      }
    }
    return this.commits.get(commit)!;
  }

  read(commit: string, path: string): string[] | null {
    const key = `${commit}\0${path}`;
    if (!this.files.has(key)) {
      try {
        const text = execFileSync("git", ["-C", this.repoDir, "show", `${commit}:${path}`], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          maxBuffer: 64 * 1024 * 1024,
        });
        this.files.set(key, text.split("\n"));
      } catch {
        this.files.set(key, null);
      }
    }
    return this.files.get(key)!;
  }
}

export type Snapshot = Record<string, Record<string, string>>;

// Commits are keyed by full SHA; a short SHA from a report link matches by prefix.
export class SnapshotSource implements CodeSource {
  constructor(private snapshot: Snapshot) {}

  private full(commit: string): string | undefined {
    const c = commit.toLowerCase();
    return Object.keys(this.snapshot).find((k) => k.startsWith(c));
  }

  hasCommit(commit: string): boolean {
    return this.full(commit) !== undefined;
  }

  read(commit: string, path: string): string[] | null {
    const full = this.full(commit);
    const text = full ? this.snapshot[full][path] : undefined;
    return text === undefined ? null : text.split("\n");
  }
}

export function takeSnapshot(source: GitSource, commits: string[], paths: string[]): Snapshot {
  const out: Snapshot = {};
  for (const commit of commits) {
    out[commit] = {};
    for (const path of paths) {
      const lines = source.read(commit, path);
      if (lines) out[commit][path] = lines.join("\n");
    }
  }
  return out;
}
