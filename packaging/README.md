# Release packaging

These scripts build the version-neutral Linux kit and finalize immutable release
bytes. They never invoke the PGlite target, induced load, or a live diagnostic
run. Packaging smoke checks are limited to runtime `--version` and launcher
`--help` output.

`runtime-lock.json` pins the exact upstream Node archives, byte sizes, and
SHA-256 checksums. `linux-files.json` is the complete first-party source
allowlist; staging also verifies every relative JavaScript import and dynamic
worker path is represented by that list. The staged tree is transported as an
archive with `MODE-MANIFEST.json`, rather than as loose Actions artifact files.

The expected source entrypoints are:

- `src/reference-kit/controller.mjs`
- `src/reference-kit/discovery-cli.mjs`
- `src/reference-kit/discover-reference`
- `src/reference-kit/run-reference`
- `src/reference-kit/prepare-results.mjs`

To build a local version-neutral stage without running the diagnostic:

```sh
node packaging/stage-linux.mjs \
  --output-directory /new/output/directory \
  --runtime-cache /persistent/runtime/cache
```

Stable release finalization requires an exact semantic version, source commit,
and source commit timestamp. It replaces `RELEASE.template.json`, recomputes
component identities and the mode manifest, emits the stable archive name,
generates an SPDX SBOM, and writes individual and aggregate checksums.

`release.yml` computes the semantic-release plan only in its final privileged
job, retains the finalized bytes and plan before publication, attests those
bytes, and requires the publish invocation to reproduce the planned version and
commit. Its manual recovery mode accepts only an existing matching tag and the
exact retained artifact. Before the privileged recovery job starts, a read-only
gate verifies the user-selected artifact's server-side ID belongs to a completed
`main` run of this repository's exact stable-release workflow and source commit.
The run may have succeeded, failed, been cancelled, or timed out after retaining
the exact artifact; every repository, workflow, commit, artifact, size, and
expiry binding must still match. Recovery never overwrites a release asset.

Publication is controlled by `release-readiness.json`, which can enable it only
when every named gate is reviewed and true: the result-preparation lease,
Ubuntu 26.04 live acceptance, release-recovery rehearsal, and remote branch,
tag, environment, and immutable-release protections. The publish job still
runs only from protected `main` and waits for `stable-release` approval.

On `dev`, `package-snapshot.yml` turns the version-neutral stage into a
commit-bound `0.1.0-dev.<short-commit>` acceptance candidate. It verifies the
final checksums, safely extracts the archive, checks both bundled runtime
versions, and invokes only launcher help before uploading
`linux-x64-acceptance-<commit>`. The artifact is installable test input, not a
Git tag or GitHub Release, and it expires after seven days. It includes
`ACCEPTANCE.txt`, the bounded structured extractor, and checksums for those
acceptance-only support files, so using it does not require a repository clone.

From the successful **Package snapshot** run, download
`linux-x64-acceptance-<commit>.zip`. Replace only the first path below with the
downloaded ZIP:

```sh
(
  set -eu
  acceptance_zip="/path/to/linux-x64-acceptance-<commit>.zip"
  acceptance_files=$(mktemp -d)
  acceptance_kit=$(mktemp -d)
  unzip "$acceptance_zip" -d "$acceptance_files"
  (cd "$acceptance_files" && \
    sha256sum --check ACCEPTANCE-SUPPORT-SHA256SUMS && \
    sha256sum --check SHA256SUMS)
  python3 "$acceptance_files/safe-extract.py" \
    "$acceptance_files/fault-affinity-live-linux-x64.tar.gz" \
    "$acceptance_kit"
  "$acceptance_kit/fault-affinity/bin/discover-reference" \
    --results-root "$HOME" --target-cpus 3 --load-cpus 0-1
)
```

The block stops at the first failed command. Its last command is a dry run: it
validates the candidate and prints a plan without starting the workload.
The explicit four-CPU layout is an acceptance fixture, not a recommendation.
`mktemp` creates new, empty directories each time, so an earlier check cannot
contaminate a later one.

## Automate the Ubuntu live-image boundary locally

`live-iso-acceptance.mjs` boots the pinned, unmodified Ubuntu 26.04.1 Desktop
live filesystem in QEMU through its serial console. It attaches the unpacked
candidate as read-only ISO media and a fresh temporary ext4 results disk, then
checks the stock dependencies, both checksum sets, structured extraction,
bundled runtime versions, launcher help, result-preparer help, and a four-CPU
dry run that creates no result content. It never supplies live confirmation or
starts PGlite, WebAssembly churn, or load workers.

Install QEMU, xorriso, and e2fsprogs on the Linux host, then run from the
repository root with a new output path:

```sh
npm run acceptance:live-iso -- \
  --iso "$HOME/Downloads/ubuntu-26.04.1-desktop-amd64.iso" \
  --candidate-dir /path/to/unpacked/linux-x64-acceptance-commit \
  --output-dir /new/path/live-iso-acceptance
```

The runner verifies the ISO against `live-iso-lock.json`. It uses KVM when
available and otherwise falls back to slower TCG emulation. A successful run
writes `acceptance.json` and the complete `serial.log` to the output directory.
The direct serial boot exercises the exact kernel, initrd, and live filesystem,
but intentionally skips GRUB, GNOME, Firefox, physical USB behavior, and a
confirmed diagnostic run.

Keep this exact-ISO QEMU run as a local release acceptance gate for now. A
standard hosted job has little value on every push: the image is over 6 GB,
hosted disk is constrained, and nested acceleration is not a stable contract.
If repeated remote runs become useful, use a manually dispatched job on a
self-hosted KVM runner with the reviewed ISO already present.

The accepted 12 September 2026 run, exact snapshot artifact, and
privacy-minimized serial excerpt are recorded in
[the live-ISO acceptance evidence](../docs/live-iso-acceptance.md).

## Rehearse release recovery safely

Run the recovery state machine against GitHub before enabling stable releases.
Use a new private repository whose name begins
`fault-affinity-release-rehearsal-`; never point this command at the real
repository. The rehearsal refuses any repository that is public, archived,
has the wrong `main` commit, or already contains tags or releases. It repeats
the full repository name as an explicit confirmation and can archive the test
repository after a successful run.

Prepare an empty private repository, push the exact staged source commit to its
`main` branch, and download the version-neutral Linux stage from the matching
successful stable-release workflow run. Then run:

```sh
GH_TOKEN="$(gh auth token)" npm run rehearsal:release-recovery -- \
  --repository OWNER/fault-affinity-release-rehearsal-NAME \
  --confirm-disposable-repository OWNER/fault-affinity-release-rehearsal-NAME \
  --commit 40_HEX_STAGE_COMMIT \
  --implementation-commit 40_HEX_REHEARSAL_CODE_COMMIT \
  --stage /path/to/linux-x64-stage.tar.gz \
  --source-date-epoch COMMIT_TIMESTAMP_SECONDS \
  --output-directory /new/path/recovery-rehearsal-evidence \
  --archive-repository
```

The command creates only `0.0.0-rehearsal.*` prereleases. It exercises missing
tag refusal, recovery when the tag has no release, a partially uploaded draft,
conflicting retained bytes, a published incomplete release, and idempotent
completion. Existing assets are never replaced. On success it writes
`rehearsal.json` with the repository identity, implementation commit, script
and input hashes, checks, release IDs, asset sizes, and GitHub-provided digests.
After remote setup succeeds, a failure writes the partial record and leaves the
repository unarchived for inspection.

The accepted 12 September 2026 run and its exact source artifact are recorded
in [the release-recovery rehearsal evidence](../docs/release-recovery-rehearsal.md).

GitHub's release-by-tag endpoint exposes only published releases; authenticated
release listings include drafts for callers with push access. Recovery checks
the published endpoint first, searches bounded listing pages for a draft, and
then refreshes that draft by release ID while uploads settle. See GitHub's
[REST release documentation](https://docs.github.com/en/rest/releases/releases).

Repository settings verified on 12 September 2026:

- keep `main` as the default branch and protect `main` and `dev`;
- permit only reviewed `dev` promotion PRs and explicit hotfixes into `main`;
- disallow force pushes and do not require linear history on `main`;
- prevent existing `v*` tags from being moved or deleted while allowing the
  stable-release workflow to create a new version name;
- keep immutable GitHub Releases enabled;
- require review through the `stable-release` environment;
- make safe validation and promotion-policy checks required; and
- retain Actions artifacts and logs for 90 days, longer than the documented
  30-day release-recovery window.

The `v0.0.0` baseline is present remotely. The exact API readback, the
intentional new-tag creation tradeoff, and the settings that should trigger a
fresh review are recorded in
[the remote release-protection evidence](../docs/remote-release-protections.md).
