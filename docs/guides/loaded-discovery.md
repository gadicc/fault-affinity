# Find a load-sensitive CPU from scratch

Use `loaded-discover` when you don't know which logical CPU is affected and an
unloaded CPU sweep may not reproduce the fault. It tests each target without
load, under verified load, and after recovery. It then recommends a separate
confirmation run for the strongest candidate.

## Quick start

Inspect the plan first. This command does not run the workload or create the
output directory:

```sh
node fault-affinity.mjs loaded-discover \
  --out-dir diagnostics/wasm-loaded-discovery \
  --dry-run
```

On a hybrid Linux system with complete topology masks, the default plan uses
all detected efficiency cores (E-cores) as targets and all detected performance
cores (P-cores) as load workers. The dry run prints both sets, each controller,
and the session count.

Close valuable work and save unrelated files before continuing. A deliberately
stressful test on unstable hardware can hang or reboot the system. When ready,
repeat the command with `--yes`:

```sh
node fault-affinity.mjs loaded-discover \
  --out-dir diagnostics/wasm-loaded-discovery \
  --yes
```

If it is interrupted, keep the directory and resume it:

```sh
node fault-affinity.mjs loaded-discover \
  --resume diagnostics/wasm-loaded-discovery \
  --yes
```

Resume uses the stored recipe, CPU sets, order, timings, and taskset path. It
does not rediscover topology or accept replacement scheduling options.

## Read the result

Completion prints:

- each affected target and its with-load failure rate;
- the strongest candidate;
- paths to `loaded-discovery-report.md` and `loaded-discovery-report.json`; and
- an exact dry-run command for a fresh `wasm-churn-aba` confirmation bundle.

Review that suggested command, then replace `--dry-run` with `--yes`. Keep the
confirmation in a new directory: discovery chose the candidate, while the new
bundle tests the A/B/A pattern independently.

Each target also has its own resumable schema-3 version-5 child bundle, named
like `cpu-00019`. Those child bundles are the authoritative workload evidence;
the collection report is the convenient cross-target view.

## Understand the A1/B/A2 result

Each target runs in a separate A1/B/A2 session:

- A1 tests the target without managed load
- B tests it while every load worker is verified alive and pinned
- A2 tests it after the workers stop and the recovery interval passes

The screen ranks only B results. It never pools A1, B, and A2. The suggested
confirmation run collects a new sample instead of reusing discovery evidence.

## Choose the size

The default `quick` profile is intended for screening:

| Profile | Attempts in each A1/B/A2 leg | Recovery before A2 |
| --- | ---: | ---: |
| quick | 3 | 5 seconds |
| standard | 10 | 15 seconds |
| full | 20 | 30 seconds |

Select a larger profile only after checking its dry run:

```sh
node fault-affinity.mjs loaded-discover \
  --profile standard \
  --out-dir diagnostics/wasm-loaded-discovery-standard \
  --dry-run
```

Every target has a separate recovery interval, so total time grows with both
the target count and profile.

## Supply CPU sets explicitly

Automatic mode fails closed unless Linux exposes complete, non-overlapping
P-core and E-core masks. On a uniform machine, in a restricted container, or
when testing a different hypothesis, supply both disjoint sets:

```sh
node fault-affinity.mjs loaded-discover \
  --target-cpus 16-23 \
  --load-cpus 0-7 \
  --out-dir diagnostics/wasm-loaded-discovery \
  --dry-run
```

Every listed CPU must be online and allowed to the invoking process. At least
one additional usable CPU must remain outside each target and the load set so
the orchestrator can be pinned separately.

## Understand the workload

The default `wasm-churn-aba` recipe runs the reduced Node.js/V8 WebAssembly
churn workload with dependency-free `yes` workers. It does not use PGlite and
does not require `npm ci`.

This is still a software workload, so an observed affinity localizes where it
reproduced; it does not by itself prove a defective logical CPU. Conversely, a
clean quick screen is limited evidence, not proof that the machine is fault
free.

The native `churn-mem` experiment is not part of this command or any built-in
recipe. It produced kernel oopses on the affected case-study machine and should
not be substituted for this screen unless a forced reboot is acceptable.

## Compare hardware before and after replacement

Use a fresh directory on the replacement system:

```sh
node fault-affinity.mjs loaded-discover \
  --out-dir diagnostics/wasm-loaded-discovery-post-replacement \
  --dry-run
```

Do not resume the old collection on different hardware. Retain both complete
directories so their immutable plans, child bundles, and reports can be
compared.
