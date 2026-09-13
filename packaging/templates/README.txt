Fault Affinity Linux live kit
=============================

New to this machine? Start with the guided screen. It checks the available CPU
topology and proposes which CPUs to compare; it does not assume CPU 19:

  ./bin/discover-reference --results-root /absolute/persistent/path

That command is a safe preview. Nothing live runs unless you later copy the
exact command it prints with --yes.

It records bounded machine, BIOS, microcode, kernel, runtime, and CPU-topology
identity without serial numbers. Continuous frequency and temperature
telemetry are not included in this first, acceptance-gated kit.

For the original case-study comparison only, the fixed reference command keeps
CPU 19 and load CPUs 0-7 as historical defaults:

  ./bin/run-reference --results-root /absolute/persistent/path

Those defaults are not automatic fault localization.

The bundled Node 25.2.1 reference target is end-of-life software frozen as an
offline diagnostic specimen. It is isolated inside this directory and must not
be used as a general-purpose runtime or added to your PATH.

Do not run the kit as root. Active raw results require a persistent Unix
filesystem with private permissions and advisory locks. A normal FAT, exFAT,
or NTFS USB is useful for the prepared archive, but not the active collection.
A live-session home directory can disappear at reboot.

After the run, create a privacy-reviewable archive with:

  ./share/prepare-results \
    --results-root /absolute/path/to/results-root \
    --bundle /absolute/path/to/results-root/completed-bundle \
    --destination /absolute/path/to/persistent-destination

Review share/UPLOAD-RESULTS.txt before moving or uploading evidence.
