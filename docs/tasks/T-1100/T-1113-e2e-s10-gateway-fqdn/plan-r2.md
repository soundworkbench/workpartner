# T-1113 round 2 implementation plan

Spec: `r2.md` and the round-2 request. Preserve round-1 changes in this worktree.

- Add regression tests for optional `dnsNdots` (integer 1–15), unchanged default user/job DNS configuration, computed e2e dot counts, four lookup targets on both nodes, failed-Pod hostname diagnostics, and missing probe reasons. Run them before implementation.
- Validate the option during organization resolution, add its type, and conditionally add `ndots` in the shared user/job Pod builder. Leave defaults unset.
- Compute the e2e option from the gateway FQDN; expand S10 evidence and failure diagnostics; use the assertion reason fallback.
- Replace the operations note, document the new field, and clarify Service/port matching.
- Run the requested e2e, renderer and runtime unit suites plus organization validation tests. Record Node version, exact commands, output tails, changed files and hostname consumers in `report.md`.

Review focus: omitted options must stay absent; null/string/fractional/out-of-range values must fail; custom domains may have different dot counts; the failed Pod may be remote from the gateway; evidence must survive successful runs and lookup failures.

Constraints: no clusters, no entry hostPort changes, no policy timeout default changes, no private identifiers. Real DNS latency validation remains the coordinator's post-merge CI run.
