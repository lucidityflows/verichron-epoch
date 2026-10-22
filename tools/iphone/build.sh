#!/usr/bin/env bash
#
# Build the Lab bundle's iPhone tools and sqlite3 (EPOCH-472, EPOCH-439).
#
#   tools/iphone/build.sh <bundle directory>
#
# Adds, beside the bundle's other parts (docs/architecture.md, "The Lab
# bundle"):
#   <bundle>/bin  idevicebackup2, idevicecrashreport, idevice_id, ideviceinfo,
#                 plistutil (what a pull runs) and sqlite3 (the processor's repair pass)
#   <bundle>/lib  the iPhone libraries those tools load, and nothing else
#
# The iPhone libraries are the app's own pins (EPOCH-465, read by
# list-pins.ts), each refused unless its SHA-256 matches; sqlite3 is the pin in
# versions.env, refused unless its SHA-3-256 matches the one sqlite.org
# publishes. Everything is downloaded here, then built offline in the pinned
# Debian 13 container. Every binary finds its libraries at $ORIGIN/../lib, so
# the tools move with the bundle; they load nothing else but libc, libm,
# OpenSSL, zlib and zstd, which Debian 13's base system has. The checkout must
# be at the commit tools/runtime/build.sh recorded in <bundle>/COMMIT, with no
# uncommitted changes to what this builds from. Needs Docker, OpenSSL and the
# workspace installed (mise run setup).

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
  if [ -e "$BUNDLE/$d" ]; then
    echo "[iphone] $BUNDLE/$d already exists; start from a bundle without it" >&2
    exit 1
  fi
done

# One commit for the whole bundle: the one tools/runtime/build.sh recorded.
[ -f "$BUNDLE/COMMIT" ] || {
  echo "[iphone] $BUNDLE/COMMIT is missing; run tools/runtime/build.sh $1 first" >&2
  exit 1
}
recorded="$(cat "$BUNDLE/COMMIT")"
head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [ "$recorded" != "$head" ]; then
  echo "[iphone] the bundle's source/ is commit $recorded, but this checkout is at $head; build both from one commit" >&2
  exit 1
fi
PINS_TS=apps/epoch/src/main/tools/device-backup/ios/toolchain/pins.ts
changed="$(git -C "$REPO_ROOT" status --porcelain -- tools/iphone "$PINS_TS")"
if [ -n "$changed" ]; then
  echo "[iphone] uncommitted changes to what this builds from; commit them first:" >&2
  echo "$changed" >&2
  exit 1
fi

CACHE="$HERE/.cache"
mkdir -p "$CACHE"
fetch() { # <url> <file>
  if [ ! -f "$CACHE/$2" ]; then
    echo "[iphone] downloading $2"
    curl -sSfL -o "$CACHE/$2.part" "$1"
    mv "$CACHE/$2.part" "$CACHE/$2"
  fi
}

pnpm --dir "$REPO_ROOT" --silent exec tsx "$HERE/list-pins.ts" > "$CACHE/pins.txt"
while IFS='|' read -r name _version url sha256 archive _args; do
  fetch "$url" "$archive"
  echo "$sha256  $CACHE/$archive" | sha256sum -c --quiet - || {
    echo "[iphone] $archive ($name) does not match its pinned SHA-256; refusing it" >&2
    exit 1
  }
done < "$CACHE/pins.txt"

SQLITE_TARBALL="$(basename "$SQLITE_URL")"
fetch "$SQLITE_URL" "$SQLITE_TARBALL"
actual="$(openssl dgst -sha3-256 -r "$CACHE/$SQLITE_TARBALL" | awk '{print $1}')"
if [ "$actual" != "$SQLITE_SHA3_256" ]; then
  echo "[iphone] $SQLITE_TARBALL does not match its pinned SHA3-256; refusing it" >&2
  exit 1
fi

echo "[iphone] building the iPhone tools and sqlite3 in $BUILD_IMAGE (several minutes)"
docker run --rm \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -e SQLITE_TARBALL="$SQLITE_TARBALL" -e SQLITE_VERSION="$SQLITE_VERSION" \
  -v "$CACHE:/sources:ro" \
  -v "$HERE/in-container.sh:/in-container.sh:ro" \
  -v "$BUNDLE:/bundle" \
  "$BUILD_IMAGE" /in-container.sh

echo "[iphone] built: $BUNDLE/bin, $BUNDLE/lib"
