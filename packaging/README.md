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
It never overwrites a release asset.

Publication is currently gated off by `release-readiness.json`. Enable it only
when every named gate is reviewed and true: the result-preparation lease,
Ubuntu 26.04 live acceptance, release-recovery rehearsal, and remote branch,
tag, environment, and immutable-release protections. Snapshot builds, archive
validation, and dry-run/help smoke checks remain available while publication
is disabled.

On `dev`, `package-snapshot.yml` turns the version-neutral stage into a
commit-bound `0.1.0-dev.<short-commit>` acceptance candidate. It verifies the
final checksums, safely extracts the archive, checks both bundled runtime
versions, and invokes only launcher help before uploading
`linux-x64-acceptance-<commit>`. The artifact is installable test input, not a
Git tag or GitHub Release, and it expires after seven days. Download its ZIP,
extract the contained release files, verify `SHA256SUMS`, then use the Linux
archive for installed-system or offline live-session acceptance.

Repository settings still required outside the tree:

- keep `main` as the default branch and protect `main` and `dev`;
- permit only reviewed `dev` promotion PRs and explicit hotfixes into `main`;
- disallow force pushes and do not require linear history on `main`;
- protect `v*` tags while allowing the stable-release workflow to create them;
- enable immutable GitHub Releases;
- configure the `stable-release` environment and its reviewer policy;
- make safe validation and promotion-policy checks required; and
- keep Actions artifact retention at least as long as the documented 30-day
  release-recovery window.

The local `v0.0.0` baseline must be pushed and the above settings must be in
place before enabling unattended publication. Rehearse the no-release, normal
publish, tag-without-release, matching-draft, published-complete, and conflict
states in a disposable repository first.
