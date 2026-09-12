# Ubuntu 26.04.1 live-ISO acceptance evidence

The Ubuntu 26.04.1 live-ISO gate passed on 12 September 2026. The automated
QEMU/KVM run booted the pinned, unmodified live kernel, initrd, and filesystem.
It verified and safely extracted the candidate, checked both bundled runtimes,
and printed a reference plan against a temporary ext4 disk. No diagnostic or
fault workload ran.

The candidate came from successful **Package snapshot**
[run 34692764442](https://github.com/gadicc/fault-affinity/actions/runs/34692764442):

- source commit: `bccc35f2b40346b4eefa755eb5c4f0f2242714c8`;
- artifact ID: `10297481086`;
- artifact name:
  `linux-x64-acceptance-bccc35f2b40346b4eefa755eb5c4f0f2242714c8`;
- artifact ZIP SHA-256 reported by GitHub:
  `988044891e9900b9e5a4e48a3fb306505b1d1d042927e682d0983ab879b4abdd`;
- finalized kit archive SHA-256 inside the artifact:
  `bf112f514bd11720062199386e064f796e3b86b37d4b14539869623135c034ce`.

The raw structured result is
[`packaging/acceptance/live-iso-20260912.json`](../packaging/acceptance/live-iso-20260912.json).
It retains its original SHA-256,
`0d0c59df62bd54a17b812ca0b6d317c982c82f4c3982d25265c8c0ace98508c0`.
The run used four virtual CPUs, 4 GiB of memory, KVM acceleration, and QEMU
11.1.1. The ISO identity exactly matches `packaging/live-iso-lock.json`.

The complete serial log was 117,360 bytes over 1,417 lines, with SHA-256
`c454bcb297d6c3d0f23ceb413eda80296d3fde1f4e986b31c3162fb112d9fb24`.
It was not checked in because the boot stream includes ephemeral machine,
boot, process, and session identifiers. A deliberately small
[privacy-minimized transcript](../packaging/acceptance/live-iso-20260912-transcript.txt)
keeps the acceptance output and has SHA-256
`0fffca3d6915ff758a53dbb600123babd874d9a046203791bdfaee79fe8073a0`.

This gate covers the direct serial live-filesystem boundary, checksum and
extraction path, bundled runtime identity, launcher and result-preparer help,
and a dry run on ext4. It does not cover GRUB, the GNOME desktop, Firefox,
physical USB boot behavior, networking, cloud upload instructions, or a
confirmed live workload. Those boundaries remain separate manual checks.

This evidence completes only `ubuntu2604LiveAcceptance`. It does not enable a
release by itself; the checked-in readiness manifest requires every named gate.
