# Ubuntu 26.04.1 live-ISO acceptance evidence

The Ubuntu 26.04.1 live-ISO gate passed on 13 September 2026. The automated
QEMU/KVM run booted the pinned, unmodified live kernel, initrd, and filesystem.
It verified and safely extracted the candidate, checked both bundled runtimes,
and printed a guided discovery plan against a temporary ext4 disk. No
diagnostic or fault workload ran.

The candidate came from successful **Package snapshot**
[run 34767981609](https://github.com/gadicc/fault-affinity/actions/runs/34767981609):

- source commit: `297058c4e05b7e86c66fc3bacfeba01b3a64a47e`;
- artifact ID: `10321078790`;
- artifact name:
  `linux-x64-acceptance-297058c4e05b7e86c66fc3bacfeba01b3a64a47e`;
- artifact ZIP SHA-256 reported by GitHub:
  `f7b03b2f9b4578cdad2ec67c817099183c266c56f7ebeb65481ed2303652d8b1`;
- finalized kit archive SHA-256 inside the artifact:
  `d472769fd180f7e1ff2968a1a96d90ae44e8f5885fc65c657eaf4f298d5a0641`.

The raw structured result is
[`packaging/acceptance/live-iso-20260913.json`](../packaging/acceptance/live-iso-20260913.json).
It retains its original SHA-256,
`6e156892a0e3de4b9997f8a3cf5a57839607356a8b12640bfb036039a47414be`.
The run used four virtual CPUs, 4 GiB of memory, KVM acceleration, and QEMU
11.1.1. Only the QEMU child received a zero memlock limit through util-linux
`prlimit`; the host limit was unchanged. The ISO identity exactly matches
`packaging/live-iso-lock.json`.

The complete serial log was 117,242 bytes over 1,423 lines, with SHA-256
`a6cbc3484f0d38eba5fe211840ed675882ed14cfac55a440b15c66fe02d5a33e`.
It was not checked in because the boot stream includes ephemeral machine,
boot, process, and session identifiers. A deliberately small
[privacy-minimized transcript](../packaging/acceptance/live-iso-20260913-transcript.txt)
keeps the acceptance output and has SHA-256
`bb05f39f15d98fe6067bf01dd3bb3835a42cff9332bcd1bea4d352f0764f8e71`.
The 12 September evidence remains preserved as the earlier fixed-plan gate.

This gate covers the direct serial live-filesystem boundary, checksum and
extraction path, bundled runtime identity, launcher and result-preparer help,
and a guided discovery dry run on ext4. It does not cover GRUB, the GNOME
desktop, Firefox, physical USB boot behavior, networking, cloud upload
instructions, or a confirmed live workload. Those boundaries remain separate
manual checks.

This evidence completes only `ubuntu2604LiveAcceptance`. It does not enable a
release by itself; the checked-in readiness manifest requires every named gate.
