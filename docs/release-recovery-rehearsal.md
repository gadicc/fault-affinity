# Release-recovery rehearsal evidence

The release-recovery gate passed on 12 September 2026 against a real, private
GitHub repository. No diagnostic or fault workload ran.

The successful rehearsal used implementation commit
`a849a31404bffae77d86a26e739911f8328c4eeb` and the version-neutral Linux stage
from successful `main` stable-release workflow
[run 34693474646](https://github.com/gadicc/fault-affinity/actions/runs/34693474646):

- source commit: `71ba8613e00f9d78068a98bf7fa6d8f4e1719cc0`;
- artifact ID: `10298126533`;
- artifact name: `linux-x64-stage-71ba8613e00f9d78068a98bf7fa6d8f4e1719cc0`;
- downloaded stage SHA-256:
  `3a7c077ef536d191efeb7071d79db06d7f94e0d61963ca0e6f908a80e93a4542`.

The raw result is
[`packaging/acceptance/release-recovery-20260912.json`](../packaging/acceptance/release-recovery-20260912.json).
Its SHA-256 before check-in was
`aaa9fce89082d5cdfd6a967db3d5f0fb8ac8af91550f34e16b4e9fbba2c6c465`.
The successful private evidence repository,
`gadicc/fault-affinity-release-rehearsal-20260912-a849a31`, is archived rather
than deleted. Its numeric repository and release IDs are in the raw result.

Nine checks demonstrated missing-tag refusal, tag-without-release recovery,
complete-release inspection and idempotence, partial-draft discovery and
completion, conflicting-byte refusal, and published-incomplete refusal. Both
successful release paths contain all five expected assets with GitHub-provided
SHA-256 digests. The conflict remains an unmodified one-asset draft and the
published incomplete release remains empty.

An earlier disposable run safely stopped when GitHub accepted a draft asset
before the new draft became visible through either lookup route. That private
repository, `gadicc/fault-affinity-release-rehearsal-20260912-ed2e353`, was
inspected and archived. Commit `42beb67` made that visibility interval a
bounded retry while preserving exact size and digest checks; the successful
rehearsal above used the merged fix.

This evidence completes only `releaseRecoveryRehearsal`. Stable publication
remains disabled until every other readiness gate is separately demonstrated.
