#!/usr/bin/env bash
#
# Check the Lab bundle's iPhone tools and sqlite3 (EPOCH-472, EPOCH-439), in
# the pinned container:
#
#   tools/iphone/check.sh <bundle directory>
#
# The bundle is moved to another path and run with nothing on PATH but the
# base system. Then:
# - every tool a pull runs, and sqlite3, runs from the bundle;
# - every binary's library search path is relative only, and each loads its
#   iPhone libraries from the bundle's lib/ and nothing else but libc, libm,
#   OpenSSL, zlib and zstd, which Debian 13's base system has;
# - sqlite3 is the pinned version, and its .recover rebuilds a database.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <bundle directory>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=versions.env
. "$HERE/versions.env"
# shellcheck source=../postgres/versions.env
. "$REPO_ROOT/tools/postgres/versions.env"
BUNDLE="$(cd "$1" && pwd)"
for d in bin lib; do
  [ -d "$BUNDLE/$d" ] || {
    echo "[iphone] no $BUNDLE/$d; run tools/iphone/build.sh first" >&2
    exit 1
  }
done

docker run --rm \
  -e SQLITE_VERSION="$SQLITE_VERSION" \
  -v "$BUNDLE/bin:/built/bin:ro" \
  -v "$BUNDLE/lib:/built/lib:ro" \
  -v "$HERE/check-in-container.sh:/check-in-container.sh:ro" \
  "$BUILD_IMAGE" /check-in-container.sh

echo "[iphone] all checks passed"
