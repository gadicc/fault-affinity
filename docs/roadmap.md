# Prioritize optional Fault Affinity work

Fault Affinity's version-one feature set is complete: trusted built-in and
custom workloads can run through bounded, resumable topology, exact-CPU,
controlled-load, debugger, summary, and report workflows. The items below are
optional extensions, not unfinished requirements for the current harness.

Use these relative scores when deciding whether new evidence or user demand
justifies another compatibility boundary:

- **Value 1–5** estimates the additional diagnostic or adoption value beyond
  the current clone-and-run project.
- **Difficulty 1–5** includes design, implementation, safe testing,
  compatibility, and operational risk. A 5 normally means a new privileged or
  lifecycle-sensitive protocol, not merely more code.

Scores are planning estimates, not commitments. Re-evaluate them against real
user reports before starting a milestone.

## Finish release housekeeping

| Candidate | Value | Difficulty | Recommendation |
| --- | ---: | ---: | --- |
| Correct stale current-state documentation | 4 | 1 | Complete before calling the current tree a release |
| Archive representative validated bundles outside the checkout | 4 | 1 | Do before replacing the affected hardware |
| Tag and publish source release notes | 3 | 1 | Sensible once documentation and the desired sample evidence are settled |

Generated diagnostic bundles should remain outside an npm tarball or source
release. A partial bundle can still contain valuable committed prefixes; it
does not need to be resumed or converted into a complete report to be retained.

## Evaluate distribution and guided operation

The accepted implementation sequence for the live-Ubuntu reference kit,
Windows screening ZIP, GitHub Pages bootstrap, result handoff, and automated
promotion releases is recorded in the
[distribution and release plan](distribution-and-release-plan.md). The scores
below remain useful for evaluating later expansion beyond that bounded plan.

| Candidate | Value | Difficulty | Recommendation |
| --- | ---: | ---: | --- |
| Repository-hosted AI operator skill | 4 | 2 | Best next usability experiment |
| npm package and `npx fault-affinity` | 3 | 3 | Pursue after an installed-layout spike proves demand and packaging boundaries |

Clone-and-run remains a good default. It keeps the executable, workload files,
legacy compatibility paths, documentation, case study, and exact source commit
together. It also makes the safety warning and dry-run workflow visible before
installation.

An npm release would add useful versioned installation, lockfile pinning, and
an `npx fault-affinity` entry point inside an existing project. Publication is
not just removing `private: true`, however. A release must:

- define an explicit `files` allowlist and exclude research, generated
  diagnostics, and development-only fixtures;
- prove that every runtime module, helper, built-in workload, and documentation
  link works from an installed tarball rather than a source checkout;
- decide whether the heavyweight PGlite dependency belongs in the default
  install or in a separately documented legacy path;
- add Linux, Node, repository, issue-tracker, and release metadata;
- test `npm pack`, clean temporary installation, command discovery, dry runs,
  summaries, and custom workload paths; and
- preserve explicit `--yes` confirmation and never make package installation
  imply permission to execute a live stress workload.

An AI operator skill does not need to wait for npm. It can live in the
repository, guide clone-based or packaged installations, and help users choose
a built-in, create a custom workload contract, inspect a dry run, preserve
environmental controls, summarize a bundle, and interpret denominators. Its
safety contract should be narrow:

- never add `--yes` or launch a live workload without an explicit request;
- lead with dry runs and identify memory, CPU, debugger, and reset risks;
- keep changed turbo, frequency, topology, or external-load conditions in
  separate bundles unless a manifest explicitly binds the comparison;
- treat custom workloads as trusted local code rather than sandboxed input;
- avoid privileged frequency changes by default; and
- distinguish observed affinity and statistical association from hardware
  causation.

The skill is therefore the lower-cost way to test whether guided adoption is
valuable. If users then want clone-free installation in existing projects,
that evidence would justify the npm packaging work.

## Consider new evidence protocols

| Candidate | Value | Difficulty | Recommendation |
| --- | ---: | ---: | --- |
| Debugger capture under verified controlled load | 5 | 4 | Highest-value new diagnostic protocol when load changes fault frequency |
| Loaded CPU-group and every-CPU sweeps | 4 | 4 | Add only when focused A/B/A cannot localize the load interaction |
| Workload-neutral telemetry association | 4 | 4 | Useful independent context layer; keep it separate from outcome evidence |
| Generic privileged frequency controls | 4 | 5 | Later milestone requiring recovery guarantees equal to the legacy path |
| Cgroup-backed descendant supervision | 3 | 5 | Demand-driven expansion beyond the trusted process-group boundary |
| Generalized historical Node warmup and multi-workload matrices | 2 | 4 | Retain as legacy experiments unless another workload needs the design |

### Capture a fault under verified load

The current manifest-v6 debugger variant has no controlled-load condition, and
manifest v7 applies its condition only to the focused B leg. A combined
debugger protocol could preserve verified worker readiness while capturing the
fault signature on one isolated target CPU. It would need a new manifest
version, one lease across condition readiness, debugger execution, complete
artifact publication, and bounded cleanup, plus report fields that distinguish
capture outcomes from condition failures.

This is high value for intermittent faults whose rate changes under package
load. It should not be added as optional fields to v6 or v7, and its tests must
continue to use harmless finite fixtures rather than real GDB or stress
workloads.

### Sweep topology while loaded

A loaded group or every-CPU sweep could show whether the condition changes
which contexts or logical CPUs reproduce. The design must pre-bind condition
placement, measured placement, overlap policy, order, recovery periods, and
separate denominators. Running load during every topology phase is expensive
and can obscure rather than clarify attribution, so focused A/B/A remains the
default.

### Associate workload-neutral telemetry

Generic frequency, temperature, throttling, and power observations need an
association contract that binds sampler readiness, liveness, timestamps, and
workload generations. Missing or dead required sampling must fail closed rather
than appearing as an ordinary absent value. Telemetry should remain contextual
evidence and must not silently change workload outcome classification.

### Generalize privileged frequency experiments

The legacy frequency A/B/A path safely restores `intel_pstate/no_turbo` and
keeps a compatibility-sensitive recovery ledger. A generic adapter must match
those restoration, locking, signal, `SIGKILL` recovery, invoking-user, and
measured-frequency guarantees before it can run another workload. It must not
rename or strand the historical `/run/node-pglite-wasm-sigsegv-repro/`
namespace.

### Expand the supervision boundary only on demand

Current custom workloads are trusted not to daemonize or leave their supervised
process group. Cgroup-backed execution could give stronger descendant tracking
and cleanup, but introduces delegation, permissions, distribution differences,
and a new identity/lifecycle contract. It should be driven by a concrete
workload that cannot fit the existing trusted boundary.

Historical Node A/B/A and warmup matrices also involve multiple workload
identities and different inference questions. Generalizing them would require
new manifests and report semantics. Their current legacy implementation is
adequate until a second real use case demonstrates broader value.

## Preserve compatibility while extending

Every accepted extension should keep these project rules:

- add a new manifest or evidence version instead of mutating versions 1–7;
- keep old bundles readable under their original meanings;
- bind every workload, condition, schedule, tool, and environmental change
  needed for interpretation before execution;
- publish only complete attempts, waves, sessions, or capture artifact sets;
- exercise lifecycle and failure paths with harmless deterministic fixtures in
  CI; and
- keep live stress, debugger, and privileged operations behind an inspected
  plan and explicit confirmation.

See [project direction](project-direction.md) for completed migration history
and [architecture decisions](decisions/README.md) for accepted compatibility
boundaries.
