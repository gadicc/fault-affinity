#!/usr/bin/env python3
"""Extract a generated fault-affinity USTAR archive without trusting tar paths."""

import os
import pathlib
import shutil
import stat
import sys
import tarfile

MAX_COMPRESSED_BYTES = 256 * 1024 * 1024
MAX_EXPANDED_BYTES = 1024 * 1024 * 1024
MAX_FILE_BYTES = 256 * 1024 * 1024
MAX_MEMBERS = 20_000
ALLOWED_FILE_MODES = {0o644, 0o755}
ALLOWED_DIRECTORY_MODES = {0o755}


def fail(message: str) -> None:
    raise ValueError(message)


def canonical_name(name: str) -> tuple[str, ...]:
    if not name or "\x00" in name or "\\" in name or name.startswith("/"):
        fail(f"unsafe archive member path: {name!r}")
    parts = tuple(part for part in name.split("/") if part != "")
    if not parts or any(part in (".", "..") for part in parts):
        fail(f"unsafe archive member path: {name!r}")
    canonical = "/".join(parts)
    if canonical != name.rstrip("/") or parts[0] != "fault-affinity":
        fail(f"non-canonical or unexpected archive member path: {name!r}")
    return parts


def inspect(archive: pathlib.Path) -> list[tuple[tarfile.TarInfo, tuple[str, ...]]]:
    archive_stat = archive.lstat()
    if not stat.S_ISREG(archive_stat.st_mode) or archive_stat.st_size > MAX_COMPRESSED_BYTES:
        fail("archive must be a bounded regular file")
    seen: set[str] = set()
    expanded = 0
    members: list[tuple[tarfile.TarInfo, tuple[str, ...]]] = []
    with tarfile.open(archive, mode="r:gz", format=tarfile.USTAR_FORMAT) as handle:
        for index, member in enumerate(handle):
            if index >= MAX_MEMBERS:
                fail("archive contains too many members")
            parts = canonical_name(member.name)
            name = "/".join(parts)
            if name in seen:
                fail(f"archive contains duplicate member: {name}")
            seen.add(name)
            if member.pax_headers or member.sparse is not None or member.uid != 0 or member.gid != 0:
                fail(f"archive member has unsupported metadata: {name}")
            mode = member.mode & 0o7777
            if member.isdir():
                if mode not in ALLOWED_DIRECTORY_MODES or member.size != 0:
                    fail(f"archive directory has an unsupported mode or size: {name}")
            elif member.isreg():
                if mode not in ALLOWED_FILE_MODES or member.size > MAX_FILE_BYTES:
                    fail(f"archive file has an unsupported mode or size: {name}")
                expanded += member.size
                if expanded > MAX_EXPANDED_BYTES:
                    fail("archive expands beyond the release size limit")
            else:
                fail(f"archive contains a link or special member: {name}")
            members.append((member, parts))
    if not members or "fault-affinity" not in seen:
        fail("archive does not contain the expected top-level directory")
    return members


def extract(archive: pathlib.Path, destination: pathlib.Path) -> None:
    members = inspect(archive)
    destination_stat = destination.lstat()
    if not stat.S_ISDIR(destination_stat.st_mode) or any(destination.iterdir()):
        fail("extraction destination must be an existing empty directory")

    directories = sorted(
        ((member, parts) for member, parts in members if member.isdir()),
        key=lambda item: (len(item[1]), item[1]),
    )
    files = [(member, parts) for member, parts in members if member.isreg()]
    for member, parts in directories:
        target = destination.joinpath(*parts)
        target.mkdir(mode=member.mode & 0o777, parents=False, exist_ok=False)

    with tarfile.open(archive, mode="r:gz", format=tarfile.USTAR_FORMAT) as handle:
        by_name = {member.name.rstrip("/"): member for member in handle}
        for inspected_member, parts in files:
            name = "/".join(parts)
            member = by_name.get(name)
            if member is None or not member.isreg() or member.size != inspected_member.size:
                fail(f"archive changed between inspection and extraction: {name}")
            target = destination.joinpath(*parts)
            source = handle.extractfile(member)
            if source is None:
                fail(f"could not read archive member: {name}")
            descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(descriptor, "wb", closefd=True) as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
                if target.stat().st_size != member.size:
                    fail(f"archive member size changed while extracting: {name}")
                target.chmod(member.mode & 0o777)
            except Exception:
                target.unlink(missing_ok=True)
                raise


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: safe-extract.py ARCHIVE EMPTY_DESTINATION", file=sys.stderr)
        return 2
    try:
        extract(pathlib.Path(sys.argv[1]).resolve(strict=True), pathlib.Path(sys.argv[2]).resolve(strict=True))
    except (OSError, tarfile.TarError, ValueError) as error:
        print(f"safe-extract: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
