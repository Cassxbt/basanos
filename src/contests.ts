import karakSnapshot from "../data/karak/snapshot.json" with { type: "json" };
import { loadScope, type Contest } from "./citations.ts";
import { loadPolicy, renderPolicy } from "./policy.ts";
import { SnapshotSource, type Snapshot } from "./source.ts";
import { KARAK_AUDITED, KARAK_REPO } from "./data/constants.ts";

interface ContestEntry {
  id: string;
  name: string;
  githubRepo: string;
  auditedCommit: string;
  snapshot: Snapshot;
}

export const CONTESTS: ContestEntry[] = [
  {
    id: "karak",
    name: "Code4rena 2024-07 Karak Restaking (closed)",
    githubRepo: KARAK_REPO,
    auditedCommit: KARAK_AUDITED,
    snapshot: karakSnapshot as Snapshot,
  },
];

const loaded = new Map<string, { contest: Contest; policy: string }>();

export function loadContest(id: string): { contest: Contest; policy: string } {
  const entry = CONTESTS.find((c) => c.id === id);
  if (!entry) throw new Error(`unknown contest "${id}"; known: ${CONTESTS.map((c) => c.id).join(", ")}`);
  if (!loaded.has(id)) {
    const source = new SnapshotSource(entry.snapshot);
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
