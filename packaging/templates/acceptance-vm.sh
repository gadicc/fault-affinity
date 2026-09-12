#!/bin/sh
set -eu

fail() {
  printf 'VM acceptance error: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 1 ] || fail "expected the mounted candidate directory"
[ "$(/usr/bin/id -u)" -ne 0 ] || fail "must run as the live-session user"
virtualization=$(systemd-detect-virt 2>/dev/null) ||
  fail "cannot confirm the QEMU virtualization boundary"
case "$virtualization" in
  kvm|qemu) ;;
  *) fail "this helper runs only inside QEMU/KVM" ;;
esac

finish() {
  status=$?
  trap - EXIT
  printf 'FAULT_AFFINITY_VM_STATUS=%s\n' "$status"
  sync || true
  sudo /usr/sbin/poweroff || true
  exit "$status"
}
trap finish EXIT

candidate_dir=$(CDPATH= cd -- "$1" && pwd -P)
[ "$(findmnt -n -o FSTYPE --target "$candidate_dir")" = iso9660 ] ||
  fail "candidate support is not mounted from read-only ISO media"

. /etc/os-release
[ "${ID:-}" = ubuntu ] || fail "guest is not Ubuntu"
[ "${VERSION_ID:-}" = 26.04 ] || fail "guest is not Ubuntu 26.04"
[ "$(/usr/bin/uname -m)" = x86_64 ] || fail "guest is not x86-64"

for command_path in /usr/bin/python3 /usr/bin/sha256sum /usr/bin/taskset \
  /usr/bin/wget /usr/bin/yes
do
  [ -x "$command_path" ] || fail "missing stock live-image command $command_path"
done

results_dir=/mnt/fault-affinity-results
sudo mkdir -p "$results_dir"
sudo mount -o rw /dev/disk/by-label/FA_RESULTS "$results_dir"
[ "$(findmnt -n -o FSTYPE --target "$results_dir")" = ext4 ] ||
  fail "temporary result media is not ext4"
sudo chown "$(/usr/bin/id -u):$(/usr/bin/id -g)" "$results_dir"

cd "$candidate_dir"
/usr/bin/sha256sum --check ACCEPTANCE-SUPPORT-SHA256SUMS
/usr/bin/sha256sum --check SHA256SUMS

extract_dir="$HOME/fault-affinity-acceptance"
[ ! -e "$extract_dir" ] || fail "acceptance extraction path already exists"
mkdir "$extract_dir"
/usr/bin/python3 safe-extract.py fault-affinity-live-linux-x64.tar.gz "$extract_dir"
kit_dir="$extract_dir/fault-affinity"

"$kit_dir/runtime/controller/bin/node" --version
"$kit_dir/runtime/reference/bin/node" --version
"$kit_dir/bin/run-reference" --help
"$kit_dir/share/prepare-results" --help

before_inventory=$(find "$results_dir" -xdev -mindepth 1 \
  -printf '%P\t%y\t%s\n' | LC_ALL=C sort | sha256sum)
plan=$("$kit_dir/bin/run-reference" \
  --results-root "$results_dir" \
  --target-cpu 3 \
  --controller-cpu 2 \
  --load-cpus 0-1 \
  --runs 1 \
  --dry-run 2>&1)
printf '%s\n' "$plan"
printf '%s\n' "$plan" | grep -F "Fault Affinity reference dry run" >/dev/null
after_inventory=$(find "$results_dir" -xdev -mindepth 1 \
  -printf '%P\t%y\t%s\n' | LC_ALL=C sort | sha256sum)
[ "$before_inventory" = "$after_inventory" ] ||
  fail "dry run created content on the results volume"

printf 'FAULT_AFFINITY_VM_RELEASE=%s\n' \
  "$("$kit_dir/runtime/controller/bin/node" -p \
    "JSON.parse(require('fs').readFileSync(process.argv[1])).release.version" \
    "$kit_dir/RELEASE.json")"
printf 'FAULT_AFFINITY_VM_COMMIT=%s\n' \
  "$("$kit_dir/runtime/controller/bin/node" -p \
    "JSON.parse(require('fs').readFileSync(process.argv[1])).release.sourceCommit" \
    "$kit_dir/RELEASE.json")"
printf 'FAULT_AFFINITY_VM_ACCEPTANCE_OK\n'
