# Basanos

**A finding that cites the wrong line, repeats a known issue, or skips the proof costs the hunter the payout and the judge an hour.**

Basanos checks an audit-contest finding against the audited code before it is submitted. It returns one verdict and the exact evidence a judge would still need. It never submits anything.

> *βάσανος*: the touchstone. Assayers rubbed gold on a black stone and read the streak.

Live: **[basanos-nu.vercel.app](https://basanos-nu.vercel.app)** · Judge path: [`/judges`](https://basanos-nu.vercel.app/judges/) · Proof: [`/proof`](https://basanos-nu.vercel.app/proof/) · Every number below: `npm run verify` · SERV Hackathon 02, **Dolphin track**

## The Touchstone Pass

```
finding ──► 1. code       every GitHub link resolved at its commit and compared with the audited commit;
                          fake lines, missing files, unrelated spans, out-of-scope files stop here (no model call, $0)
        ──► 2. Dolphin    DeepSeek-V4.1-Flash reads the entire in-scope source plus the contest's known issues
                          and writes an evidence record (~43k tokens, ~$0.0005), three independent times
        ──► 3. SERV       one bounded decision per pass, Prompt Guard on the untrusted finding text,
                          then code caps the decision against the evidence record
        ──► consensus     all three agree → route automatically; otherwise → a human
```

**Verdicts**

| Verdict | Meaning |
|---|---|
| `READY` | The code supports the claim, the path is reachable, the impact is shown, and it is not a known issue. |
| `NEEDS_PROOF` | Plausible. The verdict lists exactly what is missing. |
| `BLOCKED_BY_CODE` | The audited code prevents the claimed path. The verdict names the line. |
| `KNOWN_OR_OUT_OF_SCOPE` | A bot-report or README known issue, a trusted-role precondition, or out-of-scope code. |
| `CITATION_BROKEN` | No link points at audited code that the finding actually discusses. |
| `GUARD_HELD` | SERV Prompt Guard held the text. This goes to a human; it is not a rejection. |

**Code has the last word.** `src/caps.ts` downgrades `READY` when the evidence record shows any of:
- the claim is only partly supported;
- the code blocks the path;
- it matches a known issue;
- a trusted role is required;
- there is no proof of concept.

The caps are tested in `test/caps.test.ts`.

## Judge path (90 seconds)

1. Open [`/judges`](https://basanos-nu.vercel.app/judges/) and press **Run all four attacks**. Each card shows the expected result first, then the live one.
   - Fabricated lines: `CITATION_BROKEN`, $0.
   - A known issue: `KNOWN_OR_OUT_OF_SCOPE`, with M-1 named.
   - An injection: sent to a human.
   - A fixed bug: `BLOCKED_BY_CODE`, pointing at the fix line.
2. Open [`/proof`](https://basanos-nu.vercel.app/proof/). Your browser recomputes every claim from the committed rows. Press **Tamper with the data** and the affected claims turn red.
3. On the [home page](https://basanos-nu.vercel.app/#check), run any example and press **Tamper with it** on the Assay Certificate. The seal breaks.
4. Locally, `npm run verify` recomputes every published number and exits 1 on any mismatch.

Local, with your own keys:

```bash
npm ci
cp .env.example .env            # SERV_API_KEY, DOLPHIN_API_KEY (REPPO_API_KEY only for the audit)
npm test                        # 23 tests, no keys or network needed
npm run verify                  # recompute published numbers from data/runs
npx tsx src/cli.ts finding.md --contest karak
```

**MCP**, for an agent that hunts bugs. Add this to Claude Code or Cursor:

```json
{ "mcpServers": { "basanos": { "command": "npx", "args": ["tsx", "/path/to/basanos/src/mcp.ts"],
  "env": { "SERV_API_KEY": "…", "DOLPHIN_API_KEY": "…" } } } }
```

The agent calls `basanos_precheck` with the finding before it submits.

## What we measured

One closed Code4rena contest, [2024-07 Karak](https://github.com/code-423n4/2024-07-karak-findings), audited commit `f5e52fd`.

- **Findings:** 94 submitted as High or Medium, in 47 duplicate families.
- **Labels:** 32 were awarded as High or Medium. Labels are contest outcomes, not ground truth about bugs.
- **Method:** the plan was committed before the full runs, with four dated amendments: [EVAL.md](EVAL.md).
- **Source of every number:** [`data/claims.json`](data/claims.json), checked by `npm run verify`. The live [`/proof`](https://basanos-nu.vercel.app/proof/) page recomputes the same numbers in your browser.

### It reads the code (bug/fix pairs)

- **Setup:** each of the 9 awarded findings was rerun against a branch where its bug is fixed. The fixes compile, and each one fails a reproducing test before the fix and passes after.
- **Citations withheld:** the citation check was hidden, so only reading the source could reveal the fix.
- **Contamination:** a model recalling the 2024 outcome would keep calling these findings valid.

| | Original code | Patched code |
|---|---|---|
| Verdict `BLOCKED_BY_CODE`, SERV decides | 1 / 18 | **10 / 18** |
| Verdict `BLOCKED_BY_CODE`, Dolphin decides | 2 / 18 | **10 / 18** |
| The blocking code named is in a file the fix changed | n/a | **10 / 10** |

Small n. The live `/judges` page reruns one pair, #31, on demand.

### Hostile text: we found the hole, then closed it

- **Before the defenses** (known payloads, undefended): injected findings reached `READY` 7/60 times with SERV deciding and 11/60 with Dolphin deciding. The cause was a poisoned evidence step.
- **The defenses:**
  1. A SERV Prompt Guard front door on the raw finding.
  2. A code-verified proof claim.
  3. A code scan for text addressed to the pipeline.

  They were committed before an independent agent wrote six blind attacks.
- **After** (blind payloads, defended):
  - Injected findings reached `READY` 0/60 times with SERV deciding and 1/60 with Dolphin deciding.
  - Automatic routing of a `READY` happened **0/60** times.
  - The scan flagged 30/60. The SERV front door held 1.
  - Most of the hardening is code.
- **On clean findings:** the defenses held or flagged 0/94.

### It does not predict contest outcomes better than length (null)

| Shipped pipeline, AUROC vs `awarded` (95% CI, clustered by family) | |
|---|---|
| Report length (baseline) | 0.661 [0.527, 0.786] |
| Three passes, SERV decides | 0.711 [0.607, 0.829] |
| Three passes, Dolphin decides | 0.757 [0.598, 0.871] |

The intervals overlap, so the output is a missing-evidence checklist, not a score. Unanimous zero-score verdicts route automatically. Of those automatic rejects, the contest judge also rejected 15/17 (SERV deciding) and 22/25 (Dolphin deciding).

### A second evaluator was audited too (null)

- **Setup:** 20 SERV verdicts were sent to Reppo's Eval API.
- **Result:** Reppo's panel accepted 20/20, including every verdict the contest judge contradicted.
- **Reading:** as an auditor of this decision, it does not discriminate.

### Cost

About **$0.0032 per three-pass check**: a SERV screen, three Dolphin reads and three SERV decisions. These are list prices from the token counts, not an invoice.

## Sponsor integration

| Sponsor | Role in the critical path | If it disappears |
|---|---|---|
| **Dolphin** (`lighthouse.dphn.ai`, DeepSeek-V4.1-Flash) | Reads the entire in-scope source three times per check and writes the evidence record that the caps enforce. | The full read moves to a paid frontier model at about 13× (SERV `gpt-6-luna`) to 100× (`gpt-5.4-mini`) the input price, and three passes per check stop being cheap. |
| **SERV Reasoning** (`gpt-6-luna` + `serv_prompt_guard`) | Makes the single bounded decision, screens the untrusted finding text, and returns a request id for every pass. | No guard on hostile text, no per-decision receipt. Measured: no accuracy gain over Dolphin deciding. |
| **Reppo Eval API** | Independent audit of a verdict sample (`src/eval/reppo-audit.ts`). | Nothing in the product path depends on it. The audit result was a null. Reppo publishes submissions, so it is only ever used on public, closed-contest findings. |

## What is real

| Piece | State |
|---|---|
| Citation resolution, `UNRELATED` check, caps, consensus | Real, deterministic, tested. |
| Dolphin and SERV calls | Real API calls. Every run row stores the SERV request id. Request ids are visible only in the OpenServ console. |
| Contest coverage | Karak only, from a committed snapshot. Other contests need a snapshot (`npm run snapshot`). |
| Live contests | Not supported. Basanos is shown on a closed contest, and the product never posts anything back to a contest. |
| Duplicate detection | Not in the pre-submit path, because a hunter cannot see other hunters' reports. |
| Customers | None yet. Revenue path: contest platforms and bug-bounty programs triaging intake, and hunters paying per check. |
| Bug fixes for the pair test | Written by an agent, compiled, and reproducing-test verified. They are not the sponsor's actual fixes, which live in a private repository. |

## Layout

```
src/citations.ts   link parsing, resolution, UNRELATED check
src/evidence.ts    Dolphin full-source evidence record
src/verdict.ts     SERV bounded decision + Prompt Guard
src/caps.ts        code caps over the decision
src/precheck.ts    three-pass consensus and routing
src/cli.ts src/mcp.ts src/web/   the three surfaces
src/eval/          runs, scoring, pairs, hostile sets, Reppo audit, claims check
data/karak/        reports, labels, snapshot, fixes manifest
data/runs/         every model output used in this README
EVAL.md            evaluation plan and amendments
```

MIT licensed. Built by [@cassxbt](https://x.com/cassxbt) for SERV Hackathon 02 (OpenServ), Dolphin track.
