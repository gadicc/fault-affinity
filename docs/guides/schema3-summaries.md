# Summarize a schema-3 bundle

Use `fault-affinity summarize` to inspect committed evidence in any schema-3
manifest version from 1 through 7. The command re-resolves the workload,
validates the complete bundle and every committed phase envelope, and writes a
derived summary to standard output.

It does not start a workload, create or modify bundle files, or claim that an
observed CPU association is causal.

## Read the text summary

```sh
node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/wasm-exact \
  --workload wasm-churn
```

Use the same workload identity that created the bundle. For a custom workload,
use `--workload-file` with the same definition file. Resolution refuses changed
commands, arguments, lifecycle, classifiers, capabilities, or provenance.

The text output includes:

- schema-3 manifest version, generation, and workload digest;
- `not-bound`, `empty`, `incomplete`, or `complete` phase status;
- committed and scheduled wave, session, or attempt counts;
- the next uncommitted scheduled unit for every incomplete bound phase;
- an `interrupted` or `reconciled` `attempt-armed.json` breadcrumb when present,
  always labeled non-evidence;
- outcome category and label counts;
- per-context CPU-group and pinned-concurrent counts;
- per-leg controlled-load counts;
- aggregate debugger run and capture progress (manifest v6);
- all five combined campaign phases (manifest v7); and
- per-CPU exact counts.

Only committed, already validated outcomes appear. An incomplete phase remains
explicit and its next unit is not counted. An `attempt-armed.json` breadcrumb
means the exclusive owner durably entered that scheduled unit before its normal
return path. It does not prove process launch, completion, an outcome, or a
causal relationship to a machine reset.

## Read JSON

Add `--json` for summary schema version 1:

```sh
node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/wasm-exact \
  --workload wasm-churn \
  --json
```

JSON preserves category and label as separate fields. Consumers should check
the top-level `version`, each phase `status`, and the committed and scheduled
counts rather than inferring completion from a nonempty outcome list.
The additive top-level `attemptArmed` object has `evidence: false`; `status` is
`none`, `interrupted`, or `reconciled`.

## Summarize a dual-workload bundle

Manifest versions 5 and 7 bind a second workload identity. Supply the same
condition definition used at creation:

```sh
node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/controlled-load \
  --workload-file workloads/measured.json \
  --condition-workload-file workloads/condition.json
```

The condition definition is resolved only to validate the stored identity. No
condition worker starts. Condition selectors are rejected for manifest
versions 1 through 4 and 6.

For the built-in reduced recipe, one option supplies both identities:

```sh
node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/wasm-churn-aba \
  --recipe wasm-churn-aba
```

An explicitly selected built-in condition may instead be repeated with
`--condition-workload yes-load`.

For a combined campaign, use its campaign recipe:

```sh
node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/wasm-campaign \
  --recipe wasm-churn-diagnose
```

`summarize` remains a compact progress and outcome view. Use the separate
read-only `report` command for the v7 wave, per-context, per-CPU, interval, and
focused A/B/A statistics:

```sh
node fault-affinity.mjs report \
  --bundle-dir diagnostics/wasm-campaign \
  --recipe wasm-churn-diagnose
```

## Keep the interpretation narrow

The summary is a read-only view, not a persisted evidence format. It does not
add telemetry, debugger capture, privacy review, confidence intervals, or
cross-phase causal conclusions. A completed v7 campaign separately publishes
a derived, manifest-bound report, but the validated bundle remains the
evidence authority. Share the complete bundle alongside any copied summary or
report.
