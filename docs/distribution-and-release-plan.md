# Distribute reproducible reference tests

Status: implementation plan

This plan turns the existing Linux checkout-based harness into two bounded
distribution paths:

- a zero-install Linux reference kit for an official Ubuntu live session; and
- a Windows screening kit for comparing reports from similar machines without
  claiming operating-system parity.

The immediate investigation already has an approved motherboard RMA. The
distribution work is therefore justified by reproducibility and independent
comparison, not by a need to prolong the original diagnosis. Keep the work
small enough that the harness remains maintainable after the replacement.

## Define the outcome

An unfamiliar operator should be able to boot an official Ubuntu live image,
join a network, paste one transparent command, inspect the resolved plan, run
the reference experiment only after explicit confirmation, and leave with a
privacy-reviewable results archive.

A Windows operator should be able to unpack one ZIP, inspect an equivalent
screening plan, run the same pinned Node/PGlite target under a controlled
external-load A/B/A schedule, and produce a result bundle with enough runtime,
topology, and executable identity to compare with Linux evidence.

Success is standardized evidence from willing operators. Success is not a GUI,
a custom Linux distribution, automatic diagnosis, or a universal hardware
test.

## Preserve scope and safety boundaries

The distribution layer must retain these repository rules:

- Downloads, extraction, listing, inspection, and dry runs never imply consent
  to execute a live workload.
- Every live run requires a separate explicit confirmation.
- CI never runs PGlite, WebAssembly churn, native churn, GDB, or another live
  fault trigger. It uses deterministic fixtures and harmless command smoke
  checks only.
- The reference workload runs without root. Download and extraction refuse to
  run as root. Any future privileged operation remains a separate reviewed
  command.
- The kit does not change firmware, sysfs, turbo state, power policy, or the
  affinity of unrelated processes.
- Native `churn-mem` remains an advanced, separately warned experiment and is
  not included in the first public kit. No raw native workload binary appears
  in a convenience-command directory.
- Evidence records observations and associations. Reports do not diagnose a
  defective processor or motherboard automatically.
- No result is uploaded automatically and no cloud credentials are requested
  by the harness.

Defer a custom Ubuntu ISO, graphical UI, self-updater, automatic telemetry
submission, arbitrary-distribution support, and full Windows/Linux feature
parity until real operator demand justifies them.

## Freeze the reference runtime

Use two runtime roles in the Linux kit:

| Role | Initial version | Purpose |
| --- | --- | --- |
| Controller | Node 24.21.0 LTS | Supported runtime for orchestration and harmless tooling |
| Reference target | Node 25.2.1 | Frozen PGlite test specimen with the strongest measured repeatability |

The local 2026-09-09 live-Ubuntu sessions
`load-aba-20260909T144226Z` and `load-aba-20260909T145346Z` motivate that
choice. Node 22.22.1 produced one target `SIGSEGV` and four other WebAssembly
failures in 20 loaded attempts; Node 25.2.1 produced 18 target `SIGSEGV`
outcomes in 20 loaded attempts. Both sessions had clean no-induced-load legs.
The sessions were sequential rather than randomized, so they justify a
reproducible reference choice rather than a universal claim about either
runtime. Preserve those source bundles independently and publish a
privacy-reviewed summary before citing the counts as public evidence.

Node 25 is end-of-life. Keep it isolated under the kit directory, never add it
to the user's global `PATH`, and label it as an offline diagnostic specimen.
The controller and target archives, upstream URLs, sizes, and SHA-256 values
belong in a reviewed `packaging/runtime-lock.json`. CI must reject a changed
download rather than accept an unverified replacement.

The PGlite version remains locked to `0.5.4`. Production dependencies are
installed only while assembling the kit. The operator never runs `npm ci`.

The first public kit exposes one Linux launcher intention:

- `run-reference`: Node 24 controller, exact Node 25.2.1 target, PGlite 0.5.4.

Defer `run-system` and `compare-runtimes` until the reference path has been
used independently. When added, record the host executable and use the
existing seeded, reverse-paired Node matrix rather than two unbalanced
sequential comparisons.

Never substitute the host runtime when the reference runtime is absent or has
the wrong checksum.

## Publish bounded release artifacts

Every stable release should contain:

- `fault-affinity-live-linux-x64.tar.gz`
- `fault-affinity-screen-windows-x64.zip`, once the Windows milestone lands
- one `.sha256` file per downloadable artifact
- `SHA256SUMS`
- a software bill of materials
- GitHub build-provenance attestations where supported
- GitHub-generated source archives and release notes

Release asset names remain stable so GitHub's `releases/latest/download/...`
URL works. A stable release must first be resolved to one concrete tag; all
assets for that installation are then fetched from that tag rather than from
multiple `latest` requests. Prereleases are never the bootstrap's `latest`.
The version, tag, source commit, build platform, dependency lock, and component
checksums are stored inside each archive in `RELEASE.json`.

Each kit includes all applicable third-party notices and licences. Generated
diagnostic evidence, case-study captures, RMA material, research notes,
development fixtures, and repository history are excluded.

## Keep the Linux live kit simple

Validate official Ubuntu Desktop 26.04 LTS on x86-64 first because that is the
live environment used by the motivating 2026-09-09 sessions. Treat 24.04 LTS
as a compatibility target until it has an equivalent manual acceptance run.
Use a `.tar.gz` archive because `bash`, `wget`, `tar`, gzip, `sha256sum`,
`taskset`, and `yes` are present on both live images. The new reference
controller must record the resolved path, executable hash, and version output
where applicable for both `taskset` and `yes`; the legacy runner does not bind
all of those identities today.

The staged kit contains:

```text
fault-affinity/
  RELEASE.json
  README.txt
  LICENSES/
  bin/
    run-reference
  runtime/
    controller/
    reference/
  app/
    package.json
    package-lock.json
    node_modules/@electric-sql/pglite/...
    child.mjs
    src/reference-kit/...
    diagnose-lib/<explicit dependency closure>/...
  share/
    prepare-results
    UPLOAD-RESULTS.txt
```

Do not distribute `load-state-aba.mjs` unchanged as the public controller. It
preserves the motivating experiment but lacks the bounded attempt and cleanup
contract expected for unfamiliar operators. Add a distinct reference-kit
controller that reuses the established attempt supervisor and controlled-load
lifecycle where possible and publishes an explicitly versioned reference
profile. Historical output meaning remains unchanged.

Every target attempt has a recorded deadline, bounded `SIGTERM` then `SIGKILL`
escalation, descendant cleanup, and controller-death cleanup. A timeout or
cleanup failure is operational/incomplete evidence, never a target fault. The
verified load condition also has an outer safety deadline so a hung target
cannot retain load indefinitely. Exercise every lifecycle boundary with
harmless fixtures in CI.

The reference launcher uses paths relative to its own canonical directory and
requires a results root. It creates a private parent when needed but passes a
new, nonexistent child path to the controller. With no live flag it prints the
resolved A/B/A plan and exits. `--yes` remains required for execution.

Launch the controller and targets with a small reviewed environment rather
than inheriting arbitrary caller settings. Preserve only required identity,
locale, home, temporary-directory, and fixed system-path values; remove or
reject `NODE_OPTIONS`, `NODE_PATH`, dynamic-loader injection variables, and
conflicting target-runtime arguments. Bind the environment policy, release
profile, controller and target hashes, installed PGlite payload-tree hash,
Ubuntu release and kernel identity, tool identities, and every schedule timing
to the result.

Defaults `target=19`, `load=0-7`, and `runs=20` reproduce the case-study
protocol only when those CPUs are online and allowed. The launcher must print
that they are case-study defaults, validate them before execution, and accept
explicit overrides. It must not imply that CPU 19 is generally suspect.

This fixed profile is a known-target confirmation protocol, not the only
public entry point for a machine being investigated from scratch. Add a
separately versioned guided discovery flow before presenting the kit as a
general Windows-user diagnostic:

1. Run a bounded pinned Node 25.2.1/PGlite localization campaign across the
   usable CPUs, reusing the generic topology, supervision, and exact-phase
   machinery rather than creating another scheduler.
2. Report candidate CPUs descriptively using a prespecified ranking and
   deterministic tie-break. Say “highest observed fault rate,” never “bad CPU,”
   and produce no candidate when the valid evidence is insufficient.
3. Show the proposed controller, target, and topology-informed load CPUs, then
   require a fresh dry run and explicit operator confirmation.
4. Create a new, immutable A1/B/A2 result profile for that selected plan. Do
   not pool exploratory localization samples into the confirmatory comparison
   or silently launch A/B/A from the discovery result.

Keep the fixed CPU-19 profile available under its case-study identity for
pre/post-RMA and exact cross-machine comparisons. The adaptive flow must use a
different profile ID, record the discovery-bundle binding and selection rule,
and explain that different selected CPUs answer a broader screening question
than the fixed case-study protocol.

Omit the native C payload from the first public kit. The current
`repro-c-aba.sh` still depends on a host compiler and emits a simpler result,
while the raw `repro-c` binary can start a live workload immediately and also
exposes `churn-mem`. A later separately reviewed kit can give safe native modes
the same manifest, confirmation, lifecycle, and result-preparation path.

## Serve a transparent GitHub Pages bootstrap

Deploy a small static site from `site/` to GitHub Pages. Its primary endpoint
is:

```text
https://gadicc.github.io/fault-affinity/run
```

The documented command is:

```sh
wget -qO fault-affinity-run https://gadicc.github.io/fault-affinity/run &&
bash fault-affinity-run
```

Do not use a mutable third-party URL shortener and do not pipe network output
directly into a shell. Saving first prevents execution of an incomplete
transfer and gives the operator an obvious file they can inspect.

The bootstrap is deliberately small. Its trust anchor is HTTPS delivery from
the project's GitHub Pages and GitHub Release origins. A checksum obtained
from the same publisher detects corruption and accidental mismatch; it does
not independently protect against compromise of that publisher. It must:

1. Reject root, non-Linux hosts, and unsupported architectures.
2. Resolve `latest` once to a concrete stable tag or accept
   `--version vX.Y.Z`.
3. Download the archive and its checksum from that exact GitHub Release tag.
4. Verify the checksum before extraction.
5. Use a structured archive parser with explicit decompressed-size and member
   limits. Reject symlinks, hard links, absolute paths, canonical `..`
   traversal, duplicate canonical members, sparse or extended-header surprises,
   device files, sockets, unexpected modes, and an unexpected top-level layout
   before extracting. Do not parse human-readable `tar -t` output.
6. Extract into a new versioned directory owned by the invoking user.
7. Print the release, source commit, runtime identities, and next commands.
8. Run at most a harmless preflight/dry run; never append `--yes`.

The release URL is the authority for versioned assets. GitHub Pages only hosts
the landing page, bootstrap, safety summary, and links to source and releases.
A downloadable archive remains the offline fallback when networking does not
work in the live session.

## Make result preservation obvious

Before a live run, the launcher requires an explicit results root, checks
capacity, and identifies whether it appears to be volatile live-session
storage or a mounted persistent volume. Prefer a removable or otherwise
persistent destination. Refuse `/tmp`; prominently warn that an ordinary live
home directory can disappear on reboot or reset.

`prepare-results` initially accepts only the exact versioned reference-kit
output format. It rejects an active bundle, snapshots a completed or explicitly
interrupted bundle under the same execution lease, validates complete JSONL
prefixes, and records whether the archive is complete or interrupted. It
checks that the source is below the selected results root, inventories regular
files without following links, rejects special files, applies a fixed
format-specific file allowlist, and creates:

```text
fault-affinity-results-<UTC timestamp>.tar.gz
fault-affinity-results-<UTC timestamp>.tar.gz.sha256
```

It displays archive size, checksum, source directory, exact included-file
inventory, and a privacy checklist. It never deletes, redacts, or modifies the
integrity-bound original evidence. Core dumps and unrelated files are
excluded. Raw arguments, paths, process output, and error text can still carry
identifying or workload-supplied content; the tool promises an inventory and
operator review, not proof that arbitrary output is private. Unrecognized
bundle formats fail closed and require manual review.

After writing to persistent media, reread and verify the archive checksum. If
the only available destination is volatile, prepare and upload the archive
before reboot while clearly stating that stopping induced load does not prove
the unstable machine safe for credentials or file integrity.

Offer these handoff routes in order:

1. Copy the archive and checksum to another USB drive or mounted data volume,
   verify them on a stable machine, and upload from that machine.
2. When no practical persistent-media route exists, after the experiment has
   stopped open the Firefox browser supplied by the tested Ubuntu live image
   and upload to Google Drive, Dropbox, or another provider, then share a
   view-only link.
3. Attach a small archive to an email in Gmail or another provider; use cloud
   storage and a link when the archive is too large.
4. Add the archive or view-only link to the project's structured GitHub issue
   template.

The guide must say to close Firefox during the measured run, upload only after
the load workers have stopped, avoid logging into important accounts on a
machine the operator considers unstable when a USB alternative is available,
log out when finished, and shut down the live session. It must not describe
Firefox as bundled by this project. Browser history and credentials are
outside the bundle and must never be collected. No provider API or automatic
cloud integration belongs in the kit.

## Treat Windows as a screening protocol

The first Windows target is Windows 11 x86-64. The kit uses the same exact
Node 25.2.1 target, PGlite 0.5.4, attempt count, and A1/B/A2 meanings, but it is
reported as a Windows screening result rather than a Linux-equivalent result.

Replace `taskset` and `/proc` verification with a small native launcher that:

- creates the target process suspended;
- assigns it before resume to a non-breakaway Job Object owned by the
  controller, with kill-on-close cleanup;
- applies the requested processor affinity before user code executes;
- starts with one-processor-group machines, represents CPU identity as
  `(group, logical processor)`, and fails clearly on unsupported topology;
- resumes and supervises the target with a deadline;
- reports process identity, requested and observed process/thread affinity,
  job assignment, termination status, raw unsigned exit status, separately
  observed exception evidence, and cleanup; and
- provides bounded native load workers pinned away from the target.

A bundled Node 24 controller orchestrates the native helper and writes
newline-delimited records plus a Markdown summary. The CMD entry point invokes
that controller directly, prints a plan by default, and requires `--yes` for
live execution. Administrator rights should not be required. Windows Error
Reporting or minidumps are a separate opt-in milestone because they change
privacy and storage boundaries.

The Windows ZIP includes a one-click `run-reference.cmd` that does not depend
on PowerShell execution policy, displays the dry run, and tells the user the
exact `--yes` command. It must not start the live test merely because the file
was double-clicked. A public Windows release also needs a concrete Authenticode
signing or narrowly reviewed unblock path and a manual test of the actual
browser-download and Explorer-extraction flow with Mark of the Web. Do not
claim a double-click path works based only on checked-out CI files.

## Adopt a promotion release train

Use `dev` as the integration branch and protected `main` as the stable release
branch:

1. Feature branches merge into `dev` after safe CI.
2. A promotion pull request merges `dev` into `main` with a merge commit. Do
   not squash the promotion, because semantic-release must see the individual
   Conventional Commits introduced from `dev`.
3. A releasable push to `main` builds and publishes one immutable release.
4. A hotfix branches from `main`, merges to `main`, releases, and is then
   merged back into `dev` immediately.

Keep `main` as the GitHub default so casual clones receive stable code. Add a
required pull-request check that rejects ordinary `main` pull requests unless
their head repository is this repository and their head branch is `dev`, or
unless they match an explicitly allowed hotfix policy. Protect both branches,
require safe CI, disallow force pushes, and serialize main releases. Main
cannot require linear history while promotion merge commits are required.
Protect version tags and enable GitHub immutable releases before unattended
publication.

Configure pinned semantic-release and plugin versions with
`branches: ["main"]` and an explicit plugin list:

- commit analyzer;
- release-note generator;
- GitHub release publisher with the finalized assets.

Do not include the npm publisher while `private: true` remains. Do not add a
release-time commit back to protected `main`; tags and GitHub releases are the
version authority. Disable GitHub issue/PR success and failure comments,
labels, and closing behavior so the publisher needs only contents authority.

The private package now uses the non-authoritative `0.0.0-development` version,
and the reviewed `v0.0.0` baseline tag exists on the stable pre-distribution
commit without a user release. This keeps semantic-release from examining the
older history or starting at `v1.0.0`. The first `feat` promotion can create
`v0.1.0`. Document that a breaking-change commit can advance `0.x` to
`1.0.0`.

## Separate CI responsibilities

Retain or introduce these workflows:

### Safe validation

Run on pull requests and pushes to `dev` and `main`:

- locked dependency installation;
- all hermetic tests;
- shell and JavaScript syntax checks;
- native compilation without execution; and
- packaging metadata validation.

### Package snapshot

Run manually and on relevant `dev` changes:

- build staged Linux and Windows directories;
- download pinned runtimes and verify reviewed upstream checksums;
- install only locked production dependencies;
- compile native helpers on their target runners;
- test archive structure, permissions, checksums, runtime `--version`, help,
  and reference dry-run output; and
- pack each staged tree before Actions artifact upload so executable modes and
  symlink policy are explicit, then upload short-lived commit-SHA artifacts.

Do not execute a target workload as a packaging smoke test.

### Stable release

Run on pushes to `main` and as an explicitly recoverable manual dispatch:

1. Check out full history and run safe validation.
2. Build version-neutral platform staging archives in parallel with read-only repository
   permissions, preserving a strict executable-mode manifest.
3. Download and verify the staging artifacts in the privileged final Linux
   release job.
4. In that job, use semantic-release's JavaScript API in dry-run mode to
   compute either no release or one expected next version and commit. Its token
   has the push authority that semantic-release verifies even during dry run.
5. Inject the planned version and commit, build the final `.tar.gz` and `.zip`,
   generate checksums and SBOMs, verify final extraction and dry-run behavior,
   and retain the complete finalized artifact set as a workflow artifact.
6. Generate build-provenance attestations for the final bytes with
   `id-token: write` and `attestations: write` before publication.
7. Run semantic-release normally, require it to reproduce the planned version
   and commit, create the tag, and let the pinned GitHub plugin use its
   draft-upload-publish sequence for the already finalized assets.

Keep building and publishing in the same workflow. Tags created with the
default `GITHUB_TOKEN` do not normally trigger a second workflow. Give only the
final release job `contents: write`, `id-token: write`, and
`attestations: write`; all validation and staging jobs stay read-only. Use a
release concurrency group with cancellation disabled.

Define a separate, non-overwriting recovery state machine because
semantic-release creates the tag before publish plugins complete:

- no tag: rerun the normal release against the exact planned commit;
- tag exists, release absent: require the retained artifact set and matching
  digests, create a draft for that exact tag, upload, verify, then publish;
- matching draft exists: add only missing assets after verifying every existing
  asset digest, then publish;
- complete matching published release: report success without mutation; and
- conflicting tag, commit, published asset, or digest: stop for manual review.

Never replace already published bytes silently. Retain enough final artifacts
and metadata to recover within the documented retention window, and document
the deterministic reconstruction path after that window.

Before marking the recovery gate complete, run
`packaging/rehearse-release-recovery.mjs` against a newly created private
`fault-affinity-release-rehearsal-*` repository whose `main` points to the
exact staged commit. Preserve its `rehearsal.json` record and archive the
repository rather than deleting it. The record must show every expected
refusal and convergence path, the implementation commit, exact script and
stage hashes, published asset digests returned by GitHub, and the remote
repository and release IDs.
Failed rehearsals remain unarchived until their partial state is understood.

### GitHub Pages

Build `site/` on changes merged to `main`, upload it as a Pages artifact, and
deploy through the GitHub Pages environment. Test the bootstrap against local
fixture releases so CI never downloads and executes an unreviewed live script.
The deployment job needs the Pages environment plus `pages: write` and
`id-token: write`; those permissions do not belong to ordinary CI jobs.

## Capture the irreplaceable RMA boundary

Before replacing the motherboard, preserve at least one final complete
reference session with the current board using the already-reviewed command,
plus its machine, BIOS, microcode, runtime hashes, worker verification, and
telemetry. Prefer two or three complete sessions if time permits; do not change
the environment merely to increase the count.

After replacement:

1. Record the new motherboard and BIOS identity without publishing serial
   numbers.
2. Recreate the same firmware settings and live-Ubuntu version deliberately.
3. Run the exact same pinned Node 25.2.1 reference sessions.
4. Keep pre- and post-replacement sessions separate and compare complete
   experiments rather than pooled legs.
5. Publish only a privacy-reviewed derived comparison.

Do this evidence capture before spending the remaining pre-RMA time on release
automation. The old-board state cannot be recreated after return.

## Test adversarial and failure paths

Hermetic tests must cover:

- a missing, truncated, oversized, or checksum-mismatched download;
- HTTP redirects outside the allowed GitHub release origin;
- archive absolute paths, traversal, symlinks, hard links, duplicate names,
  devices, sockets, excessive member counts, and extraction races;
- running the bootstrap as root or on an unsupported architecture;
- an existing destination, read-only destination, low disk space, and an
  interrupted extraction;
- malformed or inconsistent `RELEASE.json`;
- a missing or replaced target runtime;
- dry-run launchers never forwarding live confirmation;
- result preparation encountering links, special files, unrecognized bundle
  versions, private-path warnings, or an interrupted archive write;
- Windows affinity requests crossing processor-group boundaries;
- load-worker startup, verification, early death, timeout, cancellation, and
  complete cleanup using harmless fixture processes; and
- staging transport that attempts to lose or broaden executable modes;
- a release with no releasable commits, a failed platform build, a version
  mismatch between plan and publish, and every tag/draft/published recovery
  state; and
- Windows controller death, Job Object assignment failure, attempted
  breakaway, child-created threads, and cleanup after timeout.

## Deliver in bounded milestones

### Milestone 0: preserve evidence and freeze decisions

- Preserve the existing pre-RMA source bundles and, if the old board is still
  available, capture one final reviewed session outside the checkout.
- Accept the runtime-role, delivery, branch, release, and upload decisions.
- Record the desired first public version.

Acceptance: the available old-board evidence is independently archived and
the plan has passed adversarial review. Do not make an additional live run a
release prerequisite if the hardware has already been replaced.

### Milestone 1: Linux kit and local packaging

- Add the bounded reference controller, reviewed environment, runtime lock,
  allowlist staging script, launcher, licences, release manifest template,
  exact-format result preparation, persistent-output guidance, upload
  instructions, and hermetic lifecycle and packaging tests.
- Produce a complete Linux kit locally and in a manual CI snapshot.

Acceptance: a clean Ubuntu 26.04 environment can extract the artifact, reach
the exact dry-run plan without Git, npm, a compiler, or root, and prepare and
independently verify an allowlisted share archive. Ubuntu 24.04 remains a
compatibility target until manually accepted.

Automate the first half against the pinned, unmodified Ubuntu Desktop ISO in a
local QEMU serial session: stock dependency discovery, candidate checksum and
safe extraction, bundled runtime/help checks, an ext4-backed dry run, and proof
that the dry run created no result content. This does not replace the manual
checks for GRUB and desktop startup, physical removable media, a deliberately
confirmed reference run, result preparation, or Windows-side transfer.

### Milestone 2: Pages bootstrap and first release

- Add the static Pages site and hardened downloader.
- Add release finalization, checksums, SBOM, provenance, semantic-release, and
  the main release workflow.
- Establish the reviewed `v0.0.0` baseline tag before enabling automation,
  create `dev`, then publish the first `v0.1.0` promotion release.

Acceptance: the documented two-command download reaches the verified v0.1.0
dry run from a fresh live session, and offline download remains available.

### Milestone 3: independent use and runtime comparison

- Collect feedback from the first independent Linux operators.
- Package the separately versioned discovery/localization flow and its reviewed
  handoff into a fresh confirmatory A/B/A plan before calling the kit a general
  start-from-scratch diagnostic.
- Add the optional host-runtime and reverse-paired comparison launchers only
  after the fixed reference path is understood.
- Publish a privacy-reviewed summary of the motivating local sessions and the
  pre/post-RMA comparison.

Acceptance: independent result bundles retain comparable reference identities,
and any comparison command preserves balanced scheduling and distinct
interpretation.

### Milestone 4: Windows screening kit

- Implement and test the suspended native affinity launcher, Job Object owner,
  and worker for one-processor-group systems.
- Add the Node controller, CMD entry point, evidence model, packaging job,
  signing or narrowly reviewed unblock path, and Windows interpretation guide.
- Add the ZIP to stable releases.

Acceptance: Windows CI verifies all lifecycle paths with harmless fixtures;
the actual downloaded and Explorer-extracted ZIP reaches its dry run on a
stock test system; and a manually authorized hardware session produces an
A1/B/A2 archive whose runtime and affinity identities can be compared without
calling it Linux parity.

### Milestone 5: demand-driven hardening

Only after independent use, consider multi-group Windows support, ARM64
artifacts, minidumps, a bundled Linux load worker, a custom domain, a native C
control kit, or a custom live image. Each is a separate compatibility and
maintenance decision.

## Stop conditions

Pause distribution expansion when any of these are true:

- operators do not use the Linux kit or request Windows comparison;
- maintaining bundled EOL Node creates disproportionate security or licensing
  risk;
- evidence cannot be made comparable without changing the existing schema and
  interpretation contracts; or
- the work starts requiring a custom operating system, broad installer, or
  automatic cloud-account integration without demonstrated demand.

The useful endpoint is a small, transparent reproduction kit that preserves
good evidence—not permanent feature parity across every platform.
