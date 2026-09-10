#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
exec node --test "$repo_root/packaging/tests/packaging.test.mjs"
