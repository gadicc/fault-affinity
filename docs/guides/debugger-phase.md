# Capture a debugger phase in a schema-3 bundle

Use `fault-affinity debugger` to run the generic debugger phase for one
workload under one pinned CPU. The command creates or resumes a schema-3
manifest-v6 bundle — the debugger-focused exact-CPU variant — and publishes
complete attempt envelopes with bounded transcripts only.

Live runs execute a workload under the resolved debugger. Review the workload
and the plan first with a dry run. Debugger transcripts retain verbatim
workload and debugger output, which can contain values the workload itself
prints; treat retained transcripts as sensitive as the workload's own output.

## Plan a fresh debugger bundle

```sh
node fault-affinity.mjs debugger \
  --workload-file workloads/debugger-target.json \
  --cpu 19 --max-runs 6 --max-captures 3 \
  --debugger /usr/bin/gdb \
  --out-dir diagnostics/debugger-capture \
  --dry-run
```

The workload must declare the `isolated` and `gdb` capabilities and at least
one target signal. The CPU must be inside the invoking process allowance. The
debugger path resolves to an executable regular file whose identity is hashed
into the phase manifest. `--max-captures` cannot exceed `--max-runs`, and both
are bounded by the phase schedule limits. The dry run validates the complete
plan and creates no bundle and no process.

## Run or resume

```sh
node fault-affinity.mjs debugger \
  --workload-file workloads/debugger-target.json \
  --cpu 19 --max-runs 6 --max-captures 3 \
  --debugger /usr/bin/gdb \
  --out-dir diagnostics/debugger-capture \
  --yes
```

A live run advances one committed attempt at a time until the run cap or the
capture cap, then stops. An attempt that cannot complete publishes nothing and
stops the run with a clear nonzero exit; rerun the command to retry that run
with a fresh per-attempt nonce. A busy bundle lease exits 75. SIGINT/SIGTERM
cancel the in-flight attempt cleanly.

```sh
node fault-affinity.mjs debugger --resume diagnostics/debugger-capture \
  --workload-file workloads/debugger-target.json --yes
```

Resume revalidates the stored workload, debugger, and target identities
before continuing the exact committed prefix. A changed workload definition
or debugger executable is refused.

## Inspect committed captures

The read-only `summarize` command validates v6 bundles like any other. The
debugger section reports run and capture progress, aggregate outcome counts,
and one typed outcome per committed run with its deterministic artifact
paths under `state/debugger/`.

The built-in debugger profiles are `wasm-churn-debugger` (the finite reduced
WebAssembly churn trigger) and `node-pglite-debugger` (the historical finite
Node/PGlite trigger). Both terminate naturally when no fault occurs. The
native churn harness is not a debugger built-in.
