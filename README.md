# Fault Affinity

Copyright (c) 2026 by Gadi Cohen. [MIT Licensed](LICENSE.TXT).

Fault Affinity is a Linux harness for bounded, resumable investigation of
intermittent CPU-sensitive process faults. It runs a trusted workload across
deterministic CPU-affinity schedules and records reviewable evidence. Observed
affinity shows where a workload reproduced; it is not, by itself, proof of CPU
causation.

The project began with native faults during Node.js and PGlite WebAssembly
initialization. That heavyweight workload remains as a historical built-in and
case study. The recommended reduced built-in is the dependency-free
WebAssembly churn workload.

## Quick start

Using Windows and looking for the simplest comparison? Start with the
[Ubuntu live reference kit](docs/live-kit.md). It explains how to boot an
official Ubuntu USB in **Try Ubuntu** mode, open Terminal, paste three safe
preview commands, and save or upload the result. No Linux experience, Node,
npm, or Git installation is required. Use only a stable kit shown on the
Releases page; do not substitute a development snapshot.

Already on Linux with Node and a repository checkout? Start with a dry run. It
checks the machine and shows the complete plan without executing a workload or
creating a results directory:

```sh
node fault-affinity.mjs diagnose \
  --out-dir diagnostics/wasm-campaign \
  --dry-run
```

With no workload options, `diagnose` selects `wasm-churn-diagnose`: the
multi-phase WebAssembly churn workload, verified `yes-load` condition, and
bounded `quick` profile. It discovers the online CPUs available to the invoking
process, displays CPU classes and groups, plans an exact sweep over every usable
logical CPU, and chooses a focused controlled-load target.

If you do not know the affected CPU and suspect that other-core activity is
important, use the optional loaded screen instead. On a supported hybrid
system it tests every detected E-core while verified load runs on the detected
P-cores:

```sh
node fault-affinity.mjs loaded-discover \
  --out-dir diagnostics/wasm-loaded-discovery \
  --dry-run
```

Review either plan, close valuable work, then replace `--dry-run` with `--yes`.
Both workflows are resumable. Read the
[loaded discovery guide](docs/guides/loaded-discovery.md) when choosing a CPU
from scratch; it explains the final ranking and confirmation command.

The default target is the highest usable CPU for determinism, not because the
harness considers it suspect. Preserve a known target explicitly; CPU 19 was
the strongest target on the affected case-study machine:

```sh
node fault-affinity.mjs diagnose \
  --target-cpu 19 \
  --out-dir diagnostics/wasm-campaign \
  --dry-run
```

After reviewing the plan and arranging a suitable maintenance window, repeat
the fresh command with `--yes` instead of `--dry-run`. Resume an interrupted
campaign without changing its bound topology or schedules:

```sh
node fault-affinity.mjs diagnose \
  --resume diagnostics/wasm-campaign \
  --yes
```

A completed schema-3 version-7 campaign publishes bound `report.md` and
`report.json` statistics. Re-render the validated report without executing a
workload or modifying the bundle:

```sh
node fault-affinity.mjs report \
  --bundle-dir diagnostics/wasm-campaign \
  --recipe wasm-churn-diagnose
```

Read [run a generic diagnostic campaign](docs/guides/generic-diagnose-campaign.md)
for topology policy, profile sizes, load overrides, resume, custom workloads,
report files, and interpretation.

## Safety

> [!CAUTION]
> Live workloads consume CPU and may terminate abnormally. On unstable hardware,
> the reduced WebAssembly campaign and sustained `yes-load` condition can hang or
> reboot the whole system, risking unrelated work or unsaved data. Use a
> maintenance window, keep backups current, close valuable workloads, and inspect
> a dry run first. A mitigation such as disabling turbo can change reproduction
> frequency but is not a safety guarantee. The historical PGlite workload uses
> about 1.2 GiB per child and can also exhaust memory under concurrency.

> [!WARNING]
> The native `churn-mem` experiment produced kernel oopses on the affected machine, including an unkillable process that required reboot. It is never a built-in campaign workload. Do not run native churn modes unless a hang or forced reboot is acceptable.

Custom workloads are trusted local programs, not sandboxed code. They run with
the invoking account's access and must not daemonize or leave the supervised
process group.

The generic command and legacy diagnostic runner do not require root. They do
not change firmware, write sysfs settings, or alter unrelated process affinity.
Optional privileged operations remain separate, reviewable scripts.

## Current generic workflows

The public command owns schema-3 manifest versions 1 through 7:

| Workflow | Role | Guide |
| --- | --- | --- |
| `diagnose` | Complete topology, exact-CPU, and focused-load campaign with final statistics | [Generic campaign](docs/guides/generic-diagnose-campaign.md) |
| `loaded-discover` | Optional every-E-core screen under verified P-core load | [Loaded discovery](docs/guides/loaded-discovery.md) |
| `exact` | Focused or every-CPU isolated schedule | [Exact CPU](docs/guides/generic-exact-cpu.md) |
| `baseline` | Correlated concurrent waves | [Baseline](docs/guides/generic-baseline.md) |
| `groups` | Explicit overlapping CPU-group contexts | [CPU groups](docs/guides/generic-cpu-groups.md) |
| `pinned` | Controller-aware, one-child-per-CPU waves | [Pinned concurrent](docs/guides/generic-pinned-concurrent.md) |
| `controlled-load` | Standalone complete A1/B/A2 comparison | [Controlled load](docs/guides/generic-controlled-load.md) |
| `debugger` | Bounded generic GDB capture | [Debugger phase](docs/guides/debugger-phase.md) |
| `summarize` / `report` | Read-only validated views | [Schema-3 summaries](docs/guides/schema3-summaries.md) |

Listing, inspection, summaries, reports, and dry runs do not execute a
workload:

```sh
node fault-affinity.mjs workloads
node fault-affinity.mjs recipes
node fault-affinity.mjs inspect --workload wasm-churn-suite
node fault-affinity.mjs --help
```

`wasm-churn` and `node-pglite` retain their exact-only identities. Their
`-suite` profiles add baseline, group, pinned-concurrent, and exact capabilities
under distinct identities. Use a versioned workload JSON file to supply a
trusted local script or binary; see the [workload catalog](workloads/README.md).

The v7 campaign report covers topology and focused-load statistics. The
separate `loaded-discover` collection screens every selected target under the
same verified load set. Neither workflow adds generic telemetry, debugger
transcripts, frequency experiments, or a
privacy-review inventory. Those remain separate workflows where available.

## Historical Node/PGlite reproduction

The original child creates an in-memory PGlite 0.5.4 client, runs `SELECT 1`,
closes it, and exits. On Linux x64 with Node 24 or newer:

```sh
npm ci
npm run repro
```

The default runs 16 concurrent children for up to 50 waves and stops after the
first failed wave. A clean system exits every child normally; the affected
system sometimes delivered `SIGSEGV`. See
[trace the original reproduction](docs/case-study/origin-and-reproduction.md)
for arguments, memory requirements, output, and runtime controls.

`diagnose.sh` preserves the original telemetry-rich Node/PGlite workflow:

```sh
./diagnose.sh --dry-run
```

It remains useful for historical compatibility, read-only telemetry, optional
debugger and frequency evidence, privacy review, and the legacy signed report.
Use [run the legacy diagnostic suite](docs/guides/run-diagnostics.md) before a
live collection. Legacy controlled-load modes are documented separately in
[controlled-load experiments](docs/guides/controlled-load-experiments.md).

## Zero-install Ubuntu reference kit

The first distribution target is a self-contained Linux x86-64 kit for an
official Ubuntu Desktop live session. It pins both Node runtimes, PGlite, and
the A/B/A schedules, so a Windows user can screen the physical CPUs without
installing Node, npm, Git, or a compiler on Windows. `discover-reference`
selects a candidate from a short loaded screen, and `confirm-reference`
collects a fresh 20-attempt A1/B/A2 comparison. The historical CPU 19 profile
remains available through `run-reference`. Every command is dry by default;
live work requires a separate command ending in `--yes`.

Public release publication is guarded by checked-in acceptance gates, reviewed
promotion to protected `main`, and manual `stable-release` approval. See
[use the Ubuntu live reference kit](docs/live-kit.md) for the operator workflow
and [the distribution and release plan](docs/distribution-and-release-plan.md)
for the rollout and later native-Windows screening design.

## Case-study findings

The checked-in measurements describe one affected Dell Pro Max 18 Plus with a
Core Ultra 9 285HX. They do not establish a defect in every system with that
model or processor.

- GDB repeatedly recorded an ordinary memory access whose reported fault
  address was exactly `2^42` above the valid intended address.
- A native test later captured the same `+2^42` anomaly in kernel mode during
  syscall entry.
- Recorded exact-CPU failures occurred only on E-cores, with CPU 19 producing
  the highest isolated rate.
- One process pinned to a susceptible CPU reproduced, so concurrency was not
  required.
- Verified activity elsewhere on the package changed CPU 19 from 0/20 to 19/20
  and back to 0/20 in one A/B/A session.
- Software, kernel, power, and memory-pressure controls changed triggerability
  without explaining the recurring address signature.

The evidence points toward a platform-dependent execution anomaly rather than
a conventional Node or PGlite address-generation bug. It remains evidence, not
formal proof of a defective CPU or a universal root cause. Start with the
[case-study index](docs/case-study/README.md) for measured results and inference
boundaries.

## Evidence and documentation

Generic schema-3 bundles use immutable manifests, complete-prefix phase stores,
and version-specific readers. Completed v7 report files are derived from that
validated evidence; they do not replace it as the authority.

Legacy bundles have different integrity and privacy rules. Verify their
`manifest.txt`, review `privacy-review.txt` and flagged raw files, and never
rename the historical privileged recovery namespace. See
[understand evidence bundles](docs/reference/evidence-bundles.md).

- [Documentation map](docs/README.md)
- [Project direction](docs/project-direction.md)
- [Optional roadmap](docs/roadmap.md)
- [Interpret experimental results](docs/concepts/interpreting-results.md)
- [Develop and test the tooling](docs/development.md)

## Filed reports

- [Node.js issue 64500](https://github.com/nodejs/node/issues/64500)
- [PGlite issue 1053](https://github.com/electric-sql/pglite/issues/1053)
- [Ubuntu bug 2158237](https://bugs.launchpad.net/bugs/2158237), the closest independent platform report with important differences
