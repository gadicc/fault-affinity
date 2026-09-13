# Test a Windows PC with the Ubuntu live kit

This guide helps Windows users test the physical computer from a temporary Ubuntu session. You don't install Ubuntu, Node.js, npm, Git, or a compiler. The guided screen chooses relevant CPU roles, and a separate confirmation collects fresh Node.js and PGlite evidence.

Already using Linux? Skip the live USB and run the release kit from your Linux session, or use the [repository setup](../README.md#quick-start).

Use Ubuntu Desktop 26.04.1 LTS on an Intel or AMD 64-bit computer. Use only a stable kit from the [Fault Affinity releases page](https://github.com/gadicc/fault-affinity/releases).

## Start here

This route uses one Ubuntu boot USB and a persistent Linux results location. The results location can be an ext4 USB drive or an existing Linux partition. A Windows-readable drive is optional for the final archive.

### 1. Create and boot the Ubuntu USB

Creating the boot USB erases it. Use an empty drive of at least 8 GB, and check the selected drive before writing it.

1. Download **Ubuntu Desktop 26.04.1 LTS for Intel or AMD 64-bit** from the [Ubuntu Desktop download page](https://ubuntu.com/download/desktop).
2. Follow the [Ubuntu guide for creating a bootable USB on Windows](https://ubuntu.com/desktop/docs/en/latest/how-to/create-a-bootable-usb-stick/#on-windows). Copying the ISO file onto the drive isn't enough.
3. Restart the computer and select the USB from its boot menu. **F12** is common, but your manufacturer may use another key.
4. Select **Try Ubuntu**, not **Install Ubuntu**.

### 2. Choose persistent results storage

The guided screen can expose a hang or reboot. Its active files must therefore use a persistent Unix filesystem such as ext4. A live-session home directory, FAT, exFAT, and NTFS don't meet this requirement.

Open Ubuntu's **Files** app and mount your ext4 drive or Linux partition. Ubuntu usually mounts removable drives at `/media/ubuntu/drive_label`. If you don't already have suitable storage, read [Prepare a spare USB drive](#prepare-a-spare-usb-drive) before continuing.

### 3. Download and inspect the kit

Connect to the internet. Open **Terminal** from the app menu, or press **Ctrl+Alt+T**, then paste these commands one line at a time:

```sh
wget -qO fault-affinity-run https://gadicc.github.io/fault-affinity/run
less fault-affinity-run
bash fault-affinity-run
```

Use the arrow keys to inspect the bootstrap. Press **q** to exit `less`. The final command downloads, verifies, and extracts one stable release. It doesn't start a test. Note the release tag and extracted directory it prints.

Check the command printed at the end. Continue below if it names `discover-reference`. An older release may print `run-reference` instead; use the [fixed case-study comparison](#run-the-fixed-cpu-19-case-study-comparison), or wait for a guided release.

### 4. Run the guided CPU screen

For a guided release, the bootstrap prints a `discover-reference` preview command. Change only its `--results-root` value from `$HOME` to your mounted ext4 path, then run it with `--dry-run`.

Review the CPU roles, memory check, storage check, schedule, and result path. If every check passes, the preview prints a complete command ending in `--yes`. Copy that exact command to start the screen. Don't add `--yes` by hand because the command includes a binding to the preview you reviewed.

Save other work, connect AC power, close Firefox, and disconnect drives you don't need before starting. Never run the kit with `sudo`.

### 5. Confirm the selected CPU

A complete screen either reports no candidate or prints a separate `confirm-reference --dry-run` command. No candidate is still a useful result; preserve the screen and stop there.

If the screen finds a candidate, run its preview command. The preview rechecks the same machine, boot, kit, storage, and CPU selection. Copy the exact command ending in `--yes` to collect a fresh 20-attempt A1/B/A2 confirmation.

### 6. Prepare and save the results

After the command exits and prints its `Results:` path, change to the extracted kit directory printed by the bootstrap. Then use `prepare-results` to create a `.tar.gz` archive and adjacent `.sha256` file:

```sh
cd "/path/printed/by/bootstrap"
./share/prepare-results \
  --results-root "/media/ubuntu/results_drive" \
  --bundle "/media/ubuntu/results_drive/result_directory" \
  --destination "/media/ubuntu/share_drive"
```

Use the paths printed during your run. The destination must exist and must sit outside the result directory. It can be a FAT, exFAT, or NTFS drive that Windows can read.

Prepare the screen directory first. If you also ran confirmation, repeat the command for its result directory. Copy every resulting archive and checksum before shutting down. You can also upload them with Firefox as described in [Upload with Firefox](#upload-with-firefox).

## Understand what the kit runs

The bootstrap only installs a verified release. It prints a dry-run command and never starts the workload itself.

`discover-reference` is the start-from-scratch route. On a supported hybrid CPU, it tests each detected efficiency-core target under one fixed set of performance-core load workers. Each target gets three attempts in A1 without induced load, B with verified load, and A2 after recovery. The report ranks only complete, usable rows and makes no claim that a candidate CPU is defective.

`confirm-reference` accepts only the candidate from a complete screen on the same machine and boot. It collects new samples using the frozen `load-aba-discovered-confirmation` profile. Discovery samples never count as confirmation samples.

Both commands use the bundled Node.js 25.2.1 target and PGlite 0.5.4. The kit also bundles a separate Node.js 24.21.0 controller. These versions are part of the test identity, so don't replace them with a system runtime.

Automatic discovery version 1 requires a supported hybrid topology. If the preview says automatic selection is unavailable, don't guess CPU roles. Preserve the message and ask for guidance, or use the fixed case-study comparison described below.

## Why you must boot the physical computer

This test pins work to logical CPUs on the physical machine. A virtual machine exposes virtual CPUs, so its CPU numbers don't identify the same physical execution context.

QEMU can expose host CPU features, pin virtual-CPU threads, and use `-cpu host`. The guest still has hypervisor scheduling, virtual topology, and different timing. QEMU is suitable for checking that the kit boots and stays dry by default, but not for a reliable physical-CPU result. See the [QEMU CPU overview](https://qemu.readthedocs.io/en/master/system/introduction.html#options-overview) and [libvirt CPU pinning documentation](https://libvirt.org/formatdomain.html#cpu-tuning).

Docker Desktop on Windows uses a Windows Subsystem for Linux 2 (WSL 2), Hyper-V, or Docker virtual machine backend. `--cpuset-cpus` limits the virtual CPUs available to a container; it doesn't turn the run into a bare-metal Ubuntu test. See the [Docker Desktop Windows backend documentation](https://docs.docker.com/desktop/setup/install/windows-install/) and [`--cpuset-cpus` reference](https://docs.docker.com/reference/cli/docker/container/create/).

On native Linux, containers share the host kernel and can map affinity to host CPUs. A container still adds cgroup and runtime constraints, so run this kit directly on Linux.

## Choose how to save results

Active evidence and shareable files have different filesystem needs:

| Storage | Active screen or confirmation | Final archive | Readable on Windows |
| --- | --- | --- | --- |
| ext4 USB or Linux partition | Yes | Yes | Not without extra software |
| FAT, exFAT, or NTFS drive | No | Yes | Yes |
| Live Ubuntu `$HOME` | Preview only | Temporary copy | No after shutdown |
| Firefox upload | Requires ext4 active storage first | Yes | Download from the service |

### Store active results on ext4

Use an ext4 USB drive or an existing mounted Linux partition for the guided screen and confirmation. This keeps the journal available if the machine reboots.

To list filesystems, labels, sizes, and mount paths, run:

```sh
lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS
```

Identify a drive by its label, size, and filesystem. Don't copy an example path without checking it. Formatting or repartitioning a drive erases data; use only a spare empty drive if you follow the next section.

### Prepare a spare USB drive

For a Windows-only computer, a second empty USB drive is usually the clearest active-storage route. Preparing it as ext4 erases every file on that drive.

1. In the Ubuntu live session, open **Disks** from the app menu.
2. Select the spare USB by its model and capacity. Check again that you didn't select the Windows disk or Ubuntu boot USB.
3. Format its partition as ext4 and give it a recognizable name such as `FAULT_RESULTS`.
4. Open the new volume in **Files** to mount it.

Ubuntu's [removable-disk formatting guide](https://help.ubuntu.com/stable/ubuntu-help/disk-format.html.en) shows the same **Disks** workflow. Use Firefox to upload the final archive, or copy it later to a Windows-readable drive.

### Transfer the final archive on a normal USB drive

If a removable drive is formatted as FAT, exFAT, or NTFS and Ubuntu's **Files** app can open it, use it as the `prepare-results --destination`. These filesystems are suitable for the final `.tar.gz` and `.sha256` pair, but not the active journal.

### Upload with Firefox

Prepare the archive into a directory outside the raw result, then open Ubuntu's included Firefox. Upload the `.tar.gz` and `.sha256` files to Google Drive, Dropbox, Gmail, or another service before shutting down.

An unstable machine can corrupt files or expose credentials. Use removable media when practical, avoid an important account, share a restricted link, and verify the checksum again on a stable computer.

## Resume or preserve an interrupted screen

From the extracted kit directory, preview a stopped screen on the same Ubuntu boot with:

```sh
./bin/discover-reference --resume "/media/ubuntu/results_drive/reference-discovery-20260913T120000Z"
```

The preview prints the matching `--yes` resume command. It runs only untouched target sessions.

After a reboot, the old collection can't resume or authorize confirmation because the boot identity changed. Boot **Try Ubuntu** again, remount the results drive at its original path, and reinstall the same release tag with the bootstrap's `--version` option. From that extracted kit, use `prepare-results` to preserve the old collection as `incomplete-non-selection-evidence`, then start a new screen.

If a reboot leaves `.reference-active` inside a confirmation or fixed result, preserve the whole directory unchanged. The preparer refuses to invent a final status for it.

## Verify and share the archive

Change to the archive destination and run the exact checksum filename printed by `prepare-results`:

```sh
sha256sum -c fault-affinity-confirmation-complete-20260913T120000Z.tar.gz.sha256
sync
```

On Windows, open PowerShell in the directory containing both files:

```powershell
Get-FileHash -Algorithm SHA256 .\archive_name.tar.gz
Get-Content .\archive_name.tar.gz.sha256
```

The two 64-character values must match; letter case doesn't matter.

Review the printed inventory before sharing. Evidence can contain paths, arguments, process output, or error text. Don't publish credentials, account names, unrelated logs, core dumps, or browser data.

You can report a result with the repository's **Reference kit result** issue form. GitHub issues are public unless the repository says otherwise. Prefer a restricted download link, include the SHA-256 in the issue text, and keep an unchanged copy.

## Run the fixed CPU 19 case-study comparison

`run-reference` preserves the original `load-aba-reference` version 1 trigger. It uses target CPU 19, load CPUs 0 through 7, and 20 attempts per leg by default. Those CPUs matched the motivating machine; they don't predict a target on another computer.

From the extracted kit directory, use this command only when you want that exact historical comparison:

```sh
./bin/run-reference --results-root "$HOME" --dry-run
```

If CPU 19 isn't available, `run-reference` rejects its defaults. An older bootstrap may print a compatible command with explicit CPU overrides. That command proves only that the runner can start; it isn't a CPU recommendation. Unlike guided discovery and confirmation, the fixed runner can use live-session storage, but a reboot can erase the result.

## Install the kit without internet access

On a stable computer, copy these files to a removable drive:

1. `fault-affinity-live-linux-x64.tar.gz` from one stable release
2. Its adjacent `.sha256` file
3. The [`fault-affinity-run` bootstrap](https://gadicc.github.io/fault-affinity/run)

In Ubuntu, open the drive in **Files** and use its mount path:

```sh
cd "$HOME"
less "/media/ubuntu/kit_drive/fault-affinity-run"
bash "/media/ubuntu/kit_drive/fault-affinity-run" \
  --version v1.2.3 \
  --offline-dir "/media/ubuntu/kit_drive"
```

Press **q** to exit `less`. Replace `v1.2.3` with the exact downloaded release tag. Offline mode performs the same checksum and archive checks and doesn't start a workload.
