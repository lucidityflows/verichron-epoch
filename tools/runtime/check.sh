#!/usr/bin/env bash
#
# Check the Lab bundle's Python parts (EPOCH-439), in the pinned container:
#
#   tools/runtime/check.sh <bundle directory>
#
# The bundle is moved to another path, with a decoy interpreter left where it
# was built. Then:
# - every environment's interpreter link is relative, and it runs on the moved
#   bundle's interpreter, never the decoy;
# - every Python stage, the migrations, the runtime login and the registry load
#   from source/, and read the contract files beside them;
# - psycopg2 loads the bundle's libpq, reports its version, and queries the
#   bundled server over its socket;
# - the decrypt runs, and iLEAPP loads every plugin, HEIF from pi-heif.

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
for d in postgresql python source runtime-venv tools; do
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
