# Understand the Fault Affinity direction

This page separates the implemented Fault Affinity harness from its remaining
optional extensions. **Fault Affinity** is now the package and public command
identity. The generic path spans exact-CPU, baseline, CPU-group,
pinned-concurrent, controlled-load, debugger, and combined diagnostic campaign
workflows through schema-3 manifest versions 1 through 7.

## Define the intended scope

Fault Affinity is a Linux harness for reproducing, localizing, and collecting
reviewable evidence for intermittent CPU-sensitive process faults. Its current
public generic surface is deliberately narrower than the full intended scope.

The intended scope includes:

- CPU-group screening
- Exact logical-CPU localization
- Pinned concurrent topology contexts
- Controlled-load A/B/A experiments
- Telemetry and debugger capture
- Signals, handled crashes, data mismatches, and other workload failures
- User-supplied scripts or binaries

The project should not claim to be a universal crash debugger, hardware defect detector, fuzzer, or cross-platform tool. The current implementation depends on Linux facilities such as `taskset`, `/proc`, sysfs, `intel_pstate`, topology discovery, and GNU Debugger (GDB).

## Retain the original PGlite workload

The Node/PGlite workload remains valuable as the historical application-derived trigger and as a heavyweight regression workload. It records the path from a production-shaped failure to smaller WebAssembly probes.

PGlite no longer owns the package or README identity. Its dependency,
Dockerfile, legacy evidence schemas, and diagnostic commands remain because the
historical reproduction and broader legacy suite still use them.

## Prefer WebAssembly churn as the reduced trigger

`mini-wasm-churn.mjs` is the recommended `wasm-churn` built-in. It is
dependency-free and reproduced in 15/15 and 10/10 documented loaded attempts
on the affected machine.

The native harness remains an advanced control. Its pure-execution modes did not reproduce the userspace fault in the documented runs, while `churn-mem` produced kernel oopses and a wedged process. That risk makes it unsuitable as a default workload.

No command runs a built-in without the operator entering a live command with
`--yes`. Lower-level commands require an explicit workload choice. The
high-level `diagnose` command deliberately defaults to the recommended
`wasm-churn-diagnose` recipe so a complete dry run needs only an output path;
it prints the selected identities, risks, topology, and schedules before any
live confirmation.

## Bind public commands to a workload contract

A generic harness needs more than a shell command string. The version-1
workload contract records how the workload starts, when one attempt ends, and
how each outcome is classified.

The resolver and schema-3 evidence persist:

- A stable workload identifier and version
- An executable plus argument array, without shell evaluation
- A canonical working directory
- Explicit environment additions and secret-safe provenance
- Input files and executable hashes
- Resource and prerequisite warnings
- Exit-based or bounded survival-window completion
- Direct signals, handled-crash exits, corruption exits, other workload failures, and operational failures
- Protocol capabilities, including whether GDB and privileged phases apply

Literal exit `139`, direct `SIGSEGV`, a handled crash exit such as `42`, and a detected-corruption exit such as `43` must remain distinct evidence.

## Preserve legacy evidence and recovery state

New bundle, workload-contract, attempt-record, phase-envelope, and results schemas need separate versions. Existing schema-1 and schema-2 bundles must remain readable under their original meanings.

Migration must follow these constraints:

- Never upgrade an old bundle in place
- Never let resume silently change the workload, arguments, timeout, or classifier
- Make old runners fail closed on unsupported new bundles
- Preserve existing PGlite evidence as one workload; do not mix it with reduced-trigger evidence in the same bundle
- Keep the historical `/run/node-pglite-wasm-sigsegv-repro/` privileged recovery namespace readable
- Keep custom workloads out of privileged frequency experiments until the contract and supervision model are proven

The recovery namespace is operational state, not branding. Renaming it can strand a restore ledger or permit overlapping locks.

## Sequence the migration

The intended implementation sequence is:

1. Record architecture and compatibility decisions.
2. Split current-state documentation without changing behavior.
3. Establish safe automated tests that never run crash workloads.
4. Build a deadline-aware attempt runner with process-group cleanup tests.
5. Resolve canonical workload identities and bind them to evidence.
6. Migrate exact-CPU paths internally while checking PGlite compatibility.
7. Add the internal schema-3 bundle owner, then migrate baseline and group screening.
8. Migrate controlled-load and GDB; keep privileged frequency recovery on its
   compatibility path until a generic contract exists.
9. Extract built-in workloads and reorganize the source tree.
10. Adopt the Fault Affinity package and command identity without coupling it
    to a repository-host rename.

The documentation, safety-net, workload-spec, bounded attempt-runner,
versioned attempt-record, exact-CPU phase-envelope, durable phase-store,
internal schema-3 bundle owner, baseline whole-wave, CPU-group, and
pinned-concurrent foundations are complete. Bundle manifest version 1 binds one
workload and deterministic exact-CPU manifest. Version 2 additionally binds
correlated baseline waves, version 3 binds overlapping CPU-group contexts and
inherited masks, and version 4 binds a separate controller CPU plus one
singleton-affinity child per active CPU. Version 5 is a separate controlled-load
variant that binds measured and auxiliary workload identities, exact-CPU state,
and one complete A1/B/A2 store. Version 6 is a separate debugger-focused
exact-CPU variant that binds one isolated-plus-gdb workload, the exact-CPU
phase, and the debugger phase with `state/exact-cpu` and `state/debugger`
ownership; controlled-load composition is not added to that variant. Version 7
combines baseline, groups, pinned-concurrent, exact CPU, and controlled load
for one measured and one condition workload without changing versions 1
through 6. The
public `debugger` command drives fresh, dry-run, and resume flows for v6
bundles with explicit selection, explicit live confirmation, allowed-CPU
validation, bounded run/capture settings, lease-busy exit 75, and typed
nonzero stops on operationally invalid attempts. The debugger-capable
built-ins are the finite `wasm-churn-debugger` and `node-pglite-debugger`
profiles; native churn stays outside the debugger built-ins. The read-only
summary renders per-run typed debugger outcomes for v6 bundles.
The owner holds one exclusive lease across selecting, running, and committing
an exact attempt, complete baseline/group/pinned-concurrent wave, or complete
controlled-load session and derives completion from durable publication. Its
stable supervisors retain the lease through bounded cleanup if the outer owner
is interrupted.

The `fault-affinity` command now exposes reviewed workload and recipe listing,
inspection, dry-run planning, fresh exact-only schema-3 bundle creation,
exact-prefix resume, complete correlated baseline waves in manifest-v2
bundles, complete CPU-group waves in manifest-v3 bundles, controller-aware
waves in manifest-v4 bundles, and complete A1/B/A2 sessions in manifest-v5
bundles. A baseline command pre-binds the downstream exact schedule. The
groups, pinned, and controlled-load commands safely read explicit plans that
bind every sibling schedule before bundle creation. The `wasm-churn-aba`
convenience recipe expands to the unchanged version-5 contract with
`wasm-churn`, the built-in `yes-load` condition, explicit target and load CPUs,
and bounded defaults. The pinned command starts one short-lived bundle owner
under each scheduled controller CPU. The controlled-load command binds
separate measured and built-in or trusted custom condition workloads and
publishes no partial session. Phase commands can then advance their matching
prefixes in that same bundle. A read-only `summarize` command validates
versions 1 through 7 and renders committed outcomes by phase, context, leg,
run, and CPU without changing the bundle. The public `diagnose` command derives
a reviewed Linux topology plan, or accepts a bounded explicit plan, then
advances all five v7 phases in order. Completed campaigns publish bound JSON
and Markdown reports with separate wave, child, per-context, per-CPU, and
A/B/A denominators. The read-only `report` command rederives and validates that
view. Trusted custom JSON workloads declare their own capabilities.

The published `wasm-churn` and `node-pglite` IDs retain their exact-only
workload identities. Separate `wasm-churn-suite` and `node-pglite-suite`
profiles declare baseline, group, isolated, and pinned-concurrent capability so
later public phases do not mutate old bundle identities. The public-command
implementation now lives under `src/fault-affinity/`, while the stable root
executable and compatibility-sensitive workload paths remain in place. This
completes the generic source-extraction and package/command portions of steps 9
and 10 without requiring a physical checkout or repository-host rename.

The controlled-load foundation and public command now compose the managed
auxiliary lifecycle, verified worker sets, complete A1/B/A2 envelopes,
complete-only store, and schema-3 manifest-v5 ownership. The debugger path now
adds a bound phase manifest, a structured control protocol, bounded attempt
I/O, a supervised adapter, complete-only attempt envelopes, schema-3
manifest-v6 ownership, and a public debugger command with per-run summary
detail. Frequency protocols still need workload-bound adapters where
applicable. Historical Node
A/B/A and Node-by-warmup modes remain multi-workload experiments outside the
current schema.

## Use the generic diagnose campaign now

The high-level campaign milestone is implemented. The default
`wasm-churn-diagnose` recipe combines the reduced multi-phase workload and the
verified `yes-load` condition. Automatic planning intersects online CPUs with
the invoking allowance, preserves Linux hybrid classes and efficient-core
clusters when exposed, checks controller placement, covers every usable CPU in
the exact phase, and focuses A/B/A load on one deterministic or explicitly
selected target. The retained `node-pglite-diagnose` recipe repeats the same
generic protocol with the historical heavyweight workload.

Manifest v7 owns the five phase stores under one immutable experiment identity.
Resume validates both workload digests and every phase manifest before
continuing. Final reports keep correlated waves, descriptive child outcomes,
exact attempts, and the complete A/B/A session separate; other workload
failures remain outside the pass-plus-target rate denominator.

See [run a generic diagnostic campaign](guides/generic-diagnose-campaign.md)
for the default dry run, profiles, topology overrides, resume, and report
interpretation.

## Keep remaining extensions explicit

The v7 topology phases are intentionally condition-free; only the focused B
leg runs the auxiliary load. A loaded group or every-CPU sweep needs a new
bound protocol rather than an unrecorded switch. Generic telemetry and
frequency-control collection likewise remain separate work: telemetry needs a
workload-neutral association contract, while frequency changes remain
privileged and must preserve the historical recovery guarantees.

The v7 report does not claim to replace the legacy suite's telemetry, debugger
transcripts, frequency evidence, or privacy-review inventory. Historical
schema-1/schema-2 interpretation, Node A/B/A and warmup matrices, and the
privileged recovery namespace remain unchanged.

See the [optional roadmap](roadmap.md) for relative value and difficulty
ratings, distribution and AI-guidance options, implementation boundaries, and
the conditions that would justify each extension.
