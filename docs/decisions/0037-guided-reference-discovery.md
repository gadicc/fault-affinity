# Architecture decision 0037: Add guided reference discovery and confirmation

Status: Accepted

## Context

The Linux release kit currently publishes one empirically validated
Node 25.2.1/PGlite 0.5.4 A1/B/A2 profile. Its CPU 19 target and CPU 0-7 load
set reproduce the motivating case-study layout; they are not sensible defaults
for an unfamiliar computer.

The repository has two broader diagnostic paths, but neither can simply become
the kit's first-run command:

- `diagnose` includes concurrent PGlite phases that can multiply the roughly
  1.2 GiB-per-child memory demand, and its controlled-load phase uses a target
  selected before the measurements; and
- `loaded-discover` already provides complete-only A1/B/A2 sessions, verified
  load workers, deterministic target ordering, resume, and collection reports,
  but its public version is bound to the `wasm-churn-aba` recipe and its current
  ranking accepts incomplete resolved denominators.

Windows users reaching the project through an Ubuntu live boot need a narrow,
safe route that answers “which CPU should I examine next?” without changing
the known reference trigger or claiming that a short screen diagnoses faulty
hardware.

## Decision

Add a separately versioned `reference-loaded-discovery-v1` protocol and a
`load-aba-discovered-confirmation` version 1 profile. Keep
`load-aba-reference` version 1 unchanged and runnable under its current
command.

The packaged public commands will be:

```text
bin/discover-reference
bin/confirm-reference --from-discovery DIR
bin/run-reference
```

Each command prints a dry run by default. A measured process or load worker can
start only after a later invocation with `--yes`. Discovery completion prints
only a complete `confirm-reference ... --dry-run` command; it never starts the
confirmation automatically.

### Reuse the loaded-session implementation

`discover-reference` is a narrow admission, planning, orchestration, and
reporting layer. It reuses the existing controlled-load session runner,
supervised attempt lifecycle, managed worker set, process-group cleanup,
schema-3 manifest-v5 child bundles, exclusive leases, and complete-only
publication. It must not implement a second attempt scheduler or call the full
`diagnose` campaign.

One measured Node/PGlite process runs at a time. One target's A1, B, worker
cleanup, recovery, and A2 form a single complete-only child session. If that
session is interrupted before its envelope commits, its samples are never
pooled with later samples. The collection retains a bounded, durable
non-evidence execution-history record with the attempt generation, target,
boot binding, start and stop times, final stage, and owner result.

History is stored as at most 64 no-clobber start/terminal record pairs. The
start record is durable before the session-owner process can spawn; its
terminal record is durable after that process is reaped. A start without a
terminal record therefore preserves an abrupt interruption. Reaching the
limit refuses another live attempt but never removes old records.

An execution attempt that reached child-session ownership but did not commit
makes that collection permanently selection-ineligible. Resume may finish
untouched targets for preservation and comparison, but it cannot turn that
collection into a confirmation source. The operator must start a new complete
screen for candidate selection. Existing armed breadcrumbs remain additional
interruption context, not outcome evidence.

The generic `loaded-target-screen-v1` plan, recipe, report, CLI, and readers
retain their meanings. Shared orchestration may be extracted behind both
protocols, but the reference protocol gets distinct parsers, filenames,
identities, and report interpretation.

### Freeze the measured identity

The discovery target is the same measured specimen as the reference profile:

- controller runtime: Node 24.21.0 from the kit;
- target runtime: Node 25.2.1 from the kit;
- workload: the packaged `child.mjs` PGlite lifecycle;
- PGlite: 0.5.4 from the packaged production tree;
- target outcomes: `SIGSEGV` as `target-fault`, with no mapped exits; and
- attempt deadline: 120 seconds, then 1-second TERM and 2-second KILL grace.

Discovery and adaptive confirmation use the same
`reference-guided-yes-load` version 1 condition identity: one verified
`/usr/bin/yes` process per load CPU, the kit root as its working directory, the
same reviewed clean environment as the measured target, `survive-window`
semantics with a one-hour outer deadline, and 1-second TERM followed by
2-second KILL cleanup. The controller bounds the requested loaded window below
that deadline and verifies every worker stopped before recovery or publication.
The launcher remains `/usr/bin/yes`; its identity records the canonical target.
Version 1 permits the direct `/usr/bin/yes` target and Ubuntu 26.04.1's reviewed
`/usr/lib/cargo/bin/coreutils/yes` target, and binds the exact bytes in either
case.

The discovery protocol is new and has not inherited the case study's measured
reproduction rate. Documentation must distinguish “same frozen measured
specimen” from “empirically validated discovery protocol.”

Before planning, before every child session, on resume, and before report or
confirmation derivation, the controller verifies the release declaration
against both runtime binaries and the complete packaged app and PGlite trees.
The child schema-3 workload identities additionally bind the measured and
condition executables, launch environment, child file, schedules, and outcome
mapping. Hashing `RELEASE.json` alone is not sufficient verification.

The shell launchers retain the reference kit's non-root, Linux x86-64,
injection-variable rejection, fixed system `PATH`, and reviewed clean
environment policy. The target runtime remains isolated inside the kit and is
never added to the user's `PATH`.

### Plan CPU roles conservatively

A fresh plan intersects online CPUs, the process affinity allowance, and the
effective cgroup CPU set. It binds the resulting usable set and the topology
records used to distinguish physical cores and hybrid classes.

Automatic planning is available only when Linux exposes a complete,
non-overlapping P-core/E-core classification covering every usable CPU and
physical-core records are complete for every planned role:

- every usable E-core logical CPU is a target;
- every usable P-core logical CPU is a fixed load worker;
- each target gets a deterministic controller CPU outside the current target's
  physical core and every load-worker physical core; another planned target
  may act as controller while it is otherwise idle; and
- for each seeded target ordinal, the lowest usable logical CPU represents
  each eligible controller physical core. Representatives are ordered by the
  same seed with a separate `controller` domain, and `(ordinal - 1)` modulo the
  list length chooses the controller. This rotates deterministically through
  remaining eligible E-core physical cores. The report records the rotation
  as a possible confound.

Every version-1 plan, including an explicit or resumed plan, refuses more than
32 targets or 64 load workers, missing or inconsistent physical-core data, a
target whose physical-core siblings overlap a concurrent role, or any session
without an independent controller core. Overlapping observed class masks are
always invalid.

Class discovery records exactly one of:

- `sysfs-hybrid`, with nonempty, disjoint P-core and E-core masks whose union is
  the usable set;
- `unavailable`, with empty masks when neither Linux class source exists; or
- `partial`, with the exact non-overlapping observed masks when the sources do
  not establish a complete classification.

Only `sysfs-hybrid` permits automatic role selection. Missing hybrid sysfs
files mean “classification unavailable,” not proof of uniform hardware.

Uniform, unavailable, partial, or unusual systems require explicit target and
load CPU sets for version 1. Their plan binds the recorded class state without
using it to infer roles; complete physical-core data remains mandatory. The
planner still validates every role and chooses only an independent controller.
It never rotates the load set silently. A later protocol may define a balanced
uniform-topology design.

The immutable plan binds the usable set, class and physical-core topology,
target order, fixed load set, controller per target, taskset identity,
schedule, release identity, workload identities, resource observation, and
interpretation version. Resume refuses changed affinity, topology, binaries,
files, or plan fields.

### Bound schedule and resource use

Version 1 publishes one `quick` schedule and no timing overrides: three
attempts in each A1/B/A2 leg, a 5-second recovery, seed 17, no load warm-up,
and the fixed attempt and cleanup deadlines above. Target order is the existing
SHA-256-seeded order. Dry run prints the target order, each controller, the
fixed load set, measured concurrency of one, schedule totals, disk destination,
observed memory headroom, and the worst-case duration derived from every
attempt and grace deadline.

The controller reads `MemAvailable` and, when present, cgroup memory current
and maximum. Live execution requires at least 2 GiB of effective observed
headroom. An unlimited or unavailable cgroup limit is recorded rather than
invented. Ordinary allocation failures, `SIGKILL`, timeouts, load-worker
failures, and invalid evidence remain visible operational or other failures;
they are never reclassified as a target fault. Output excerpts, artifacts,
worker counts, attempts, and collection size retain their existing hard
bounds.

These checks reduce avoidable resource failures. They cannot make a known
unstable machine safe from a hang or reboot.

### Require complete usable evidence before ranking

For every target and every leg, a usable sample is exactly a committed valid
`pass`, `target-fault`, or `corruption` outcome. A row is ranking-eligible only
when all three legs contain exactly the planned number of usable samples and
no other or operational-invalid outcome. The collection is selection-eligible
only when every planned row is ranking-eligible.

An incomplete or selection-ineligible collection reports every exclusion and
produces no candidate. A complete eligible all-pass collection also produces
no candidate.

When at least one B leg contains a target outcome, rank eligible rows by the
highest B-leg target-fault-plus-corruption count, then the lowest logical CPU
number. Every eligible row has the same planned usable denominator, so this is
also the highest B-leg observed fault rate.

The report calls the first row the “highest observed fault-rate candidate.” It
keeps A1, B, and A2 separate, shows other and invalid outcomes, and states that
the ranking is descriptive: it is neither a significance result, a causal
claim, nor a declaration of a “bad CPU.” Discovery samples are never included
in the later confirmation comparison.

Report publication is complete-marker-last and no-clobber. A read-only report
path rereads every authoritative child bundle, re-verifies identities, derives
the report, and reconciles any published report bytes. A user-editable summary
file is never the evidence authority.

### Bind a fresh confirmation

`confirm-reference --from-discovery DIR` accepts only a complete,
selection-eligible discovery collection with a non-null candidate. It
authoritatively rederives the candidate and refuses a supplied CPU override.
The dry run shows the selected target, fixed discovery load set, independent
controller, source bundle binding, storage, and complete command needed for a
separate `--yes` invocation.

The `load-aba-discovered-confirmation` version 1 profile uses fresh A1/B/A2
samples: 20 attempts per leg, a 15-second initial settle, no load warm-up, a
15-second recovery, and the same attempt and cleanup deadlines as the fixed
reference profile. Its result binds:

- the verified discovery plan and interpretation version;
- canonical hashes of every authoritative child manifest and committed
  controlled-load envelope used to derive the report;
- the recomputed report bytes and deterministic selection rule;
- selected controller, target, and load CPUs;
- the complete release, host, topology, storage, workload, schedule, and
  cleanup identities; and
- a distinct result-format and profile version.

Confirmation must run on the discovery collection's bound boot and host. It
revalidates the boot-ID digest, release and canonical path, kernel, usable CPU
allowance, class and physical-core topology, and microcode before dry run and
again before live execution. A copied collection, changed boot, or merely
same-shaped CPU topology cannot authorize confirmation. Its result and summary
do not incorporate the discovery attempt counts.

### Resume, storage, and export

The collection plan is written before live execution and never replaced.
Completed target sessions are reused. An untouched target can run later in the
same boot, but a failed or interrupted execution generation remains in history
and permanently prevents candidate selection from that collection. One
collection lease prevents overlapping discovery or report writers, while each
schema-3 child retains its own lease.

Version 1 binds a SHA-256 digest of Linux's per-boot ID and does not support
cross-boot or cross-machine resume. Before each session it also revalidates the
exact release, canonical installation path, kernel, usable CPU allowance,
class and physical-core topology, and recorded microcode values. A boot-ID
change refuses further execution even if the same release and CPU model are
present. Current power-policy observations are recorded as context but cannot
guarantee stable operating conditions.

After reboot, the operator preserves and exports the partial collection, then
starts a new complete screen. Relocation is also refused because current
workload identities bind canonical paths.

Active collections and confirmations require the same private Unix filesystem
semantics as the existing reference result. The existing `prepare-results`
front door gains format-specific readers without changing the fixed-result
reader's accepted format. It safely takes the relevant lease, verifies that no
worker or owner is active, shows a bounded inventory and privacy warning, and
writes an archive plus adjacent SHA-256 file to a Windows-readable drive or
upload staging directory.

Completed discoveries and adaptive confirmations are exportable. A failed,
interrupted, or cross-boot partial discovery is also exportable with
conspicuous `incomplete-non-selection-evidence` status and its execution
history; the exporter never invents missing outcomes or a candidate.

### Package and present one approachable route

The Linux archive contains the full statically declared runtime module closure
for the two new commands and their report/export readers. Fixture-only code
stays in the separate packaging test harness. The release manifest names all
three immutable profiles and continues to bind the complete app tree.

For a new machine, the bootstrap prints a `discover-reference ... --dry-run`
quick start. The fixed CPU-19 command remains documented under an exact
case-study comparison section. Help and the live-kit guide explain that:

- QEMU validates packaging and controls but cannot validate physical-CPU
  localization;
- the screen can miss intermittent faults and can itself provoke instability;
- automatic version-1 discovery covers supported hybrid layouts, not every PC;
- “no candidate” is a valid result, not a clean bill of hardware health; and
- users should save or upload the prepared archive before leaving the live
  session.

## Acceptance

Implementation is complete only when all of the following hold:

- regression fixtures prove that `load-aba-reference` version 1, its Node and
  PGlite pins, CPU defaults, schedule, invocation, and evidence reader did not
  change;
- topology fixtures cover complete hybrid data, unavailable and partial class
  data, uniform hardware recorded as class-unavailable, SMT siblings,
  restricted affinity, offline CPUs, changed topology on resume, one eligible
  target, and insufficient independent role CPUs;
- report fixtures cover all-pass, one target outcome, deterministic ties, no
  usable evidence, other failures, operational-invalid attempts, incomplete
  collections, failed attempt then successful retry, permanent
  selection-ineligibility after that retry, and tampered derived summaries;
- tampering with either runtime, `child.mjs`, PGlite, the release declaration,
  packaged app tree, plan, child bundle, or bound confirmation source fails
  before measured execution;
- dry runs create no result bundle and launch neither measured targets nor
  load workers;
- fixture interruption tests cover A1, worker startup, B, worker stop,
  recovery, A2, child commit, and collection report publication, including
  cleanup and whole-session resume;
- concurrent ownership cannot launch overlapping sessions;
- the extracted kit works offline and in paths containing spaces without npm,
  Git, a compiler, network access, or a system Node installation;
- packaged smoke tests cover help, planning, report, export, resume, and the
  printed confirmation dry run under the bundled controller runtime; and
- confirmation fixtures reject a changed boot and a same-topology collection
  copied from a different host; and
- no automated test launches the real PGlite trigger or a sustained load
  worker. Affected-system reproduction remains a separately authorized manual
  validation.

An Ubuntu ISO acceptance run verifies extraction, help, dry runs, archive
preparation fixtures, and desktop instructions. It does not establish the
physical diagnostic behavior and does not replace a manual bare-metal guide
walkthrough.

## Rejected alternatives

- **Package the complete `diagnose` command.** Its concurrent heavyweight
  phases add material memory risk and its focused-load target is selected too
  early.
- **Run an isolated exact-CPU sweep and call the top row confirmed.** It would
  not screen the load-sensitive condition that motivated the next A/B/A step.
- **Modify `load-aba-reference` in place.** That would erase the identity of an
  empirically validated trigger and make old and adaptive results ambiguous.
- **Automatically screen unknown or uniform topology.** Rotating target, load,
  and controller roles changes the experimental condition and needs a separate
  balanced protocol.
- **Automatically start confirmation.** Selection and confirmation must use
  separate evidence, with a fresh human-reviewed live boundary.

## Consequences

- Supported hybrid machines get an approachable from-scratch path using the
  exact frozen Node/PGlite specimen in the release kit.
- The first protocol is intentionally conservative: some machines require an
  explicit reviewed plan or remain unsupported.
- A full quick screen can still take hours in the deadline worst case, although
  normal successful PGlite attempts are typically much shorter. Dry run makes
  that bound visible before consent.
- Two new result identities and an exporter increase packaging and fixture
  work, but fixed case-study evidence remains unambiguous and unchanged.
- The native C route, uniform-topology automatic discovery, relocation-safe
  resume, statistical stopping rules, and an affected-system reproduction-rate
  claim remain later, separately reviewed work.
