import karakSnapshot from "../data/karak/snapshot.json" with { type: "json" };
import karakFix31Snapshot from "../data/karak/snapshot-fix31.json" with { type: "json" };
import kleidiSnapshot from "../data/kleidi/snapshot.json" with { type: "json" };
import { loadScope, type Contest } from "./citations.ts";
import { loadPolicy, renderPolicy } from "./policy.ts";
import { SnapshotSource, type Snapshot } from "./source.ts";
import { KARAK_AUDITED, KARAK_FIX_31, KARAK_REPO, KLEIDI_ALIASES, KLEIDI_AUDITED, KLEIDI_REPO } from "./data/constants.ts";

interface ContestEntry {
  id: string;
  name: string;
  githubRepo: string;
  auditedCommit: string;
  snapshot: Snapshot;
  aliases?: Record<string, Record<string, string>>;
}

export const CONTESTS: ContestEntry[] = [
  {
    id: "karak",
    name: "Code4rena 2024-07 Karak Restaking (closed)",
    githubRepo: KARAK_REPO,
    auditedCommit: KARAK_AUDITED,
    snapshot: karakSnapshot as Snapshot,
  },
  {
    id: "karak-fix31",
    name: "Karak with the bug from finding #31 fixed (test fixture)",
    githubRepo: KARAK_REPO,
    auditedCommit: KARAK_FIX_31,
    snapshot: karakFix31Snapshot as Snapshot,
  },
  {
    id: "kleidi",
    name: "Code4rena 2024-10 Kleidi (closed, amendment-6 holdout)",
    githubRepo: KLEIDI_REPO,
    auditedCommit: KLEIDI_AUDITED,
    snapshot: kleidiSnapshot as Snapshot,
    aliases: KLEIDI_ALIASES,
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
      aliases: entry.aliases,
      auditedCommit: entry.auditedCommit,
      scope: loadScope(source, entry.auditedCommit),
    };
    loaded.set(id, { contest, policy: renderPolicy(loadPolicy(source, entry.auditedCommit)) });
  }
  return loaded.get(id)!;
}
