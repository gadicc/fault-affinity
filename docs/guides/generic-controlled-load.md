# Run a generic controlled-load comparison

Use `fault-affinity controlled-load` to compare one measured workload before,
during, and after a separately declared condition workload. The command creates
a schema-3 manifest-version-5 bundle and publishes only one complete A1/B/A2
session.

## Start with the WebAssembly recipe

The recommended reduced experiment is a built-in recipe. It selects
`wasm-churn` as the measured workload and one verified `yes-load` worker per
declared load CPU:

```sh
node fault-affinity.mjs recipes
node fault-affinity.mjs controlled-load \
  --recipe wasm-churn-aba \
  --target-cpu 19 \
  --load-cpus 0-7 \
  --out-dir diagnostics/wasm-churn-aba \
  --dry-run
```

Replace the example CPU numbers with topology you have reviewed. The target
must be outside the load set and every CPU must be inside the invoking
process's allowance. Fault Affinity deliberately does not guess which CPUs are
performance cores, efficiency cores, siblings, or suitable controls.

The recipe defaults are:

| Setting | Default |
| --- | ---: |
| Measured workload | `wasm-churn` |
| Condition workload | `yes-load` |
| Attempts in each A1/B/A2 leg | 10 |
| Additional load warm-up | 0 ms |
| Recovery before A2 | 15,000 ms |
| Bound exact sibling | target CPU, 10 rounds, seed 17 |

The measured attempt window remains part of the immutable `wasm-churn`
identity: ten seconds. Override recipe schedule values, when needed, with
`--attempts-per-leg`, `--warmup-ms`, `--recovery-ms`, `--exact-cpus`,
`--exact-rounds`, and `--seed`.

The dry run resolves and hashes both executables, checks capabilities and CPU
allowance, prints the fully expanded schedules, creates no bundle, and starts
no process. After reviewing it, replace `--dry-run` with `--yes`.

Completed diagnose campaigns recommend an identity-preserving confirmation
recipe when one exists. `wasm-churn-suite-aba` preserves the
`wasm-churn-suite` identity, while `node-pglite-suite-aba` preserves the
historical heavyweight `node-pglite-suite` identity. Custom campaign workloads
do not receive an automatic recipe substitution; repeat their reviewed
workload selections with an explicit plan instead.

## Resume and summarize the recipe

Recipe selection supplies both workload identities during resume:

```sh
node fault-affinity.mjs controlled-load \
  --resume diagnostics/wasm-churn-aba \
  --recipe wasm-churn-aba \
  --yes

node fault-affinity.mjs summarize \
  --bundle-dir diagnostics/wasm-churn-aba \
  --recipe wasm-churn-aba
```

If the run is interrupted or any leg or condition witness is invalid, no
partial session is published. Resume repeats the complete A1/B/A2 unit. A
completed resume is a validated no-op.

Run the separately bound exact phase with the same recipe identities:

```sh
node fault-affinity.mjs exact \
  --resume diagnostics/wasm-churn-aba \
  --recipe wasm-churn-aba \
  --yes
```

The condition workload is verified while reading the v5 bundle but is not
started by the exact command.

## Use a generic plan file

For another measured workload or schedule, create a bounded JSON plan:

```json
{
  "version": 1,
  "controlledLoad": {
    "targetCpu": 19,
    "workerCpus": "0-7",
    "attemptsPerLeg": 10,
    "warmupMs": 5000,
    "recoveryMs": 5000
  },
  "exact": {
    "cpus": "18-21",
    "rounds": 10,
    "seed": 17
  }
}
```

CPU lists must be canonical ascending strings. The exact schedule is bound at
bundle creation so it can be run later without changing the evidence identity.

`yes-load` is the default condition when a generic invocation omits a
condition option:

```sh
node fault-affinity.mjs controlled-load \
  --workload wasm-churn \
  --plan-file controlled-load-plan.json \
  --out-dir diagnostics/controlled-load \
  --dry-run
```

Select another built-in with `--condition-workload ID`, or a trusted custom
definition with `--condition-workload-file FILE`. A condition must declare
`survive-window` semantics, remain active through warm-up and every B attempt,
and must not daemonize or escape its supervised process group.

Generic resume must resolve the same two identities. The default remains
`yes-load`, so the common built-in form is concise:

```sh
node fault-affinity.mjs controlled-load \
  --resume diagnostics/controlled-load \
  --workload wasm-churn \
  --yes
```

If creation used an explicit custom condition, repeat its
`--condition-workload-file` on controlled-load resume, exact resume, and
summary.

## Interpret the boundary

Fault Affinity starts one condition process per load CPU, verifies each process
identity and singleton affinity, checks the complete set around B, and stops
and reaps it before recovery. The published session supports comparison of
typed outcomes across A1, B, and A2 under that declared condition.

The recipe does not infer a causal mechanism, pin the lightweight CLI owner to
a separate controller CPU, or collect the legacy suite's temperature and
frequency telemetry. Preserve the complete bundle when sharing results.

The historical [`load-state-aba.mjs`](controlled-load-experiments.md) modes
remain available for the original Node/PGlite investigation. They include
multi-executable and debugger experiments that do not share this
single-measured-workload schema.
