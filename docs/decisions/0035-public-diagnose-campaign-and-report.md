# Architecture decision 0035: Publish the generic diagnose campaign and report

Status: Accepted

## Context

Schema-3 manifest version 7 binds baseline, CPU-group, pinned-concurrent,
exact-CPU, and controlled-load phases under one measured workload and one
condition workload. The generic phase commands and the `wasm-churn-aba` recipe
are precise but still require operators to assemble topology plans and advance
multiple commands. The historical `diagnose.sh` demonstrates the value of one
resumable sweep and one final report, but its planning, telemetry, and output
contracts are coupled to Node/PGlite and the original machine.

A public campaign needs safe defaults that are useful on both hybrid and
uniform Linux systems without pretending that topology inference identifies a
faulty CPU. It also needs statistics that retain each protocol's experimental
unit instead of pooling waves, children, exact attempts, and sequential A/B/A
legs.

## Decision

Publish `fault-affinity diagnose` as the manifest-v7 campaign owner.

With no workload selector, the command uses the recommended
`wasm-churn-diagnose` recipe: `wasm-churn-suite` as the measured workload,
`yes-load` as the condition, and the quick profile. Also publish
`node-pglite-diagnose` as the retained heavyweight equivalent. Recipe names
expand before manifest construction; the bundle binds resolved workload
digests and canonical phase schedules, not the mutable convenience name.

Every fresh command requires exactly one of `--dry-run` or `--yes`. Every live
resume requires `--yes`. Dry run resolves identities, reads topology, validates
the full plan and host allowance, and prints every context, count, target,
worker set, and output path without executing a workload or creating a bundle.

Automatic Linux planning:

- intersects online CPUs with the invoking process's allowed CPU list;
- accepts hybrid class masks only when their non-overlapping intersection
  exactly covers the usable CPU set;
- creates performance, efficient, and efficient-cluster group contexts when
  the kernel exposes them;
- uses topology cluster IDs or shared L2 masks for efficient clusters;
- uses one allowed controller outside each pinned active mask, partitioning a
  uniform all-CPU context when necessary;
- schedules every usable logical CPU in the exact phase;
- selects the highest usable CPU as the deterministic focused-load target and
  every other usable CPU as workers unless explicitly overridden; and
- uses seed 17 unless explicitly overridden.

The default target is convenience only. It is neither adaptive selection nor
an inference that the logical CPU is faulty. `--target-cpu` and `--load-cpus`
bind known or reviewed choices. A bounded campaign plan file remains available
for a fully explicit topology.

Publish quick, standard, and full profiles. They expand only into the same
canonical phase-plan boundary. The dry run reports actual topology-dependent
attempt and wave totals before a live decision.

Live orchestration advances baseline, groups, pinned-concurrent, exact, then
controlled load. Each phase retains its existing all-or-nothing record unit,
exclusive bundle lease, bounded cleanup, and exact-prefix resume semantics.
Resume reopens the immutable v7 bundle with both resolved workload identities;
it does not rediscover or replace topology.

After all five phases are complete, derive campaign report version 1. Report
target outcomes are `target-fault` and `corruption`. Passes plus target outcomes
form the resolved rate denominator; all other valid workload failures remain a
separate count. A correlated wave is a target wave if any child has a target
outcome, a pass wave only if every child passes, and otherwise an unresolved
other wave. Report wave and child views separately.

Report Wilson 95% intervals, the exact 95% upper bound for zero observed target
outcomes, and one-sided Fisher exact comparisons for loaded B versus A1 and B
versus A2. A replicated load association requires both comparisons to be in
the greater direction with `p < 0.05`; the report explicitly retains
sequential-session and causal limitations.

Publish deterministic `report.json`, then `report.md`, then
`report.complete.json`. The last file binds the immutable manifest and the
exact bytes of both derived artifacts. No-clobber publication is idempotent for
identical bytes and refuses conflicts. These three root names are accepted only
for manifest v7; versions 1 through 6 continue to reject them as foreign files.
Phase evidence remains authoritative.

Publish a read-only `fault-affinity report` command. It re-resolves both
workload identities, authoritatively rereads the v7 bundle, derives the report,
and, when the campaign is complete, reconciles the published artifacts. It
does not start a workload or mutate the bundle.

Automated integration uses temporary topology trees and harmless finite custom
workloads only. Built-in campaign paths stop at identity resolution and dry
run.

## Consequences

- One short default command plans the recommended reduced campaign, while
  `--yes` remains an explicit boundary for every live run.
- Operators can repeat the historical topology experiment through the same
  generic v7 protocol without making PGlite the project identity.
- Automatic planning is deterministic and reviewable but cannot choose a
  likely faulty CPU from data it has not yet collected.
- Completed campaigns have a bound, reproducible human and machine report
  without elevating derived output to evidence authority.
- Version 7 applies auxiliary load only to the focused B leg. Loaded topology
  sweeps, generic telemetry, frequency control, debugger composition, and
  privacy-review inventory remain separate protocols or future manifest work.
