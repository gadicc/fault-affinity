# Run a generic diagnostic campaign

Use `fault-affinity diagnose` when you want the generic equivalent of the old
multi-phase diagnostic sweep: a baseline, CPU-group screening,
controller-aware pinned-concurrent screening, every-CPU localization, a
focused controlled-load A/B/A comparison, and one final statistical report.

The command creates a schema-3 manifest-version-7 bundle. Its measured
workload, condition workload, topology, schedules, executable identities, and
phase manifests are immutable. Resume advances the existing committed
prefixes; it never rebuilds the plan from the current host.

## Start with the reduced built-in

The recommended dry run needs only an output path:

```sh
node fault-affinity.mjs diagnose \
  --out-dir diagnostics/wasm-campaign \
  --dry-run
```

With no selection options, `diagnose` uses the `wasm-churn-diagnose` recipe.
That recipe selects:

- `wasm-churn-suite` as the measured multi-phase workload;
- `yes-load` as the managed condition workload; and
- the `quick` profile.

The dry run resolves and hashes both workload identities, reads CPU topology,
checks the invoking process's CPU allowance, and prints the complete plan. It
does not start either workload or create the output directory.

Do not start a live campaign while unrelated load matters to the experiment.
External activity is not controlled or recorded as the campaign condition and
can make baseline, group, pinned, exact, and recovery observations harder to
compare.

## Review the automatic topology

Automatic planning defines usable CPUs as the intersection of Linux's online
CPU list and the invoking process's allowed CPU list. The dry run prints that
set and every derived context.

On a hybrid Linux system with complete `cpu_core` and `cpu_atom` masks, the
planner creates:

- performance-core and efficient-core group contexts;
- efficient-core cluster contexts, using topology cluster IDs or shared L2
  masks when available;
- matching pinned-concurrent contexts with a controller outside each active
  mask; and
- an exact schedule covering every usable logical CPU.

On a uniform system, the group phase covers all usable CPUs. The
pinned-concurrent phase partitions that set when necessary so each context has
a separate allowed controller CPU. Incomplete or overlapping hybrid masks are
refused instead of guessed.

The focused controlled-load defaults are deliberately simple:

- target: the highest numbered usable logical CPU;
- workers: every other usable logical CPU; and
- seed: `17`.

The target default is deterministic convenience, not adaptive fault
localization and not evidence that the selected CPU is suspect. If previous
evidence identifies a target, bind it explicitly. For the affected machine in
the case study:

```sh
node fault-affinity.mjs diagnose \
  --target-cpu 19 \
  --out-dir diagnostics/wasm-campaign \
  --dry-run
```

Override the worker set when loading every other usable CPU is inappropriate:

```sh
node fault-affinity.mjs diagnose \
  --target-cpu 19 \
  --load-cpus 0-7 \
  --out-dir diagnostics/wasm-campaign \
  --dry-run
```

The exact phase still covers every usable CPU. `--target-cpu` and
`--load-cpus` change only the focused A/B/A session.

## Choose the campaign size

Profiles bind these counts before any workload starts:

| Profile | Baseline | Group rounds per context | Pinned rounds per context | Exact rounds per CPU | Attempts per A1/B/A2 leg | Recovery before A2 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `quick` | up to 4 children × 3 waves | 3 | 3 | 3 | 3 | 5 s |
| `standard` | up to 8 children × 10 waves | 10 | 10 | 10 | 10 | 15 s |
| `full` | up to 16 children × 50 waves | 50 | 200 | 200 | 20 | 30 s |

Group waves use up to 16 children or the size of the context, whichever is
smaller. Pinned waves use one independently supervised child per active CPU.
The total therefore depends on the usable CPU count and discovered topology;
the dry run prints the actual wave and attempt totals. `full` is intentionally
large and can take a long time.

Select a larger profile only after reviewing its dry run:

```sh
node fault-affinity.mjs diagnose \
  --profile standard \
  --target-cpu 19 \
  --out-dir diagnostics/wasm-campaign-standard \
  --dry-run
```

`--quick`, `--standard`, and `--full` are equivalent profile aliases.

## Run and resume

After reviewing the plan and arranging an appropriate maintenance window,
replace `--dry-run` with `--yes`:

```sh
node fault-affinity.mjs diagnose \
  --target-cpu 19 \
  --out-dir diagnostics/wasm-campaign \
  --yes
```

The command runs phases in this order:

1. baseline;
2. CPU groups;
3. pinned-concurrent contexts;
4. exact logical CPUs; and
5. focused A1/B/A2 controlled load.

Only complete attempts or complete correlated waves advance a phase. The
controlled-load phase publishes only a complete session. `SIGINT` and
`SIGTERM` are forwarded through the established bounded cleanup paths.

Resume the default recipe with:

```sh
node fault-affinity.mjs diagnose \
  --resume diagnostics/wasm-campaign \
  --yes
```

Resume validates the persisted manifest and both workload identities before
continuing the first incomplete phase. It does not rediscover topology or
accept fresh profile, target, load, seed, taskset, or plan options.

## Read the final report

After all five phases complete, the command publishes these derived files in
the bundle root:

- `report.json`: versioned machine-readable statistics;
- `report.md`: the corresponding human-readable report; and
- `report.complete.json`: bindings for the manifest and both report files.

The completion marker is written last. Repeating resume verifies or
idempotently republishes the same bytes. The private phase state and immutable
`fault-affinity-bundle.json` remain the evidence authority.

Rebuild the report from a validated bundle without executing a workload or
writing files:

```sh
node fault-affinity.mjs report \
  --bundle-dir diagnostics/wasm-campaign \
  --recipe wasm-churn-diagnose
```

Add `--json` for the report object. Use `summarize` for a compact progress and
typed-outcome view instead:

```sh
node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/wasm-campaign \
  --recipe wasm-churn-diagnose \
  --json
```

For a complete public campaign, `report` also reconciles the published report
files with the validated bundle before rendering them.

## Interpret the statistics conservatively

The report treats `target-fault` and `corruption` as target outcomes. The rate
denominator contains only passes plus target outcomes. Other workload
failures remain visible as a separate count and are never silently treated as
passes or targets.

It reports:

- wave and child results separately for baseline, group, and pinned phases;
- per-context and per-CPU results where the phase supports them;
- exact per-CPU target rates;
- A1, loaded B, and recovered A2 rates;
- Wilson 95% intervals and a 95% upper bound when no target is observed; and
- one-sided Fisher exact comparisons for B versus A1 and B versus A2.

The loaded association gate passes only when both directional comparisons
have `p < 0.05`. This is a prespecified descriptive gate for one sequential
session. It does not remove order or time confounding and does not by itself
establish causality. Wave, child, exact-attempt, and A/B/A denominators are
never pooled.

## Repeat the historical workload

The same campaign can use the retained heavyweight Node/PGlite profile:

```sh
npm ci
node fault-affinity.mjs diagnose \
  --recipe node-pglite-diagnose \
  --target-cpu 19 \
  --out-dir diagnostics/node-pglite-campaign \
  --dry-run
```

This recipe selects `node-pglite-suite` plus `yes-load`; it does not restore
the legacy suite's telemetry, frequency, debugger, or privacy-review phases.
Use [`run-diagnostics.md`](run-diagnostics.md) when those historical extras are
the purpose of the collection.

## Use a trusted custom workload or plan

Select a trusted local workload definition and a condition explicitly:

```sh
node fault-affinity.mjs diagnose \
  --workload-file workloads/my-suite.json \
  --condition-workload yes-load \
  --out-dir diagnostics/my-campaign \
  --dry-run
```

The measured definition must declare baseline, group, pinned-concurrent, and
isolated capabilities. The condition must declare managed survival-window
semantics. Custom workloads are trusted local programs, not sandboxed code;
see the [workload catalog](../../workloads/README.md).

For a fully reviewed static topology, supply a bounded campaign plan with
`--plan-file`. It combines the established baseline, group,
pinned-concurrent, exact, and controlled-load plan shapes under campaign plan
version 1. A plan file conflicts with automatic profile, target, load, and
seed options. The expanded schedules, rather than a recipe name or host
topology lookup, are what the manifest binds.

## Know what version 7 does not collect

Version 7 intentionally keeps the topology phases condition-free and applies
`yes-load` only to the focused controlled-load B leg. A full loaded sweep over
every group or logical CPU would require a new explicitly bound protocol.

The campaign also does not collect generic telemetry, debugger transcripts,
frequency-control results, or a privacy-review inventory. Use the separate
public debugger command where appropriate, and review all workload output
before sharing a bundle.
