import { createHash } from "node:crypto";
import type { Precheck } from "./precheck.ts";

export interface Certificate {
  version: 1;
  contest: string;
  audited_commit: string;
  finding_sha256: string;
  verdict: string;
  agreement: string | null;
  route: "automatic" | "human";
  votes: { verdict: string; serv_request_id: string | null }[];
  decider: string | null;
  evidence_model: string | null;
  flags: string[];
  usd: number;
  issued_at: string;
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// Key order is fixed by construction so any client can rebuild the exact bytes and recompute the seal.
export const canonical = (c: Certificate) => JSON.stringify(c);

export function findingDigest(title: string, body: string): string {
  return sha256(`${title}\n\n${body}`);
}

export function issue(p: Precheck, contest: string, auditedCommit: string, title: string, body: string, route: Certificate["route"]) {
  const certificate: Certificate = {
    version: 1,
    contest,
    audited_commit: auditedCommit,
    finding_sha256: findingDigest(title, body),
    verdict: p.verdict,
    agreement: p.agreement,
    route,
    votes: p.votes.map((v) => ({ verdict: v.verdict, serv_request_id: v.judgment?.provider === "serv" ? v.judgment.requestId : null })),
    decider: p.decider ? `${p.decider.provider}/${p.decider.model}` : null,
    evidence_model: p.votes[0]?.evidence.model ?? null,
    flags: p.flags,
    usd: Number(p.usd.toFixed(6)),
    issued_at: new Date().toISOString(),
  };
  return { certificate, seal: sha256(canonical(certificate)) };
}
