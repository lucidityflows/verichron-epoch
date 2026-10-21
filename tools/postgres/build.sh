#!/usr/bin/env bash
#
# Build the Lab bundle's PostgreSQL from source (EPOCH-477).
#
#   tools/postgres/build.sh <output directory>
#
# Downloads the pinned source once (into tools/postgres/.cache), refuses it
# unless its SHA-256 is the pinned one, and builds it in the pinned Debian 13
# container. The result is <output directory>/postgresql, an installation that
# can be moved: every binary finds its libraries at $ORIGIN/../lib.
#
# Build options (docs/decisions.md):
#   --without-icu       collations come from libc; ICU would add libicu
#   --without-readline  readline is GPL-3.0; the bundled psql is for support only
#   no OpenSSL          the server is socket-only, so TLS is never used
#   zlib, from Debian   pg_dump's compression, for the export before an upgrade
#
# Needs Docker. The compile runs for several minutes.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <output directory>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=versions.env
. "$HERE/versions.env"

OUT="$(mkdir -p "$1" && cd "$1" && pwd)"
if [ -e "$OUT/postgresql" ]; then
  echo "[postgres] $OUT/postgresql already exists; choose an empty output directory" >&2
  exit 1
fi

CACHE="$HERE/.cache"
TARBALL="postgresql-$POSTGRES_VERSION.tar.bz2"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$TARBALL" ]; then
  echo "[postgres] downloading $TARBALL"
  curl -sSfL -o "$CACHE/$TARBALL.part" "https://ftp.postgresql.org/pub/source/v$POSTGRES_VERSION/$TARBALL"
  mv "$CACHE/$TARBALL.part" "$CACHE/$TARBALL"
fi
echo "$POSTGRES_SHA256  $CACHE/$TARBALL" | sha256sum -c --quiet - || {
  echo "[postgres] $TARBALL does not match the pinned SHA-256; refusing it" >&2
  exit 1
}

echo "[postgres] building $POSTGRES_VERSION in $BUILD_IMAGE (several minutes)"
docker run --rm \
  -e POSTGRES_VERSION="$POSTGRES_VERSION" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$CACHE/$TARBALL:/src/$TARBALL:ro" \
  -v "$HERE/in-container.sh:/in-container.sh:ro" \
  -v "$OUT:/out" \
  "$BUILD_IMAGE" /in-container.sh

echo "[postgres] built: $OUT/postgresql"
