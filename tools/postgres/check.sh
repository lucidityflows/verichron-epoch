#!/usr/bin/env bash
#
# Check a PostgreSQL built by build.sh (EPOCH-477), in the pinned container:
#
#   tools/postgres/check.sh <build.sh's output directory>
#
# 1. Moved to another path, as the bundle is, every binary still finds its
#    libraries, and psql loads the build's own libpq.
# 2. The server loads nothing beyond the build and Debian 13's base system
#    (libc, libm and zlib, which dpkg itself depends on).
# 3. It runs socket-only (no TCP port) with peer authentication.
# 4. Every migration applies, in order, and leaves exactly the extensions the
#    schema uses.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <build.sh's output directory>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=versions.env
. "$HERE/versions.env"
OUT="$(cd "$1" && pwd)"
[ -x "$OUT/postgresql/bin/postgres" ] || {
  echo "[postgres] no build at $OUT/postgresql; run tools/postgres/build.sh first" >&2
  exit 1
}

docker run --rm \
  -v "$OUT/postgresql:/build/postgresql:ro" \
  -v "$REPO_ROOT/packages/etl-db-writer/migrations:/migrations:ro" \
  -v "$HERE/check-in-container.sh:/check-in-container.sh:ro" \
  "$BUILD_IMAGE" /check-in-container.sh

echo "[postgres] all checks passed"
