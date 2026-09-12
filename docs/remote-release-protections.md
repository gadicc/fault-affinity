# Remote release-protection evidence

The remote-protection gate passed on 12 September 2026. The normalized API
readback is in
[`packaging/acceptance/remote-protections-20260912.json`](../packaging/acceptance/remote-protections-20260912.json).
Its SHA-256 is
`1ff13c9ad2f1e8dee078054c9a8104c61571c9a435ede04cb4c92bb12a6695d4`.
It contains no tokens or private settings.

At the recorded check:

- `main` was the default branch, and both `main` and `dev` required an
  up-to-date pull request, safe validation, conversation resolution, and the
  same protections for administrators; force pushes and deletion were off;
- `main` additionally required the promotion-policy check and deliberately
  allowed merge commits for the `dev` promotion history;
- the `stable-release` environment accepted protected branches and required
  approval from `gadicc` before either publish or recovery could mutate a
  release;
- Actions artifact and log retention was 90 days, exceeding the release
  workflow's 30-day recovery window;
- the annotated `v0.0.0` baseline tag resolved to commit
  `b281a4cd5ac0065cf22c9fbd1db689d7e37ef782`;
- active ruleset `23068036` prevented every existing `v*` tag from being moved
  or deleted, with no bypass actor; and
- repository-level immutable releases were enabled.

## Why creation of a new version tag remains allowed

The stable workflow uses its short-lived GitHub Actions `GITHUB_TOKEN`.
GitHub rejected the built-in Actions app as a repository-ruleset bypass actor,
so restricting `v*` creation would also block semantic-release from creating
the next legitimate tag. The active ruleset therefore allows a new name but
forbids moving or deleting it once created.

At audit time, `gadicc` was the only direct writer. A stable release still
requires code to reach protected `main`, pass its two checks, run the reviewed
workflow from `main`, and receive environment approval. When the draft is
published, immutable releases permanently bind its tag and assets. Adding
another direct writer should trigger a review of this tradeoff.

GitHub's
[immutable-release guidance](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
recommends creating a draft, uploading all assets, and only then publishing it.
The pinned GitHub publisher and the recovery implementation both follow that
sequence. Published assets cannot be replaced or deleted, and their tag cannot
be moved or deleted while the release exists. The disposable recovery
rehearsal did not enable repository immutability, so an immutable-enabled
remote recovery remains a documented residual boundary rather than a claimed
test result.

Remote settings can change independently of Git history. Recheck this evidence
before a later release if administrators, workflows, branch protections,
environment reviewers, rulesets, or retention policy have changed.
