# Architecture decision 0032: Public debugger command and debugger-capable profiles

Status: Accepted

## Context

The generic debugger stack is complete through schema-3 manifest v6 (ADRs
0026–0031): bound phase manifest, structured control protocol, bounded attempt
I/O, supervised adapter, complete-only envelopes and artifacts, and one
lease-owning schema-3 variant. Only the public entry point and user-facing
summary detail remained.

## Decision

Publish `fault-affinity debugger` for schema-3 manifest-v6 bundles. Fresh runs
require explicit workload selection, `--cpu`, `--max-runs`, `--max-captures`,
an explicitly resolved `--debugger` executable, `--out-dir`, and exactly one
of `--dry-run` or `--yes`; resumes require `--resume DIR` and `--yes`. The
command validates the requested CPU against the invoking process allowance,
forwards SIGINT/SIGTERM into the supervised attempt, maps a busy bundle lease
to exit 75, and stops with a clear nonzero result when an attempt is
operationally invalid — never advancing the prefix or retrying in place.

A dry run validates the full plan and creates nothing. A live run advances
committed debugger attempts until the manifest's run cap or capture cap.
Resume continues the exact committed prefix.

A custom workload's environment binding authority stays process-local: the
command derives it from the definition file bytes, passes it only to the
launch capsule path, and clears the caller-owned Buffer in a finally block.
It never appears in JSON, logs, arguments, bundle state, or summaries.

Two debugger-capable built-in profiles join the catalog without changing
existing built-in contracts: `node-pglite-debugger` for the historical finite
Node/PGlite trigger, and `wasm-churn-debugger` for the new finite reduced
WebAssembly churn trigger (`mini-wasm-finite.mjs`), which runs a bounded
number of rounds and terminates naturally — a no-fault run is a natural exit,
never a reinterpreted supervision deadline. Native churn remains outside the
debugger built-ins.

The read-only summary keeps schema version 1 and extends it additively: v6
bundles report per-run typed outcomes, captured signal/target/sections,
aggregate outcome counts, run and capture progress, and deterministic
relative artifact paths, all reconciled from the committed envelopes rather
than the progress counters alone. Older bundles render exactly as before.

## Consequences

- Debugger capture gains the same public-contract discipline as the earlier
  phase commands: explicit selection, explicit live confirmation, dry-run
  non-mutation, resumable complete-only state, and typed failure exits.
- The transcript-retention boundary is stated at help, inspect, plan, and
  guide surfaces: verbatim workload output can contain printed values.
- The finite reduced WebAssembly trigger is the only WebAssembly debugger
  built-in; the historical PGlite trigger remains optional and heavyweight.
- Summary consumers on version 1 see only additive keys for v6 bundles.
