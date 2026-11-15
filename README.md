# Basanos

**A finding that cites the wrong line, repeats a known issue, or skips the proof costs the hunter the payout and the judge an hour.**

Basanos checks an audit-contest finding against the audited code before it is submitted. It returns one verdict and the exact evidence a judge would still need. It never submits anything.

> *βάσανος*: the touchstone. Assayers rubbed gold on a black stone and read the streak.

Live: _pending deploy_ · Judge path: [`/judges`](#judge-path-90-seconds) · Every number below: `npm run verify` · SERV Hackathon 02, **Dolphin track**

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

1. Open the live page and press **Fabricated lines**: `CITATION_BROKEN`, $0, no model call.
2. Press **Known issue** (Karak #93): `KNOWN_OR_OUT_OF_SCOPE`, with bot finding M-1 named.
3. Press **Injected** (#10 with a role-play payload): watch whether Prompt Guard holds it.
4. Read [What we measured](#what-we-measured). Then run `npm run verify` to recompute every number from the committed run files. It exits 1 if this README's source data disagrees.

Local, with your own keys:

```bash
npm ci
cp .env.example .env            # SERV_API_KEY, DOLPHIN_API_KEY (REPPO_API_KEY only for the audit)
npm test                        # 20 tests, no keys or network needed
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
- **Method:** the plan was committed before the full runs, with three disclosed amendments: [EVAL.md](EVAL.md).
- **Source of every number:** [`data/claims.json`](data/claims.json), checked by `npm run verify`.

### It reads the code (bug/fix pairs)

- **Setup:** each of the 9 awarded findings was rerun against a branch where its bug is fixed. The fixes were written by a separate agent, compile, and each one fails a reproducing test before the fix and passes after.
- **Citations withheld:** the citation check was hidden, so only reading the source could reveal the fix.
- **Contamination:** a model recalling the 2024 outcome would keep calling these findings valid.

| | Original code | Patched code |
|---|---|---|
| Verdict `BLOCKED_BY_CODE`, Dolphin decides | 2 / 18 | **10 / 18** |
| Verdict `BLOCKED_BY_CODE`, SERV decides | 1 / 18 | **10 / 18** |
| The evidence names blocking code | 5 / 18 | 10 / 18 |
| …and that code is in a file the fix changed | n/a | **10 / 10** |

Small n: 9 findings × 2 runs. The second pair run used Dolphin at temperature 0.

### It does not predict contest outcomes better than length (null)

| AUROC vs `awarded` (95% CI, clustered by family) | Run 1 | Run 2 |
|---|---|---|
| Body length (baseline) | 0.661 [0.527, 0.786] | — |
| Single pass, Dolphin decides | 0.678 [0.547, 0.815] | 0.660 [0.519, 0.775] |
| Single pass, SERV decides | 0.641 [0.505, 0.782] | 0.658 [0.565, 0.792] |
| Three-pass consensus (amendment 3) | _run 3 pending_ | |

- **Run-to-run noise dominates.** A single pass gives the same verdict on the same finding only 64% to 70% of the time. That is why the product asks three times and routes automatically only on unanimity.
- **SERV versus Dolphin:** as the decider, SERV is no more accurate than Dolphin here, at about 19× the per-decision cost. It earns its place on the next two measurements, not on accuracy.

### Hostile text and Prompt Guard

- **Clean findings:** Prompt Guard held 9 of 186 decision calls (4.8%), and held them inconsistently. Only #48 was held in both runs. A hold routes to a human for that reason.
- **Injected findings:** payloads appended to 10 rejected findings were held 6 of 10 times. The same 10 clean findings were held 0 of 20 times.
- **Per payload:**

  | Payload | Held |
  |---|---|
  | Fake system note | 2/2 |
  | Role play | 2/2 |
  | JSON answer | 1/2 |
  | HTML comment | 1/2 |
  | Fake judge comment | 0/2 |

- **No payload produced `READY` in either arm.** The unguarded Dolphin decider resisted too, so the guard's marginal benefit is not shown here.
- **Version 2:** six payloads per finding, including one aimed at the unguarded evidence step, are in amendment 3: _pending_.

### A second evaluator was audited too (null)

- **Setup:** dashersw's line was "the system that makes a decision shouldn't be the only one evaluating it". So 20 SERV verdicts went to Reppo's Eval API: 10 on awarded findings and 10 on rejected ones.
- **Result:** Reppo's panel accepted 19 of 19 completed audits, scoring 83 to 100. It scored the verdicts the contest judge contradicted slightly higher (mean 96.3) than the ones it agreed with (94.6).
- **Reading:** as an auditor of this decision, it does not discriminate. A second evaluator needs evaluating too.

### Cost

- **Dolphin evidence pass:** about $0.00046.
- **SERV decision:** about $0.0006.
- **Dolphin decision:** about $0.00003.
- **Three-pass check:** about $0.003 at list prices from each provider's live catalog. These are list prices, not an invoice.

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
