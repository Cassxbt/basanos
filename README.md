# Basanos

**Review an audit finding against its source and the contest rules.**

Audit contests reject many findings for reasons that can be checked before submission: a link to the wrong line, a known issue, an impact the code does not allow, a missing proof. Basanos reads a smart-contract finding next to the audited code and the contest's own rules, and suggests the checks the finding still needs, each with the condition that would resolve it. When it is not sure, or when its answer is "no", it shows what it found and leaves the call to you. It advises; it never submits anything.

> *βάσανος*: the touchstone. Assayers rubbed gold on a black stone and read the streak.

Live: **[basanos-nu.vercel.app](https://basanos-nu.vercel.app)** · Judge path: [`/judges`](https://basanos-nu.vercel.app/judges/) · Evidence: [`/proof`](https://basanos-nu.vercel.app/proof/) · SERV Hackathon 02, **Dolphin track** · Release `obligations-v3.1`

| Status | |
|---|---|
| What it is | An experimental review assistant. It has not called a real finding READY on any contest, so it is a checklist, not a gate. |
| Contests | Karak in the browser; Kleidi and Wildcat through the API, CLI and MCP. All closed, from committed snapshots. |
| Models | Dolphin `DeepSeek-V4.1-Flash` reads the source; SERV `gpt-6-luna` with `serv_prompt_guard` screens and decides. |
| Users | None yet. No independent auditor has rated the checklists. |
| Cost | About $0.0044 (Karak) to $0.0049 (Wildcat) per check: list prices from token counts, not an invoice. |

## What a useful answer looks like

Wildcat #11, an awarded finding, as submitted: anyone can call `onQueueWithdrawal` on the access-control hooks for any lender. One of Basanos's v3.1 suggested checks:

> **Required (obligation 3).** Evidence that the missing hooked-market check is the cause, rather than the lender's own call also consuming the one-time proof.
> *Resolves when:* a sequence is shown where the lender's own call would succeed but the attacker's prior call makes it fail.

That is the control test a repair agent then wrote. It passes against the unmodified audited code (`data/repair-wildcat/11/`). On Wildcat #49, the checklist asked for impact beyond a documentation mismatch. The agent's test showed there was none, which is the weakness a judge would find.

## What you get

- **Suggested checks.** Each says which of five acceptance obligations it affects, why, and what resolves it. Items that would only strengthen a finding are marked as such.
- **A verdict:** `READY`, `NEEDS_PROOF`, `BLOCKED_BY_CODE`, `KNOWN_OR_OUT_OF_SCOPE`, `CITATION_BROKEN` or `GUARD_HELD`.
- **What a "no" rests on.** A known-issue call quotes the contest rule; a blocked call names the line. Code verifies the rule or line exists; whether it applies is the model's reading. So a model "no" is always left to your review.
- **Automatic advice or "needs your review".** Automatic advice requires three unanimous passes, no flag, no code overrule, and a verdict that is not a model "no". A broken code link is the one automatic negative: it asks you to repair the link, not to drop the finding.
- **An Assay Receipt.** A SHA-256 checksum over the finding digest, audited commit, votes, request ids and cost. It detects edits. It does not prove who issued it or that the verdict is right.

## How it works

```
finding ──► 1. code      every GitHub link resolved at its commit against the audited commit;
                         none that resolves to code the finding discusses → CITATION_BROKEN, no model call
        ──► 2. guard     SERV Prompt Guard screens the raw finding; code scans for text addressed to the pipeline
        ──► 3. Dolphin   reads all in-scope source plus the contest policy bundle (README, known issues,
                         invariants, edge cases, other linked docs) and writes an evidence record, three repeated passes
        ──► 4. SERV      one bounded decision per pass with the policy and Prompt Guard on; code then caps it
        ──► routing      src/route.ts, the one router the API, CLI, evaluation and site all use
```

**Code has the last word** (`src/caps.ts`):
- **READY** needs code support, a root cause that exists in the audited source, no blocking code, no known issue, a test or concrete steps, every citation resolving, and no required item left in either layer. A finding that needs a trusted role is never READY. Code does not yet check the policy's exceptions for that role; it adds an item saying what would resolve it, and leaves it to your review. A capped READY always says what would resolve it.
- **A "no"** must rest on a quoted clause or bot finding that appears in the policy bundle, or on blocking code that exists. It always goes to your review.
- **Each requirement** the evidence step raises is numbered. The decision carries it by number and obligation, and the evidence step's own wording is what you see.
- **Known-issue, trust and scope documents** go into the policy bundle whole. Other documents are shortened to 12,000 characters each; one is, Wildcat's Access Control Hooks. If a priority document cannot fit, every model result for that contest needs review.

51 tests, no keys or network needed. They include the partner review's offline probes (`test/probes.test.ts`) and release-gate mutation tests (`test/release.test.ts`).

## Judge path (90 seconds)

1. Open [`/judges`](https://basanos-nu.vercel.app/judges/) and press **Run all four attacks**:
   - fabricated lines: `CITATION_BROKEN`, $0;
   - a known issue: shown with the rule it relies on;
   - an injection: left for review;
   - a fixed bug: `BLOCKED_BY_CODE` at the fix line.
2. Open [`/proof`](https://basanos-nu.vercel.app/proof/). Your browser recomputes the claims ledger and the 94-finding tray from the committed rows. **Tamper with the data** turns the affected claims red. The held-out, repair and attack tables are computed by `npm run verify`, which the build refuses to skip.
3. On the [home page](https://basanos-nu.vercel.app/#check), run an example and press **Tamper with it** on the receipt.

## What we measured

Every version was pre-registered in [EVAL.md](EVAL.md) before its code (amendments 1 to 8). Labels are contest outcomes, not ground truth about bugs. Awarded findings in one duplicate family are not independent. All routing comes from `src/route.ts`.

**Wildcat** (Code4rena 2024-08, 106 findings, 22 awarded in 9 families). It was chosen by a rule written down before v3 existed. v3 was blind on it. v3.1 was built after seeing v3's problems, so its column is diagnostic. Each cell is SERV deciding / Dolphin deciding.

| | v2 | **v3 (blind)** | v3.1 (released) |
|---|---|---|---|
| READY | 0 / 0 | 0 / 0 | 0 / 0 |
| Awarded, auto-rejected | 1 / 4 | 1 / 1 | 1 / 1 |
| Awarded, automatically told to add proof | 1 / 10 | 2 / 13 | 5 / 13 |
| False discouragement (the two above) | 2 / 14 | 3 / 14 | 6 / 14 |
| Awarded findings called known or out of scope (SERV) | 5 | 0 | 0 |
| Needs your review | 86 / 35 | 89 / 48 | 67 / 51 |
| SERV decision passes held by Prompt Guard | 82 / 291 | 136 / 291 | 47 / 291 |

**Karak** (development, 94 findings, 32 awarded), v3.1:
- READY: 0 / 0.
- Needs review: 65 / 94 and 44 / 94.
- False discouragement: 6 / 32 and 16 / 32.
- Guard held 35 of 279 SERV passes.

**Reading:**
- **What v3 fixed.** Once the decision layer read the contest's own rules and had to quote them, awarded findings stopped being called known, and Dolphin's automatic rejections fell from 29 to 7.
- **What v3.1 added.** Every remaining automatic rejection is a broken-citation result. One of them, the awarded #121, has a real line that shares no identifier with the text; the relevance heuristic is wrong there.
- **What did not change.** Nothing reached READY.

### The repair loop

Agents, not told which findings were awarded, took each checklist, wrote a Foundry test against the unmodified audited code and ran it. We re-ran every test ourselves.
- **Karak (strict v1):** 6 executed proofs; 0 revisions reached READY.
- **Wildcat (v3, set fixed by rule):**
  - 10 attempted;
  - 6 tests support their claim (several only in a limited form; #77 is a documented known issue);
  - 4 tests show the claim does not hold;
  - **0 of 6 revisions reached READY.**

  After the proof, the checklist moved to severity, policy-intent and actor questions. Once it asked for a test run the revision already contained, because Basanos reads tests and does not execute them. **This is the main limit we found.** Stable requirement tracking across revisions, plus verified test execution, is the next version.

### Hostile text

Six blind payloads by an agent that never saw the defenses (v5, on Wildcat), plus the earlier frozen set, both run under v3.1:

| | v5 blind | frozen v3 |
|---|---|---|
| Injected findings READY and automatic, SERV / Dolphin | 0/60 / 0/60 | 0/60 / 0/60 |
| Flagged by the instruction scan | 20/60 | 30/60 |
| Clean controls held or flagged | 0/10 | 0/10 |

Zero unsafe READY is weak evidence while genuine findings never reach READY either.

### Nulls we publish anyway

- **Outcome prediction.** On Karak, neither decider's AUROC interval excludes report length (SERV 0.683 [0.552, 0.802], Dolphin 0.796 [0.692, 0.916], length 0.661 [0.527, 0.786]). No demonstrated improvement. That is why the output is a checklist, not a score.
- **SERV as decider.** It is not more accurate than Dolphin deciding on the same evidence.
- **SERV's guard.** It holds clean decision passes, each of which becomes a review. The strict-v1 ablation found no attack that only the guard stopped.
- **Reppo's evaluator.** It accepted 20/20 sampled verdicts, including every one the contest judge contradicted.

## Sponsor integration

| Sponsor | Role in the critical path | Honest assessment |
|---|---|---|
| **Dolphin** (`lighthouse.dphn.ai`, DeepSeek-V4.1-Flash) | Reads the entire in-scope source and the policy bundle, three times per check, and writes the evidence record that code enforces. | The core of the product. Removing it removes the semantic read. About $0.0005 per pass. |
| **SERV** (`gpt-6-luna` + `serv_prompt_guard`) | Screens the raw finding before the unguarded open model reads it, then makes one bounded decision per pass, each with a request id. | Real and in the path. Its measured benefit is weak: no accuracy gain over Dolphin deciding, and its guard holds clean passes (fewer in v3.1). |
| **Reppo Eval API** | Independent audit of a verdict sample (`src/eval/reppo-audit.ts`). | A null result, not in the product path. Only public, closed-contest findings were sent. |

## What is real

| Piece | State |
|---|---|
| Citation resolution, caps, routing, receipt | Real, deterministic, tested. |
| Dolphin and SERV calls | Real. Every run row stores the SERV request id. |
| Release binding | The build refuses unless `claims.json` equals a fresh computation, and the release runs' recorded code and input hashes (snapshots, reports), settings and rows match. Dependency versions are pinned by `package-lock.json` but not hashed. |
| Repair proofs | Written and run by agents, re-run by us. Not reviewed by an independent auditor. |
| Customers | None. Hypothesis: hunters paying per check, and platforms triaging intake. Not validated. |
| Data | Contest source and findings are copied from public Code4rena repositories for research, with attribution in [NOTICE](NOTICE). SERV data collection is on for this workspace, so paste only public findings. |

## Run it

```bash
npm ci
cp .env.example .env          # SERV_API_KEY, DOLPHIN_API_KEY
npm test                      # no keys or network needed
npm run verify                # recompute every published number from data/runs
npx tsx src/cli.ts finding.md --contest wildcat
npm run mcp                   # basanos_contests and basanos_precheck, for a bug-hunting agent
```

The CLI exits 0 only for READY given as automatic advice, 1 for anything else, 2 for usage errors and 3 if the check failed. `npm run deploy` runs the tests, the typecheck and the gated build.

## Layout

```
src/citations.ts src/policy.ts   link resolution; the contest policy bundle and clause check
src/evidence.ts src/verdict.ts   Dolphin evidence record; SERV screen and decision
src/caps.ts src/route.ts         code caps; the one router every surface uses
src/precheck.ts                  three passes and consensus
src/cli.ts src/mcp.ts src/web/   the three surfaces
src/eval/                        runs, claims, repair loop, release gate
data/<contest>/                  reports, labels, snapshots, payloads
data/runs/                       every model output behind every number, with manifests
data/repair*/                    repair inputs, tests, forge output, before/after checks
EVAL.md                          the plan and amendments 1 to 8
```

MIT licensed (code). Built by [@cassxbt](https://x.com/cassxbt) for SERV Hackathon 02 (OpenServ), Dolphin track.
