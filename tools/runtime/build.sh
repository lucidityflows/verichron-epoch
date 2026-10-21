#!/usr/bin/env bash
#
# Build the Lab bundle's Python environment against the bundle's own
# PostgreSQL (EPOCH-439, licensing audit B4).
#
#   tools/runtime/build.sh <bundle directory>
#
# <bundle directory> holds the PostgreSQL that tools/postgres/build.sh made
# (<bundle>/postgresql). This adds, beside it:
#   <bundle>/python        the interpreter .python-version pins, installed by uv
#   <bundle>/runtime-venv  the lockfile with no dependency groups: what runs
#
# psycopg2 is built from source against <bundle>/postgresql's pg_config, and
# finds libpq at $ORIGIN/../../../../../postgresql/lib: from
# runtime-venv/lib/python3.14/site-packages/psycopg2 up to the bundle root, so
# it loads the bundle's libpq wherever the bundle is moved. The source built is
# the commit checked out (git archive HEAD), not uncommitted changes.
#
# Needs Docker and git. Runs for a few minutes.

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
UV_VERSION="$(sed -n 's/^uv = "\(.*\)"$/\1/p' "$REPO_ROOT/mise.toml")"

BUNDLE="$(cd "$1" && pwd)"
[ -x "$BUNDLE/postgresql/bin/pg_config" ] || {
  echo "[runtime] no PostgreSQL at $BUNDLE/postgresql; run tools/postgres/build.sh $1 first" >&2
  exit 1
}
for d in python runtime-venv; do
  if [ -e "$BUNDLE/$d" ]; then
    echo "[runtime] $BUNDLE/$d already exists; start from a bundle holding only postgresql/" >&2
    exit 1
  fi
done

CACHE="$HERE/.cache"
UV_TARBALL="uv-x86_64-unknown-linux-gnu.tar.gz"
mkdir -p "$CACHE/$UV_VERSION"
if [ ! -f "$CACHE/$UV_VERSION/$UV_TARBALL" ]; then
  echo "[runtime] downloading uv $UV_VERSION"
  curl -sSfL -o "$CACHE/$UV_VERSION/$UV_TARBALL.part" \
    "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/$UV_TARBALL"
  mv "$CACHE/$UV_VERSION/$UV_TARBALL.part" "$CACHE/$UV_VERSION/$UV_TARBALL"
fi
echo "$UV_SHA256  $CACHE/$UV_VERSION/$UV_TARBALL" | sha256sum -c --quiet - || {
  echo "[runtime] $UV_TARBALL does not match the pinned SHA-256; refusing it" >&2
  exit 1
}

SOURCE="$(mktemp -d)"
trap 'rm -rf "$SOURCE"' EXIT
git -C "$REPO_ROOT" archive HEAD | tar -x -C "$SOURCE"

echo "[runtime] building the Python environment in $BUILD_IMAGE"
docker run --rm \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$CACHE/$UV_VERSION/$UV_TARBALL:/uv.tar.gz:ro" \
  -v "$SOURCE:/source:ro" \
  -v "$HERE/in-container.sh:/in-container.sh:ro" \
  -v "$BUNDLE:/bundle" \
  "$BUILD_IMAGE" /in-container.sh

echo "[runtime] built: $BUNDLE/python, $BUNDLE/runtime-venv"
