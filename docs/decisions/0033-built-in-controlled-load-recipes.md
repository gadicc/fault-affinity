# Architecture decision 0033: Add built-in controlled-load recipes

Status: Accepted

## Context

The manifest-v5 controlled-load command required a separate custom condition
workload file and plan file even for the repository's established reduced
experiment: `mini-wasm-churn.mjs` on one target CPU with one `/usr/bin/yes`
worker on each declared load CPU. That boundary was generic, but it made the
recommended path harder to discover and repeat than the historical scripts.

CPU topology cannot be inferred safely. A convenience path must therefore
keep target and load CPU selection explicit, preserve dry-run and `--yes`, and
expand into the existing immutable workload and schedule identities rather
than creating a weaker evidence format.

## Decision

Add `yes-load` as a built-in condition workload. It uses `/usr/bin/yes`,
discards both output streams in managed mode, declares `survive-window`
semantics, and has a one-hour outer safety deadline. The controlled-load
command accepts built-in conditions through `--condition-workload`; when a
generic measured workload and plan file omit the condition, `yes-load` is the
default.

Add a public `wasm-churn-aba` recipe. A fresh invocation still requires:

- `--target-cpu N`;
- `--load-cpus LIST` disjoint from the target;
- an output directory; and
- exactly one of `--dry-run` or `--yes`.

The recipe explicitly selects `wasm-churn` as the measured workload and
`yes-load` as the condition. Its defaults are ten attempts per A1/B/A2 leg,
no extra warm-up, a 15-second recovery interval, and a ten-round exact sibling
on the target CPU with seed 17. Bounded command-line options may override the
schedule without changing either workload identity.

Recipe selection is accepted on controlled-load resume, exact sibling resume,
and read-only summary. The recipe expands before manifest construction. The
authoritative v5 bundle continues to bind the resolved workload identities and
fully expanded schedules; it does not depend on a mutable recipe name at read
time and no schema version changes.

## Consequences

- The common reduced A1/B/A2 comparison no longer needs hand-written JSON.
- Existing custom condition files, explicit plan files, manifests, and bundles
  keep their meanings.
- Operators must still choose topology explicitly and confirm every live run.
- `yes-load` is appropriate for ordinary bounded sessions. A custom condition
  with a reviewed longer lifecycle remains available for unusually long B
  legs.
- The recipe catalog is a foundation for a later generic diagnose campaign;
  it does not yet combine topology screening, loaded comparisons, statistics,
  and a final report.

[ADR 0035](0035-public-diagnose-campaign-and-report.md) later fulfills that
campaign boundary through separate `wasm-churn-diagnose` and
`node-pglite-diagnose` recipes without changing this v5 decision.
