#!/usr/bin/env bash
#
# Check the Lab bundle's services (EPOCH-478), in the pinned container:
#
#   tools/services/check.sh <bundle directory>
#
# The bundle needs the parts the services use: postgresql/
# (tools/postgres/build.sh), python/, source/, runtime-venv/ and tools/
# (tools/runtime/build.sh), and node/ and services/ (tools/services/build.sh). It is moved to another path and run with nothing
# on PATH but the base system, so pnpm, uv or a checkout can't stand in. Then,
# with the bundled Node:
# - the orchestrator finds the bundle from its own location, validates the
#   bundle's Python, discovers every stage in source/, and stops, as it should,
#   at an empty workspace;
# - the processor runs the bundle's decrypt to identify it, reads iLEAPP's
#   commit as the build recorded it, and stops at a source with no backups.
# - the database server (EPOCH-477) creates the database on its first start:
#   no TCP listener, every migration applied, only the extensions the schema
#   uses; the runtime login reads but cannot TRUNCATE, and the OS account
#   reaches no role but the two mapped. It stops, starts again on the same
#   database, takes two overlapping starts without one stopping the other's
#   server, waits while another process holds its lock, and refuses a database behind this version and one whose first
#   start never finished.
# Assembly writes the bundle's MANIFEST (step 6); until then the check stands
# an empty one in for it.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <bundle directory>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../postgres/versions.env
. "$REPO_ROOT/tools/postgres/versions.env"
NODE_VERSION="$(sed -n 's/^node = "\(.*\)"$/\1/p' "$REPO_ROOT/mise.toml")"
BUNDLE="$(cd "$1" && pwd)"
for d in node services postgresql python source runtime-venv tools; do
  [ -e "$BUNDLE/$d" ] || {
    echo "[services] no $BUNDLE/$d; run tools/runtime/build.sh and tools/services/build.sh first" >&2
    exit 1
  }
done

docker run --rm \
  -e NODE_VERSION="$NODE_VERSION" \
  -v "$BUNDLE:/built:ro" \
  -v "$HERE/check-in-container.sh:/check-in-container.sh:ro" \
  "$BUILD_IMAGE" /check-in-container.sh

echo "[services] all checks passed"
