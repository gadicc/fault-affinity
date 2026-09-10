#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

passes=0
bootstrap="$temporary/fault-affinity-run-fixture"
test "$(grep -c '^TEST_FIXTURE_MODE = False$' "$repository/site/run")" -eq 1
sed 's/^TEST_FIXTURE_MODE = False$/TEST_FIXTURE_MODE = True/' \
  "$repository/site/run" >"$bootstrap"
test "$(grep -c '^TEST_FIXTURE_MODE = True$' "$bootstrap")" -eq 1
test "$(grep -c '^TEST_FIXTURE_MODE = False$' "$bootstrap" || true)" -eq 0
passes=$((passes + 1))

make_fixture() {
  name=$1
  variant=$2
  python3 "$repository/site/tests/make-fixture.py" "$temporary/releases/$name" "$variant"
}

expect_success() {
  name=$1
  mkdir -p "$temporary/work/$name"
  (
    cd "$temporary/work/$name"
    FAULT_AFFINITY_TEST_RELEASE_DIR="$temporary/releases/$name" \
      FAULT_AFFINITY_TEST_TAG=v0.1.0 \
      bash "$bootstrap" --version v0.1.0 >output 2>&1
    test -f fault-affinity-v0.1.0/RELEASE.json
    test -x fault-affinity-v0.1.0/bin/run-reference
    test ! -e WORKLOAD_RAN
    grep -q "No workload was started" output
  )
  passes=$((passes + 1))
}

expect_failure() {
  name=$1
  mkdir -p "$temporary/work/$name"
  if (
    cd "$temporary/work/$name"
    FAULT_AFFINITY_TEST_RELEASE_DIR="$temporary/releases/$name" \
      FAULT_AFFINITY_TEST_TAG=v0.1.0 \
      bash "$bootstrap" --version v0.1.0 >output 2>&1
  ); then
    echo "not ok - bootstrap accepted $name" >&2
    exit 1
  fi
  test ! -e "$temporary/work/$name/fault-affinity-v0.1.0"
  passes=$((passes + 1))
}

make_fixture valid valid
expect_success valid

mkdir -p "$temporary/work/latest"
(
  cd "$temporary/work/latest"
  FAULT_AFFINITY_TEST_RELEASE_DIR="$temporary/releases/valid" \
    FAULT_AFFINITY_TEST_TAG=v0.1.0 \
    bash "$bootstrap" >output 2>&1
  test -f fault-affinity-v0.1.0/RELEASE.json
  test ! -e WORKLOAD_RAN
)
passes=$((passes + 1))

for variant in \
  bad-checksum truncated traversal absolute backslash symlink hardlink fifo \
  character-device socket-header duplicate bad-mode bad-layout gnu-longname pax \
  malformed-release bad-release runtime-mismatch bad-manifest missing-required \
  missing-essential too-many
do
  make_fixture "$variant" "$variant"
  expect_failure "$variant"
done

mkdir -p "$temporary/work/existing/fault-affinity-v0.1.0"
if (
  cd "$temporary/work/existing"
  FAULT_AFFINITY_TEST_RELEASE_DIR="$temporary/releases/valid" \
    FAULT_AFFINITY_TEST_TAG=v0.1.0 \
    bash "$bootstrap" --version v0.1.0 >/dev/null 2>&1
); then
  echo "not ok - bootstrap accepted an existing destination" >&2
  exit 1
fi
passes=$((passes + 1))

mkdir -p "$temporary/releases/missing" "$temporary/work/missing"
if (
  cd "$temporary/work/missing"
  FAULT_AFFINITY_TEST_RELEASE_DIR="$temporary/releases/missing" \
    FAULT_AFFINITY_TEST_TAG=v0.1.0 \
    bash "$bootstrap" --version v0.1.0 >/dev/null 2>&1
); then
  echo "not ok - bootstrap accepted a missing download" >&2
  exit 1
fi
passes=$((passes + 1))

for variable in \
  LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT LD_DEBUG \
  PYTHONHOME PYTHONPATH PYTHONINSPECT PYTHONSTARTUP PYTHONBREAKPOINT PYTHONUSERBASE
do
  if /usr/bin/env "$variable=" /bin/bash "$bootstrap" --version v0.1.0 \
    >"$temporary/injection-output" 2>&1
  then
    echo "not ok - bootstrap accepted injection variable $variable" >&2
    exit 1
  fi
  grep -q "$variable" "$temporary/injection-output"
  passes=$((passes + 1))
done

mkdir -p "$temporary/fake-root"
cat >"$temporary/fake-root/id" <<'EOF'
#!/bin/sh
echo 0
EOF
chmod 755 "$temporary/fake-root/id"
sed "s|/usr/bin/id|$temporary/fake-root/id|" "$bootstrap" >"$temporary/root-run"
if bash "$temporary/root-run" --version v0.1.0 >/dev/null 2>&1; then
  echo "not ok - bootstrap accepted root" >&2
  exit 1
fi
passes=$((passes + 1))

mkdir -p "$temporary/fake-arch"
cat >"$temporary/fake-arch/id" <<'EOF'
#!/bin/sh
echo 1000
EOF
cat >"$temporary/fake-arch/uname" <<'EOF'
#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo aarch64 ;;
  *) exit 2 ;;
esac
EOF
chmod 755 "$temporary/fake-arch/id" "$temporary/fake-arch/uname"
sed \
  -e "s|/usr/bin/id|$temporary/fake-arch/id|" \
  -e "s|/usr/bin/uname|$temporary/fake-arch/uname|g" \
  "$bootstrap" >"$temporary/arch-run"
if bash "$temporary/arch-run" --version v0.1.0 >/dev/null 2>&1; then
  echo "not ok - bootstrap accepted an unsupported architecture" >&2
  exit 1
fi
passes=$((passes + 1))

mkdir -p "$temporary/releases/oversized"
truncate -s 536870913 "$temporary/releases/oversized/fault-affinity-live-linux-x64.tar.gz"
printf '%064d  %s\n' 0 fault-affinity-live-linux-x64.tar.gz \
  >"$temporary/releases/oversized/fault-affinity-live-linux-x64.tar.gz.sha256"
expect_failure oversized

echo "ok - $passes bootstrap fixture cases"
