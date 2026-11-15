import { test } from "node:test";
import assert from "node:assert/strict";
import { loadContest } from "../src/contests.ts";
import { precheck } from "../src/precheck.ts";
import { route } from "../src/format.ts";
import { configureClients } from "../src/llm.ts";

// Reproduces the partner review's probe: models that claim READY over contradictory evidence.
const body = [
  "Vault.deposit forwards assets before checking balances.",
  "https://github.com/code-423n4/2024-07-karak/blob/main/src/Vault.sol#L78-L88",
  "The actual exploit is at https://github.com/code-423n4/2024-07-karak/blob/main/src/Vault.sol#L99999",
  "```solidity",
  "function testExploit() public {}",
  "```",
].join("\n");

function mockProviders(evidence: Record<string, unknown>, judgment: Record<string, unknown>) {
  process.env.SERV_API_KEY = "offline";
  process.env.DOLPHIN_API_KEY = "offline";
  configureClients({ timeout: 5000, maxRetries: 0 });
  globalThis.fetch = (async (_: unknown, init: RequestInit) => {
    const name = JSON.parse(String(init.body)).response_format.json_schema.name;
    const value = name === "screen" ? { files: [] } : name === "evidence" ? evidence : judgment;
    return new Response(
      JSON.stringify({ id: "mock", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

const lyingEvidence = {
  claim: "unsupported", root_cause_file: "missing.sol", root_cause_line: 999999, code_supports_claim: "yes",
  support_reason: "because", blocking_code: [], poc: "runnable_test", impact: "funds_loss", preconditions: [],
  trusted_role_required: false, known_issue_match: "",
  missing_evidence: [{ item: "No reproduction of the exploit", category: "required", obligation: 5, why: "w", resolves_when: "r" }],
};

test("contradictory READY claims never become READY or route automatically", async () => {
  mockProviders(lyingEvidence, {
    verdict: "READY", severity_supported: "high", reason: "ready",
    missing: [{ item: "No reproduction of the exploit", category: "required", obligation: 5, why: "w", resolves_when: "r", evidence_ref: "E1" }],
    exclusion: { clause: "", actor: "", conditions: "", why_within: "" },
  });
  const { contest, policy } = loadContest("karak");
  const p = await precheck({ title: "deposit", body }, contest, policy);
  assert.notEqual(p.verdict, "READY");
  assert.equal(route(p), "human");
  assert.match(p.votes[0].caps.join(" "), /not in the audited source/);
  assert.equal(p.votes[0].evidence.value.poc, "narrative_only");
});

test("model output outside the schema is rejected, not cast", async () => {
  mockProviders({ ...lyingEvidence, code_supports_claim: "absolutely" }, { verdict: "READY", severity_supported: "high", missing: [], reason: "r" });
  const { contest, policy } = loadContest("karak");
  await assert.rejects(precheck({ title: "deposit", body }, contest, policy), /outside the schema/);
});
