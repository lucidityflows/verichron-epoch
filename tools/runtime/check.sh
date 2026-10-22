#!/usr/bin/env bash
#
# Check the Lab bundle's Python environment against its PostgreSQL (EPOCH-439),
# in the pinned container:
#
#   tools/runtime/check.sh <bundle directory>
#
# With the bundle moved to another path, psycopg2 loads the bundle's own libpq,
# reports the bundled PostgreSQL's version, and queries the bundled server over
# its socket.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <bundle directory>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../postgres/versions.env
. "$REPO_ROOT/tools/postgres/versions.env"
BUNDLE="$(cd "$1" && pwd)"
for d in postgresql python runtime-venv; do
  [ -d "$BUNDLE/$d" ] || {
    echo "[runtime] no $BUNDLE/$d; run tools/postgres/build.sh and tools/runtime/build.sh first" >&2
    exit 1
  }
done

docker run --rm \
  -e POSTGRES_VERSION="$POSTGRES_VERSION" \
  -v "$BUNDLE:/built:ro" \
  -v "$HERE/check-in-container.sh:/check-in-container.sh:ro" \
  "$BUILD_IMAGE" /check-in-container.sh

echo "[runtime] all checks passed"
