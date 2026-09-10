# Use the Ubuntu live reference kit

The live kit is a narrow way to reproduce the pinned Node/PGlite reference
experiment without installing Git, Node, npm, or a compiler. It records
observations under controlled CPU affinity; it does not, by itself, diagnose a
processor, motherboard, or operating system fault.

This first kit records bounded, non-serial machine, BIOS, microcode, kernel,
runtime, and CPU-topology identity. It does not yet collect continuous
frequency or temperature telemetry. That is an acceptance-gated follow-up, so
the kit is not a byte-for-byte replacement for the telemetry-rich legacy
diagnostic suite.

It is also a fixed, known-target reference profile. CPU 19 is preserved for
the motivating case study; it is not a general guess for another computer.
Until the separately versioned discovery flow is released, use this kit only
when you have a reviewed target/load override or deliberately want the exact
case-study comparison.

The first validation target is an official Ubuntu Desktop 26.04 LTS live
session on an x86-64 computer. Public release remains disabled until that
manual acceptance run passes. Ubuntu Desktop 24.04 LTS is a later compatibility
target.

## Start with a safe preview

This gets you to a read-only plan. It does **not** start the test workload or
create a result bundle.

1. Boot the Ubuntu USB, choose **Try Ubuntu**, and connect to the internet.
2. Open **Terminal** from the application menu, or press **Ctrl+Alt+T**.
3. Paste these commands one line at a time:

   ```sh
   wget -qO fault-affinity-run https://gadicc.github.io/fault-affinity/run
   less fault-affinity-run
   bash fault-affinity-run
   ```

4. In `less`, use the arrow keys to look around and press **q** to exit. The
   bootstrap then verifies and extracts the kit without running the workload.
5. Copy the **safe preview** command printed at the end. It uses `$HOME` only
   for a read-only dry run. Do not add `--yes` there.

When the plan appears, the safe preview is complete. Continue below to choose
persistent storage and understand the deliberate live-run step.

## Before booting

Prefer two USB drives:

- the Ubuntu installer/live drive; and
- a separate ext4-formatted data drive with enough free space for the raw
  result directory and the prepared sharing archive.

A mounted internal data partition can replace the second drive if writing to it
is acceptable. Do not assume that the live user's home directory is persistent:
an ordinary live session can lose it at reboot. The launcher refuses `/tmp` as
a results root and warns about other apparently volatile locations.

The active raw result directory needs Unix ownership, private permissions, and
advisory locks. The live launcher therefore refuses FAT, exFAT, and NTFS for a
confirmed run. Those filesystems are still supported as the destination for
the prepared `.tar.gz` and checksum. If Windows-readable removable media is
the only data drive available, collect raw data in the live-session home and
prepare it onto that drive before shutdown; that route loses the raw journal
if the machine reboots. An ext4 raw-results drive is the safer choice on a
machine being tested for instability.

The experiment deliberately creates sustained work and may expose instability.
Save unrelated work, disconnect unneeded storage, use AC power, and do not use
the tested machine for anything important during the measured run. The kit
does not need root and must not be run with `sudo`.

## Download without piping to a shell

After choosing **Try Ubuntu** and joining a network, open **Terminal** from the
application menu or press **Ctrl+Alt+T**. Confirm the dependencies supplied by
the Ubuntu live image:

```sh
/usr/bin/python3 --version
/usr/bin/wget --version | head -n 1
```

Download the bootstrap to a file, optionally inspect it, and only then
run it:

```sh
wget -qO fault-affinity-run https://gadicc.github.io/fault-affinity/run
less fault-affinity-run
bash fault-affinity-run
```

`wget` is normally silent on success and returns to the prompt. In `less`, use
the arrow or Page Up/Page Down keys to inspect the file, then press **q** to
return to Terminal. Run the third command only after the download succeeded.

To select a published release rather than the latest stable release:

```sh
bash fault-affinity-run --version v0.1.0
```

The bootstrap rejects root and non-x86-64 systems. It resolves `latest` once to
one exact GitHub Release tag, downloads that tag's Linux archive and checksum,
checks the SHA-256, validates the archive with Python's structured `tarfile`
API plus a raw-header pass, and extracts into a new directory such as
`fault-affinity-v0.1.0`. It rejects links, special files, traversal, duplicate
paths, unexpected layout and permissions, extended headers, and excessive
archive size or member count. It does not run the reference experiment.

HTTPS and the checksum published by the same GitHub project detect incomplete
or mismatched downloads. They do not independently protect against compromise
of that publisher. The release page also provides the archive for download on
a stable computer when the live session has no network; copy the archive and
checksum to removable media and verify both before following its `README.txt`.

If an interrupted extraction leaves a hidden directory named like
`.fault-affinity-v0.1.0.partial-1234`, first confirm no bootstrap is running.
It can then be removed manually. The bootstrap never replaces an existing
final destination.

## Choose persistent results storage

Use the Files application to mount the ext4 raw-results drive. Ubuntu commonly
mounts it below `/media/ubuntu/<volume-name>`. Confirm its filesystem and exact
path rather than copying an example literally, and quote paths containing
spaces. A separate FAT/exFAT drive or partition can be used later for only the
prepared archive.

This command lists drive labels, filesystem types, and mount locations:

```sh
lsblk -o NAME,SIZE,FSTYPE,LABEL,MOUNTPOINTS
```

Find the data drive by its label and size. For persistent raw results its
`FSTYPE` must be `ext4`, and its `MOUNTPOINTS` value is the path to use. Do not
format or repartition a drive during this procedure; that would erase data.

From the extracted kit, print the complete plan without starting the workload:

```sh
cd fault-affinity-v0.1.0
./bin/run-reference --results-root "/media/ubuntu/RESULTS"
```

Use the directory name printed by the bootstrap instead of assuming
`fault-affinity-v0.1.0`, and replace `/media/ubuntu/RESULTS` with the real ext4
mount path. The dry run prints a readable plan and a complete command for the
confirmed run; copy that generated command rather than reconstructing it.

Check the release, runtime hashes, CPU target and load set, schedule, attempt
deadlines, available capacity, and output location. CPU 19 and load CPUs 0–7
are case-study defaults, not a claim that CPU 19 is suspect on another system.
Use the launcher's documented overrides when that topology is unavailable.

Only after you review the dry run should you deliberately add the live
confirmation flag:

```sh
./bin/run-reference --results-root "/media/ubuntu/RESULTS" --yes
```

Close Firefox and other applications before the measured run. Leave the
terminal open. A target timeout, cleanup problem, reboot, or interrupted run is
operational/incomplete evidence and must not be relabelled as a target crash.

## Prepare and verify the result

Wait until the controller has ended and all induced-load workers are reported
stopped. The preparer needs the results root, the finalized bundle below that
root, and an existing destination outside the bundle. A finalized result may
be complete, interrupted, or operationally incomplete; the status is preserved
and is never relabelled as a target fault. Follow the exact paths printed by the
run; the command has this form:

```sh
./share/prepare-results \
  --results-root "/media/ubuntu/RESULTS" \
  --bundle "/media/ubuntu/RESULTS/<completed-bundle>" \
  --destination "/media/ubuntu/SHARE"
```

Use `./share/prepare-results --help` to inspect the interface without writing
anything. Replace every example path, including `<completed-bundle>`, with an
actual path reported on that machine.

The tool accepts only its versioned reference-result format. It inventories an
allowlisted set of regular files and creates these together on the chosen
persistent volume:

```text
fault-affinity-results-<UTC timestamp>.tar.gz
fault-affinity-results-<UTC timestamp>.tar.gz.sha256
```

It does not upload, delete, redact, or silently repair the source result. Read
the displayed inventory and privacy checklist. Raw arguments, local paths,
process output, and error text may contain identifying or workload-supplied
content; the inventory makes review possible but is not a guarantee that
arbitrary output is private. Do not publish machine serial numbers, account
names, tokens, unrelated logs, core dumps, or browser data.

The controller fsyncs a bounded progress journal after each finished attempt.
If a reset leaves `.reference-active` in a bundle on persistent storage, do not
delete it or reuse that directory. The preparer deliberately refuses such a
bundle because it cannot safely invent a terminal status. Preserve the complete
raw directory on a stable Linux system for manual recovery and report that the
run was reset. Automatic synthesis of a shareable stranded-run snapshot is a
future, separately reviewed feature.

Verify the archive by changing to its directory and using the exact checksum
filename:

```sh
sha256sum -c fault-affinity-results-20260910T120000Z.tar.gz.sha256
sync
```

Replace the example timestamp with the actual file. Eject the data drive using
Files. On a stable computer, copy both files and run `sha256sum -c` again before
uploading. This USB-first route best separates evidence from a machine being
tested for instability.

On a stable Windows computer, open PowerShell in the folder and run:

```powershell
Get-FileHash -Algorithm SHA256 .\fault-affinity-results-20260910T120000Z.tar.gz
Get-Content .\fault-affinity-results-20260910T120000Z.tar.gz.sha256
```

Replace the timestamp in both commands. The two 64-character values must match
before upload; hexadecimal letter case does not matter.

## Upload only after the load has stopped

When persistent media is not practical, the Firefox browser supplied by the
Ubuntu live image can be a fallback. Firefox is not part of this project. An
unstable machine may corrupt a file or expose credentials, so avoid logging
into an important account when the USB-first route is available.

After the controller has ended and load workers have stopped:

1. Open Firefox and sign in to Google Drive or Dropbox.
2. Upload both the prepared `.tar.gz` and its `.sha256` file.
3. Verify the reported upload completed, then create a restricted, view-only
   link for the intended recipient. Do not make the folder public unless that
   is a deliberate privacy-reviewed choice.
4. For a small result, Gmail or another mail provider can attach both files.
   For a large result, email the restricted cloud-storage link instead.
5. Log out, close Firefox, and shut down the live session when finished.

If only volatile storage is available, prepare and upload before reboot. The
fact that induced load has stopped does not prove that the tested machine is
safe for credentials or that its file contents are intact. Retain the checksum
and verify the downloaded copy on a stable machine.

Results can be shared through the repository's **Reference kit result** issue
form. GitHub issues are normally public: prefer a view-only link, include the
SHA-256 in text, disclose no credentials, and do not attach evidence that has
not passed the privacy review. Keep the original evidence unchanged and
retain your independent copy even after sharing a derived archive.
