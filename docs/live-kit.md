# Test a Windows PC with the Ubuntu live kit

This guide is mainly for Windows users who want to run the same pinned
Node/PGlite comparison in a known Linux environment. It does not install
Ubuntu, Node, npm, Git, or a compiler on the computer.

Already using Linux? You normally do not need a live USB. Run the harness
directly from a repository checkout as described in the
[repository setup instructions](../README.md#quick-start), or use the release
kit from your existing Linux session.

The validated live target is Ubuntu Desktop 26.04.1 LTS on an Intel or AMD
64-bit computer. Use only a stable kit shown on the
[Releases page](https://github.com/gadicc/fault-affinity/releases).

## Start here

### 1. Make the Ubuntu USB on Windows

Use an empty USB drive of at least 8 GB. Creating the boot drive erases it, so
check the selected drive carefully and back up its files first.

1. Download **Ubuntu Desktop 26.04.1 LTS for Intel or AMD 64-bit** from
   [Ubuntu's official download page](https://ubuntu.com/download/desktop).
2. Follow Ubuntu's
   [Windows USB guide](https://ubuntu.com/desktop/docs/en/latest/how-to/create-a-bootable-usb-stick/#on-windows)
   to write the ISO. Copying the ISO file onto the USB is not enough.
3. Restart the computer and choose the USB from its boot menu. Try **F12**, or
   check the manufacturer's instructions for its boot-menu key.
4. Choose **Try Ubuntu**, not **Install Ubuntu**.

### 2. Download and preview the kit

Connect to the internet, open **Terminal** from the application menu (or press
**Ctrl+Alt+T**), and paste these commands one line at a time:

```sh
wget -qO fault-affinity-run https://gadicc.github.io/fault-affinity/run
less fault-affinity-run
bash fault-affinity-run
```

Use the arrow keys to inspect the downloaded bootstrap, then press **q** to
leave `less`. The last command verifies and extracts the latest stable kit. It
does not start a test.

When extraction finishes, copy the **safe preview** command it prints. That
command includes `--dry-run`: it only displays the plan and creates no result
bundle. Do not add `--yes` yet.

### 3. Choose where results will go

Read [Save the results](#save-the-results) before starting a confirmed run. You
can keep the active result in the temporary Ubuntu home directory. Copy the
prepared archive to a Windows-readable USB or upload it before shutting down.

## Why a real live boot is needed

This test observes a workload pinned to logical CPUs on the physical machine.
A virtual machine exposes guest **virtual CPUs**. QEMU can expose the host CPU
feature set, and libvirt can pin each vCPU thread to a chosen host CPU, but the
guest still runs through a hypervisor with virtual topology, scheduling, and
timing. That is useful for checking the kit, as the local QEMU acceptance test
does, but it is not a reliable substitute for a hardware result from the same
physical CPU. See the official [QEMU CPU overview](https://qemu.readthedocs.io/en/master/system/introduction.html#options-overview)
and [libvirt CPU pinning documentation](https://libvirt.org/formatdomain.html#cpu-tuning).

Docker does not make the Windows route equivalent either. Docker Desktop runs
Linux containers through a WSL 2, Hyper-V, or Docker VMM backend; these are
virtualized Linux environments. `--cpuset-cpus` constrains the CPUs available
to a container, but on Windows those are CPUs exposed through that backend,
not a bare-metal Ubuntu test. See Docker's
[Windows backend documentation](https://docs.docker.com/desktop/setup/install/windows-install/)
and [`--cpuset-cpus` reference](https://docs.docker.com/reference/cli/docker/container/create/).

On native Linux, containers share the host kernel and CPU affinity can map to
host CPUs, but a container adds cgroup and runtime constraints without making
this harness easier. Run it directly on Linux instead.

## Know what the commands run

`bash fault-affinity-run` is only an installer. It:

- resolves one exact stable GitHub Release;
- downloads its Linux archive and checksum;
- verifies and safely extracts it; and
- prints a harmless `run-reference ... --dry-run` command.

The actual workload starts only when you later run the generated command with
`--yes`.

Release v0.1.0 contains the fixed `load-aba-reference` profile: Node 25.2.1 and
PGlite 0.5.4, with A1 without induced load, B under induced load, and A2 after
recovery. Its case-study defaults are target CPU 19, load CPUs 0–7, and 20
attempts per leg.

CPU 19 was relevant on the motivating machine; it is not a general prediction
for another computer. If that layout is unavailable, the bootstrap prints a
compatible dry-run example using CPUs that exist, clearly marked **not a target
recommendation**. The kit does not yet run the repository's `diagnose` or
`loaded-discover` workflow. A separately versioned discovery kit is the next
step before this can be called a general start-from-scratch diagnostic.

## Save the results

An ordinary Ubuntu live home directory can disappear at shutdown or reboot.
Choose a result route before the confirmed run:

| Route | Active raw result | Survives a reboot? | Best for |
| --- | --- | --- | --- |
| Windows-readable USB | Ubuntu `$HOME`, then prepare onto the mounted USB | Only after preparation | Direct transfer back to Windows |
| ext4 USB or internal Linux partition | The mounted Linux filesystem | Yes | A machine that may hang or reboot |
| Firefox upload | Ubuntu `$HOME`, then prepare and upload | Only after upload | No suitable second drive |

### Transfer back to Windows with a normal USB

If Ubuntu's **Files** application can mount an existing FAT, exFAT, or NTFS
drive, it can hold the final `.tar.gz` and `.sha256` files. The active raw
result cannot live there: it needs Unix ownership, private permissions, and
advisory locks.

Run the active test under `$HOME`, prepare its result onto the mounted drive,
and do both before shutting down. If the machine reboots during the test, the
unprepared raw result may be lost.

### Keep raw results across a reboot with ext4

An ext4-formatted second USB or an existing mounted Linux partition can hold
the active raw result and its progress journal. This is safer when a hang or
reboot is plausible. Do not format or repartition a drive during this guide;
that would erase it.

To see drive labels, filesystems, and mount locations:

```sh
lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS
```

Ubuntu commonly mounts removable drives below
`/media/ubuntu/<volume-name>`. Identify a drive by its label, size, and
filesystem rather than copying an example path literally.

### No second drive: upload after the test

You can keep the active result under `$HOME`, prepare the sharing files there,
then use Ubuntu's included Firefox to upload both files to Google Drive,
Dropbox, Gmail, or another service. Do this only after the controller says all
load workers have stopped, and before shutting down.

An unstable machine may corrupt a file or expose credentials. Prefer a USB
when practical, avoid an important account, use a restricted link rather than
a public one, and verify the downloaded checksum later on a stable computer.

## Run the fixed reference comparison

The bootstrap prints a dry-run command compatible with the CPUs visible on
that machine. It is a preview, not a target recommendation. Use that exact
command to inspect the plan. For example, the case-study layout is:

```sh
cd fault-affinity-v0.1.0
./bin/run-reference \
  --results-root "$HOME" \
  --dry-run \
  --controller-cpu 8 \
  --target-cpu 19 \
  --load-cpus 0,1,2,3,4,5,6,7
```

Use the directory name printed by the bootstrap rather than assuming v0.1.0,
and replace `$HOME` with an ext4 mount path if you chose durable raw storage.
The dry run checks the release, runtime hashes, CPU sets, schedule, capacity,
and output location.

With persistent Unix storage, the plan prints a complete command ending in
`--yes`. Copy that command. With `$HOME`, it suppresses the command because a
reboot can erase the result. If you accept that risk and have chosen the CPUs
deliberately, edit the preview command only by replacing `--dry-run` with
`--yes`. Do not confirm a compatibility preview as if it recommended a target.

Before running it, save unrelated work, use AC power, disconnect unneeded
storage, close Firefox and other applications, and leave the terminal open.
The confirmed workload deliberately creates sustained work and may expose a
hang or reboot. It does not need root; never use `sudo`.

A timeout, cleanup problem, reboot, or interruption is operational/incomplete
evidence, not automatically a target fault.

## Prepare and verify the result

Wait for the controller to finish and report that all load workers stopped.
It prints the result bundle path. Create a shareable archive with:

```sh
./share/prepare-results \
  --results-root "$HOME" \
  --bundle "$HOME/reference-20260913T120000Z" \
  --destination "/media/ubuntu/SHARE"
```

Replace the example timestamp and paths with those printed for your run. For
an ext4 raw result, use that same mount as `--results-root`. The destination
can be a different directory or a mounted Windows-readable USB. For a Firefox
upload, a directory outside the result bundle, such as `$HOME`, can be the
destination.

The preparer accepts only a finished versioned result, displays its file
inventory and privacy warning, and creates:

```text
fault-affinity-results-<UTC timestamp>.tar.gz
fault-affinity-results-<UTC timestamp>.tar.gz.sha256
```

It does not upload, delete, redact, or repair the raw result. Review the
inventory before sharing; output can contain paths, arguments, error text, or
other identifying content. Do not publish credentials, account names, serial
numbers, unrelated logs, core dumps, or browser data.

Change to the archive destination, then verify both files before ejecting the
drive or uploading. For the USB example:

```sh
cd "/media/ubuntu/SHARE"
sha256sum -c fault-affinity-results-20260913T120000Z.tar.gz.sha256
sync
```

Use `cd "$HOME"` instead if that was your upload destination. Replace the
example timestamp with the filename printed by the preparer. On a stable
Windows computer, open PowerShell in the folder containing both files. Compare
the same values with:

```powershell
Get-FileHash -Algorithm SHA256 .\fault-affinity-results-20260913T120000Z.tar.gz
Get-Content .\fault-affinity-results-20260913T120000Z.tar.gz.sha256
```

The two 64-character values must match; letter case does not matter.

If a reboot leaves an ext4 result bundle containing `.reference-active`, keep
the whole directory unchanged. The preparer refuses it because it cannot safely
invent a final status. Report the reset and preserve the raw evidence for
manual recovery.

Results can be shared through the repository's **Reference kit result** issue
form. GitHub issues are normally public: share a restricted link, include the
SHA-256 in text, and keep your own unchanged copy.

## Offline installation

On a stable computer, download these three files onto one removable drive:

1. `fault-affinity-live-linux-x64.tar.gz` from the exact stable release;
2. its adjacent `.sha256` file; and
3. the [`fault-affinity-run` bootstrap](https://gadicc.github.io/fault-affinity/run).

In the live session, open the drive in Files, then use its real mount path in
place of `/media/ubuntu/KIT`:

```sh
cd "$HOME"
less "/media/ubuntu/KIT/fault-affinity-run"
bash "/media/ubuntu/KIT/fault-affinity-run" \
  --version v0.1.0 \
  --offline-dir "/media/ubuntu/KIT"
```

Press **q** to leave `less`. Offline mode requires the exact release tag and
applies the same checksum and archive checks as the online path. It still does
not start the workload.
