# Wildcat repair loop (amendment 7, obligations-v3)

The set was fixed by rule before any check. Of 12, the 10 returned NEEDS_PROOF with SERV deciding went to repair agents (Sonnet). The agents were not told which findings were awarded. We re-ran every final test ourselves in a clean clone of the audited commit (`fe746cc`, submodules at their pinned commits, `[lint] lint_on_build = false` added to foundry.toml as the only change). All pass, and `src/` and `lib/` are unchanged.

| # | Test result | Supports the finding's claim? | Revised | After (v3, SERV) |
|---|---|---|---|---|
| 11 | 6 pass | Yes, with limits (stateful short-TTL provider, delay past TTL) | yes | NEEDS_PROOF, needs review |
| 49 | 5 pass | No: shows no loss or DoS; workaround exists | set aside (`revised-not-supporting.md`) | not checked |
| 52 | 4 pass | Behaviour yes; impact is a bounded delay, no loss | yes | NEEDS_PROOF, needs review |
| 57 | 3 pass | Yes, with limits (borrower-appointed provider; borrower can already block) | yes | NEEDS_PROOF, unanimous, automatic advice |
| 60 | 1 pass | No: behaviour matches the docs, no loss | no | not checked |
| 62 | 4 pass | No: numbers reproduce, but the extra cost is interest owed, not an overcharge | no | not checked |
| 64 | 1 pass | Yes: last withdrawer's execution reverts on a few-wei shortfall | yes | NEEDS_PROOF, needs review |
| 77 | 2 pass | Yes for lost yield; the docs list slow 25% APR cuts as a known issue | yes | NEEDS_PROOF, needs review |
| 3 | 4 pass | Yes, limited to borrower-supplied config | yes | NEEDS_PROOF, needs review |
| 4 | 3 pass | No: the test disproves the claim | no | not checked |

None of the six revised findings reached READY. After the executed proofs, the checklists moved to severity, policy intent and actor-scope questions. One item asked for a "clean, reproducible test run" that the revision already contained, because Basanos does not execute tests. The obligations-v3 policy bundle for Wildcat did not include `docs/Known Issues.md` (see amendment 8). This is agent-in-the-loop evidence, not an independent auditor's review.
