# v0.2.0 publication receipt

This receipt records the checks completed after publishing the immutable
[`v0.2.0` release](https://github.com/gadicc/fault-affinity/releases/tag/v0.2.0).
It is not part of the released archive.

## Identity

- Published: 2026-09-13 at 17:49:56 UTC
- Source commit: `d070fc10822a22516e6d70e32323842ba03bd727`
- Stable-release workflow: [run 34771968937](https://github.com/gadicc/fault-affinity/actions/runs/34771968937)
- Release state: stable, non-draft, and immutable
- Bundle identity: controller Node.js 24.21.0, reference Node.js 25.2.1,
  PGlite 0.5.4, `load-aba-reference` profile version 1

The tag, saved release plan, archive `RELEASE.json`, SBOM, and workflow head all
name the same version and source commit.

## Published assets

| Asset | SHA-256 |
| --- | --- |
| `fault-affinity-live-linux-x64.tar.gz` | `fbb8ed7f4e151541fec46e2bcf83722ff84cf4deb554223b70c29dc5395b56b2` |
| `fault-affinity-live-linux-x64.tar.gz.sha256` | `7fde236033107e7bf73a6c243083d6ed2619679f5bcccedb6d4db24ada861532` |
| `fault-affinity-sbom.spdx.json` | `2dfab376a523f4c8334176db84309884d692dc656f9d28d6873c0ea9d302b4f2` |
| `fault-affinity-sbom.spdx.json.sha256` | `757f85383680f0468c1ef1aff6dc6ec2237d55543e94d1dd6e36d9fc4a8f196d` |
| `SHA256SUMS` | `98b9544d10d6ef047a1675a29102d1715beb896efe107b3ed531ae65fed017a0` |

After a fresh download, `SHA256SUMS` passed and the archive passed bounded safe
extraction. GitHub build-provenance verification passed for all five assets
when constrained to this repository, `.github/workflows/release.yml`,
`refs/heads/main`, and the source commit above.

The retained artifact
`finalized-release-d070fc10822a22516e6d70e32323842ba03bd727` (artifact
`10322950589`) contains the same five published files, byte for byte, plus the
saved release plan. GitHub currently retains it until 2026-10-13.

## Public entry point

The deployed [landing page](https://gadicc.github.io/fault-affinity/) and
[`run` bootstrap](https://gadicc.github.io/fault-affinity/run) matched their
source files byte for byte. GitHub's latest stable release endpoint resolved to
`v0.2.0` and its exact five assets.

## Validation boundary

The [QEMU acceptance record](live-iso-acceptance.md) covers candidate
`297058c`, not the exact final release bytes. Later changes were reviewed and
tested with harmless fixtures; the final promoted tree matches the approved
`0d33bd1` candidate. Physical USB, GNOME, Firefox or cloud-upload interaction,
affected-machine reproduction, power-loss durability, and remote recovery of
an immutable release were not exercised and are not claimed here.

No diagnostic, discovery, confirmation, stress, or fault workload ran during
post-publication verification.
