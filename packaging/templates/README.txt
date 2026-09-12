Fault Affinity Linux reference kit
==================================

This kit runs a bounded A/B/A diagnostic workload. It does not diagnose a
specific hardware defect automatically.

It records bounded machine, BIOS, microcode, kernel, runtime, and CPU-topology
identity without serial numbers. Continuous frequency and temperature
telemetry are not included in this first, acceptance-gated kit.

CPU 19 and load CPUs 0-7 are fixed case-study defaults, not automatic fault
localization. Use them only for that exact comparison or supply a reviewed
target/load override. A general discovery flow is a separate future profile.

Nothing live runs when you extract the kit or invoke bin/run-reference without
--yes. Start with a dry run and read the printed plan:

  ./bin/run-reference --results-root /absolute/persistent/path

The bundled Node 25.2.1 reference target is end-of-life software frozen as an
offline diagnostic specimen. It is isolated inside this directory and must not
be used as a general-purpose runtime or added to your PATH.

Only after reviewing that plan, run the exact command it prints with --yes.
Do not run the kit as root. Active raw results require a Unix filesystem with
private permissions and advisory locks; use ext4 for a persistent raw-results
USB drive. FAT, exFAT, and NTFS are refused for the confirmed run, but remain
supported as the destination for the prepared archive. A live-session home
directory can disappear at reboot.

After the run, create a privacy-reviewable archive with:

  ./share/prepare-results \
    --results-root /absolute/path/to/results-root \
    --bundle /absolute/path/to/results-root/completed-bundle \
    --destination /absolute/path/to/persistent-destination

Review share/UPLOAD-RESULTS.txt before moving or uploading evidence.
