#!/usr/bin/env python3
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile


destination = Path(sys.argv[1])
variant = sys.argv[2]
destination.mkdir(parents=True, exist_ok=True)
archive_path = destination / "fault-affinity-live-linux-x64.tar.gz"

controller_payload = b"fixture controller runtime\n"
reference_payload = b"fixture reference runtime\n"
release = {
    "schemaVersion": 1,
    "release": {
        "version": "0.1.0",
        "tag": "v0.1.0",
        "sourceCommit": "0123456789abcdef0123456789abcdef01234567",
    },
    "runtimes": {
        "controller": {
            "version": "v24.21.0",
            "sha256": hashlib.sha256(controller_payload).hexdigest(),
        },
        "reference": {
            "version": "v25.2.1",
            "sha256": hashlib.sha256(reference_payload).hexdigest(),
        },
    },
}
if variant != "legacy-valid":
    release["profiles"] = {
        "referenceDiscovery": {
            "id": "reference-loaded-discovery",
            "version": 1,
            "protocol": "reference-loaded-discovery-v1",
            "pgliteVersion": "0.5.4",
        },
        "referenceConfirmation": {
            "id": "load-aba-discovered-confirmation",
            "version": 1,
            "pgliteVersion": "0.5.4",
        },
    }
    release["capabilities"] = {"referenceDiscovery": 1, "referenceConfirmation": 1}
if variant == "partial-capability":
    release["capabilities"] = {"referenceDiscovery": 1}
elif variant == "boolean-capability":
    release["capabilities"] = {"referenceDiscovery": True, "referenceConfirmation": True}
if variant == "bad-release":
    release["release"]["tag"] = "v9.9.9"
elif variant == "runtime-mismatch":
    release["runtimes"]["reference"]["sha256"] = "0" * 64


def info(name, mode=0o644, type_=tarfile.REGTYPE):
    member = tarfile.TarInfo(name)
    member.mode = mode
    member.uid = 0
    member.gid = 0
    member.mtime = 0
    member.type = type_
    return member


def add_file(archive, name, content, mode=0o644):
    payload = content if isinstance(content, bytes) else content.encode()
    member = info(name, mode)
    member.size = len(payload)
    archive.addfile(member, io.BytesIO(payload))


if variant == "pax":
    archive_format = tarfile.PAX_FORMAT
elif variant == "gnu-longname":
    archive_format = tarfile.GNU_FORMAT
else:
    archive_format = tarfile.USTAR_FORMAT
with tarfile.open(archive_path, "w:gz", format=archive_format) as archive:
    root = info("fault-affinity", 0o755, tarfile.DIRTYPE)
    archive.addfile(root)
    for directory in ("bin", "app", "runtime", "share", "LICENSES"):
        archive.addfile(info(f"fault-affinity/{directory}", 0o755, tarfile.DIRTYPE))
    for directory in (
        "app/src", "app/src/reference-kit",
        "runtime/controller", "runtime/controller/bin",
        "runtime/reference", "runtime/reference/bin",
    ):
        archive.addfile(info(f"fault-affinity/{directory}", 0o755, tarfile.DIRTYPE))
    if variant != "missing-required":
        add_file(archive, "fault-affinity/README.txt", "fixture\n")
    add_file(archive, "fault-affinity/LICENSES/MIT.txt", "fixture license\n")
    add_file(archive, "fault-affinity/app/child.mjs", "// fixture child\n")
    if variant != "missing-essential":
        add_file(
            archive,
            "fault-affinity/app/src/reference-kit/controller.mjs",
            "// fixture controller\n",
        )
    metadata_only = ("legacy-valid", "declaration-only", "partial-capability")
    if variant not in metadata_only:
        add_file(
            archive,
            "fault-affinity/app/src/reference-kit/discovery-cli.mjs",
            "// fixture discovery controller\n",
            0o755 if variant == "guided-source-wrong-mode" else 0o644,
        )
    if variant not in (*metadata_only, "partial-discovery"):
        add_file(archive, "fault-affinity/bin/discover-reference", "#!/bin/sh\ntouch WORKLOAD_RAN\n", 0o755)
        add_file(
            archive,
            "fault-affinity/app/src/reference-kit/confirmation-cli.mjs",
            "// fixture confirmation controller\n",
        )
    if variant not in (*metadata_only, "partial-discovery", "partial-confirmation"):
        if variant == "guided-launcher-wrong-type":
            archive.addfile(info("fault-affinity/bin/confirm-reference", 0o755, tarfile.DIRTYPE))
        else:
            add_file(
                archive,
                "fault-affinity/bin/confirm-reference",
                "#!/bin/sh\ntouch WORKLOAD_RAN\n",
                0o644 if variant == "guided-launcher-wrong-mode" else 0o755,
            )
    add_file(archive, "fault-affinity/bin/run-reference", "#!/bin/sh\ntouch WORKLOAD_RAN\n", 0o755)
    add_file(archive, "fault-affinity/share/prepare-results", "#!/bin/sh\nexit 0\n", 0o755)
    add_file(archive, "fault-affinity/runtime/controller/bin/node", controller_payload, 0o755)
    add_file(archive, "fault-affinity/runtime/reference/bin/node", reference_payload, 0o755)
    release_payload = "{not json" if variant == "malformed-release" else json.dumps(release)
    add_file(archive, "fault-affinity/RELEASE.json", release_payload)
    mode_manifest = {
        "schemaVersion": 1,
        "files": [
            {"path": "LICENSES/MIT.txt", "mode": "0644"},
            {"path": "README.txt", "mode": "0644"},
            {"path": "RELEASE.json", "mode": "0644"},
            {"path": "app/child.mjs", "mode": "0644"},
            {"path": "app/src/reference-kit/controller.mjs", "mode": "0644"},
            {"path": "bin/run-reference", "mode": "0755"},
            {"path": "runtime/controller/bin/node", "mode": "0755"},
            {"path": "runtime/reference/bin/node", "mode": "0755"},
            {"path": "share/prepare-results", "mode": "0755"},
        ],
    }
    if variant not in metadata_only:
        mode_manifest["files"].append(
            {
                "path": "app/src/reference-kit/discovery-cli.mjs",
                "mode": "0755" if variant == "guided-source-wrong-mode" else "0644",
            }
        )
    if variant not in (*metadata_only, "partial-discovery"):
        mode_manifest["files"].append(
            {"path": "bin/discover-reference", "mode": "0755"}
        )
        mode_manifest["files"].append(
            {"path": "app/src/reference-kit/confirmation-cli.mjs", "mode": "0644"}
        )
    if variant not in (*metadata_only, "partial-discovery", "partial-confirmation", "guided-launcher-wrong-type"):
        mode_manifest["files"].append(
            {
                "path": "bin/confirm-reference",
                "mode": "0644" if variant == "guided-launcher-wrong-mode" else "0755",
            }
        )
    if variant == "bad-manifest":
        mode_manifest["files"][0]["mode"] = "0666"
    add_file(archive, "fault-affinity/MODE-MANIFEST.json", json.dumps(mode_manifest))

    if variant == "traversal":
        add_file(archive, "fault-affinity/../escape", "bad")
    elif variant == "absolute":
        add_file(archive, "/fault-affinity/escape", "bad")
    elif variant == "backslash":
        add_file(archive, "fault-affinity/app\\escape", "bad")
    elif variant in ("symlink", "hardlink"):
        member = info(
            "fault-affinity/app/link",
            0o777,
            tarfile.SYMTYPE if variant == "symlink" else tarfile.LNKTYPE,
        )
        member.linkname = "../README.txt"
        archive.addfile(member)
    elif variant == "fifo":
        archive.addfile(info("fault-affinity/app/pipe", 0o644, tarfile.FIFOTYPE))
    elif variant == "character-device":
        member = info("fault-affinity/app/device", 0o600, tarfile.CHRTYPE)
        member.devmajor = 1
        member.devminor = 3
        archive.addfile(member)
    elif variant == "socket-header":
        archive.addfile(info("fault-affinity/app/socket", 0o600, b"s"))
    elif variant == "duplicate":
        add_file(archive, "fault-affinity/app/file", "first")
        add_file(archive, "fault-affinity/app/file", "second")
    elif variant == "bad-mode":
        add_file(archive, "fault-affinity/app/writable", "bad", 0o666)
    elif variant == "bad-layout":
        add_file(archive, "fault-affinity/secrets.txt", "bad")
    elif variant == "gnu-longname":
        add_file(archive, "fault-affinity/app/" + ("a" * 140), "bad")
    elif variant == "pax":
        member = info("fault-affinity/app/pax", 0o644)
        member.pax_headers = {"comment": "unsupported"}
        member.size = 3
        archive.addfile(member, io.BytesIO(b"bad"))
    elif variant == "too-many":
        for index in range(4090):
            add_file(archive, f"fault-affinity/app/f{index:04d}", b"")

if variant == "truncated":
    data = archive_path.read_bytes()
    archive_path.write_bytes(data[: len(data) // 2])

digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
if variant == "bad-checksum":
    digest = "f" * 64
(destination / f"{archive_path.name}.sha256").write_text(
    f"{digest}  {archive_path.name}\n", encoding="ascii"
)
