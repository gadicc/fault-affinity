# Test a Windows PC with the Ubuntu live kit

This guide helps Windows users test their physical computer from a temporary Ubuntu session. You won't install Ubuntu, Node.js, npm, Git, or a compiler. The kit screens the relevant CPUs, then confirms the strongest candidate with a separate test.

If you already use Linux, skip the live USB. Run the release kit directly or use the [repository setup](../README.md#quick-start).

Use Ubuntu Desktop 26.04.1 LTS on an Intel or AMD 64-bit computer. Download only a stable kit from the [Fault Affinity releases page](https://github.com/gadicc/fault-affinity/releases).

## Start here

You'll need an Ubuntu boot USB and persistent ext4 storage for active results. You can use another USB drive or an existing Linux partition. A Windows-readable drive is optional for the final archive.

The flow is: boot **Try Ubuntu**, download and inspect the kit, preview the CPU screen, run it, confirm any selected CPU, then save the results.

### 1. Create and boot the Ubuntu USB

Creating the boot USB erases it. Use an empty drive of at least 8 GB and check the selected drive before writing it.

1. Download **Ubuntu Desktop 26.04.1 LTS for Intel or AMD 64-bit** from the [Ubuntu Desktop download page](https://ubuntu.com/download/desktop).
2. Follow the [Ubuntu bootable USB guide for Windows](https://ubuntu.com/desktop/docs/en/latest/how-to/create-a-bootable-usb-stick/#on-windows). Copying the ISO file onto the drive isn't enough.
3. Restart the computer and select the USB from its boot menu. **F12** is common, but your manufacturer may use another key.
4. Select **Try Ubuntu**, not **Install Ubuntu**.

### 2. Choose persistent results storage

The screen can expose a hang or reboot, so active files require a persistent Unix filesystem such as ext4. Don't use the live-session home directory, FAT, exFAT, or NTFS for this step.

Open Ubuntu's **Files** app and mount the ext4 drive or Linux partition. With the drive open, press **Ctrl+L** to show and copy its path. Ubuntu usually mounts it at `/media/ubuntu/drive_label`. If you don't have suitable storage, read [Prepare a spare USB drive](#prepare-a-spare-usb-drive).

### 3. Download and inspect the kit

Connect to the internet. Open **Terminal** from the app menu, or press **Ctrl+Alt+T**. Paste these commands one line at a time:

```sh
wget -qO fault-affinity-run https://gadicc.github.io/fault-affinity/run
less fault-affinity-run
bash fault-affinity-run
```

Use the arrow keys to inspect the bootstrap, then press **q** to exit `less`. The final command downloads and verifies the stable kit. It doesn't start a test. Note the release tag and extracted directory it prints.

Continue if the printed command names `discover-reference`. If it names `run-reference`, read the [fixed CPU 19 comparison](#run-the-fixed-cpu-19-case-study-comparison) or wait for a guided release.

### 4. Run the guided CPU screen

The bootstrap prints a `discover-reference` preview command. Change only `--results-root` from `$HOME` to your mounted ext4 path, then run the command.

Review the CPU roles, checks, schedule, and result path. If they pass, copy the complete command ending in `--yes`. Don't add `--yes` yourself: the printed command identifies the preview you reviewed.

Save other work, connect AC power, close Firefox, and disconnect drives you don't need before starting. Never run the kit with `sudo`.

### 5. Confirm the selected CPU

A complete screen either reports no candidate or prints a `confirm-reference --dry-run` command. No candidate is still useful: preserve the screen and stop there.

If it finds a candidate, run the printed preview. Review the checks, then copy its exact command ending in `--yes`. Confirmation collects 20 new attempts in each A1, B, and A2 leg.

### 6. Prepare and save the results

After the command prints its `Results:` path, return to the extracted kit directory. Use `prepare-results` to create a `.tar.gz` archive and matching `.sha256` file:

```sh
cd "/path/printed/by/bootstrap"
./share/prepare-results \
  --results-root "/media/ubuntu/results_drive" \
  --bundle "/media/ubuntu/results_drive/result_directory" \
  --destination "/media/ubuntu/share_drive"
```

Use your printed paths. The destination must exist outside the result directory. It can be a FAT, exFAT, or NTFS drive that Windows can read.

Prepare the screen first. If you ran confirmation, prepare that directory too. Copy every archive and checksum before shutting down, or [upload them with Firefox](#upload-with-firefox).

## See an example result

This simplified example combines an illustrative three-attempt screen with the [historical CPU 19 confirmation proportions](case-study/fault-signature-and-cpu-localization.md#measure-reversible-package-load-association). It is not a recorded live-kit run or a promised outcome. Your CPU numbers and counts will differ.

```text
Guided screen
  CPU 17, loaded B faults: 0/3
  CPU 19, loaded B faults: 3/3  <- selected
  CPU 21, loaded B faults: 2/3
  Next: preview confirm-reference for CPU 19

Fresh confirmation
  A1, no induced load:          0/20 faults
  B, induced load:             19/20 faults
  A2, load removed:             0/20 faults
```

If the screen finds no target fault, it reports `Highest observed fault-rate candidate: None`. Preserve the screen result; confirmation isn't needed.

A selected CPU is where this workload reproduced most often during the screen. It does not prove that the CPU is defective or establish a hardware cause.

## Understand what the kit runs

The bootstrap installs a verified release and prints a dry-run command. It never starts the workload.

`discover-reference` is the start-from-scratch route. On a supported hybrid CPU, it tests each detected efficiency core under fixed performance-core load. Each target gets three attempts without load, three with verified load, and three after recovery. Only complete, usable results can select a candidate.

`confirm-reference` accepts only a candidate from a complete screen on the same machine and boot. It collects new samples with the frozen `load-aba-discovered-confirmation` profile. Discovery samples never count toward confirmation.

Both commands use Node.js 25.2.1 and PGlite 0.5.4, with Node.js 24.21.0 as the controller. These versions form part of the test identity, so don't replace them.

Automatic discovery version 1 requires a supported hybrid topology. If the preview says automatic selection is unavailable, don't guess CPU roles. Preserve the message and ask for guidance, or use the fixed case-study comparison described below.

## Why you must boot the physical computer

This test pins work to logical CPUs on the physical machine. A virtual machine exposes virtual CPUs, so its CPU numbers don't identify the same physical execution context.

QEMU can expose host CPU features and pin virtual-CPU threads. The guest still has hypervisor scheduling, virtual topology, and different timing. Use QEMU to check that the kit boots and stays dry, not to test physical CPUs. See the [QEMU CPU overview](https://qemu.readthedocs.io/en/master/system/introduction.html#options-overview) and [libvirt CPU pinning documentation](https://libvirt.org/formatdomain.html#cpu-tuning).

Docker Desktop on Windows uses Windows Subsystem for Linux 2 (WSL 2), Hyper-V, or another virtual machine backend. `--cpuset-cpus` still selects virtual CPUs. See the [Docker Desktop Windows backend documentation](https://docs.docker.com/desktop/setup/install/windows-install/) and [`--cpuset-cpus` reference](https://docs.docker.com/reference/cli/docker/container/create/).

Native Linux containers can map affinity to host CPUs, but add cgroup and runtime constraints. Run the kit directly on Linux.

## Choose how to save results

Active evidence and shareable files have different filesystem needs:

| Storage | Active screen or confirmation | Final archive | Readable on Windows |
| --- | --- | --- | --- |
| ext4 USB or Linux partition | Yes | Yes | Not without extra software |
| FAT, exFAT, or NTFS drive | No | Yes | Yes |
| Live Ubuntu `$HOME` | Preview only | Temporary copy | No after shutdown |
| Firefox upload | Requires ext4 active storage first | Yes | Download from the service |

### Prepare a spare USB drive

For a Windows-only computer, a second empty USB drive is usually the clearest active-storage route. Preparing it as ext4 erases every file on that drive.

1. In the Ubuntu live session, open **Disks** from the app menu.
2. Select the spare USB by its model and capacity. Check again that you didn't select the Windows disk or Ubuntu boot USB.
3. Format its partition as ext4 and give it a recognizable name such as `FAULT_RESULTS`.
4. Open the new volume in **Files** to mount it.

Ubuntu's [removable-disk formatting guide](https://help.ubuntu.com/stable/ubuntu-help/disk-format.html.en) shows the same **Disks** workflow. Upload the final archive or copy it to a Windows-readable drive.

### Upload with Firefox

Prepare the archive outside the raw result, then upload the `.tar.gz` and `.sha256` files with Ubuntu's included Firefox.

An unstable machine can corrupt files or expose credentials. Prefer removable media, avoid an important account, and verify the checksum on a stable computer.

## Resume or preserve an interrupted screen

From the extracted kit directory, preview a stopped screen on the same Ubuntu boot with:

```sh
./bin/discover-reference --resume "/media/ubuntu/results_drive/reference-discovery-20260913T120000Z"
```

The preview prints a matching `--yes` command that runs only untouched target sessions.

After a reboot, the old collection can't resume or authorize confirmation because the boot identity changed. Boot **Try Ubuntu** again, remount the results drive at its original path, and reinstall the same release tag with the bootstrap's `--version` option. From that kit, preserve the old collection with `prepare-results`, then start a new screen.

If a reboot leaves `.reference-active` inside a result, preserve the whole directory unchanged.

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

The two 64-character values must match. Letter case doesn't matter.

Review the printed inventory. Don't share credentials, unrelated logs, core dumps, or browser data.

Report results with the [Reference kit result form](https://github.com/gadicc/fault-affinity/issues/new?template=reference-result.yml). GitHub issues are public. Use a restricted download link, include the SHA-256, and keep an unchanged copy.

## Run the fixed CPU 19 case-study comparison

`run-reference` preserves the original `load-aba-reference` version 1 trigger: CPU 19, load CPUs 0 through 7, and 20 attempts per leg. Those choices don't predict a target on another computer.

From the extracted kit directory, use this command only when you want that exact historical comparison:

```sh
./bin/run-reference --results-root "$HOME" --dry-run
```

If CPU 19 isn't available, `run-reference` rejects its defaults. An older bootstrap may print explicit overrides, but they aren't CPU recommendations. Unlike guided runs, this fixed comparison can use live-session storage, which a reboot can erase.

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
