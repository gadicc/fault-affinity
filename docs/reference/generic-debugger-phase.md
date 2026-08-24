# Understand the generic debugger phase manifest

The debugger-phase manifest is the compatibility boundary for schema-3
manifest-v6 GDB capture. It describes exactly what the public `debugger`
workflow will run, while execution and durable phase state remain the
responsibility of the supervised runner and phase store.

## Bind one workload and target-signal policy

The selected workload must declare `capabilities.gdb: true` and at least one
target signal. The manifest stores its workload-contract version, stable ID,
and digest. Changing the command, arguments, working directory, environment
policy, provenance, lifecycle, outcomes, or capabilities therefore requires a
new workload identity and bundle.

The fixed command profile records the sorted target-signal list and these
capture sections:

- stop information;
- backtrace;
- registers;
- instructions around the program counter;
- thread information; and
- process mappings.

The transcript profile has its own version and a fixed 64 MiB upper bound.

## Materialize the fixed command profile

`diagnose-lib/debugger-command-profile.mjs` turns a parsed manifest, a run
number, and a per-attempt nonce into an immutable versioned command
descriptor. The descriptor binds the phase generation, manifest SHA-256, run,
nonce, profile ID, scheduled CPU, sorted target signals, fixed capture
sections and commands, and the target workload ID and digest. Its canonical
identity line carries its own SHA-256 and byte count, and the complete
descriptor is bounded to 1 MiB with a stable typed error when oversized.

The recorded command is shell-free: fixed noninteractive GDB startup arguments
(no init files, no auto-loading or debuginfod downloads,
`set startup-with-shell off`), then `--args` followed byte-exactly by the
target executable and its argument array. Target environment values never
appear in the descriptor.

A fixed embedded Python profile makes control fd 3 non-inheritable before the
inferior starts, witnesses the inferior PID, `/proc` start ticks, and the
singleton allowed-CPU list, runs only the manifest-bound capture commands, and
emits the [structured control protocol](generic-debugger-control.md) to fd 3,
always closing a started profile with `profile-complete`. Synthetic tests
execute the profile's gdb-free emission prelude under `python3` and parse the
bytes with the real control parser; they never launch GDB.

## Bind debugger provenance and execution

The manifest resolves GDB to a canonical regular executable and records its
path, byte count, mode, and full SHA-256 digest. It also binds one target CPU,
maximum run and capture counts, singleton-affinity mode, `taskset` path,
per-run timeout, and cleanup grace intervals.

Stored parsing is intentionally filesystem-independent. Immediately before
each launch, the runner re-opens and hashes the recorded GDB path and refuses
execution if it differs. The target workload has its own equivalent launch
provenance check.

## Keep this foundation distinct from evidence

The manifest does not claim that a capture occurred. The [supervised adapter](generic-debugger-adapter.md)
executes one attempt under the established Node supervisor,
[complete-only attempt envelopes](generic-debugger-attempt-envelopes.md) bind
typed outcomes, affinity and cleanup evidence, and durable artifact triples,
and the [schema-3 manifest-v6 variant](../decisions/0031-schema3-manifest-v6-debugger.md)
binds the debugger phase beside exact-CPU state under one exclusive lease.
The public `debugger` command drives fresh, dry-run, and resume flows for v6
bundles, and the read-only summary renders per-run typed outcomes.

`capabilities.gdb` is now backed by a public phase. The historical
`capture-fault.sh` and schema-2 GDB evidence remain separate.
