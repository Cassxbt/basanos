import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadScope, type Contest } from "./citations.ts";
import { loadPolicy, renderPolicy } from "./policy.ts";
import { SnapshotSource, type Snapshot } from "./source.ts";

interface ContestEntry {
  id: string;
  name: string;
  githubRepo: string;
  auditedCommit: string;
  snapshot: string;
}

export const CONTESTS: ContestEntry[] = [
  {
    id: "karak",
    name: "Code4rena 2024-07 Karak Restaking (closed)",
    githubRepo: "code-423n4/2024-07-karak",
    auditedCommit: "f5e52fdcb4c20c4318d532a9f08f7876e9afb321",
    snapshot: "data/karak/snapshot.json",
  },
];

const loaded = new Map<string, { contest: Contest; policy: string }>();

export function loadContest(id: string): { contest: Contest; policy: string } {
  const entry = CONTESTS.find((c) => c.id === id);
  if (!entry) throw new Error(`unknown contest "${id}"; known: ${CONTESTS.map((c) => c.id).join(", ")}`);
  if (!loaded.has(id)) {
    const path = fileURLToPath(new URL(`../${entry.snapshot}`, import.meta.url));
    const source = new SnapshotSource(JSON.parse(readFileSync(path, "utf8")) as Snapshot);
    const contest: Contest = {
      source,
      githubRepo: entry.githubRepo,
      auditedCommit: entry.auditedCommit,
      scope: loadScope(source, entry.auditedCommit),
    };
    loaded.set(id, { contest, policy: renderPolicy(loadPolicy(source, entry.auditedCommit)) });
  }
  return loaded.get(id)!;
}
