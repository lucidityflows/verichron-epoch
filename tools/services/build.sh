#!/usr/bin/env bash
#
# Build the Lab bundle's services and the Node that runs them (EPOCH-478).
#
#   tools/services/build.sh <bundle directory>
#
# Adds, beside the bundle's other parts (docs/architecture.md, "The Lab
# bundle"):
#   <bundle>/node      Node, mise.toml's version: bin/node and its LICENSE only
#   <bundle>/services  the orchestrator and processor, each compiled to one file
#                      (orchestrator.mjs, processor.mjs), with the licence
#                      comments of what they include beside them (*.LEGAL.txt)
#
# The services are compiled from this checkout, which must be at the commit
# tools/runtime/build.sh recorded in <bundle>/COMMIT and have no uncommitted
# changes to what the services are built from, so the whole bundle is one
# commit's code; the Node tarball is refused unless its SHA-256 is the pinned
# one. Needs the workspace installed (mise run setup).

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <bundle directory>" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
# shellcheck source=versions.env
. "$HERE/versions.env"
NODE_VERSION="$(sed -n 's/^node = "\(.*\)"$/\1/p' "$REPO_ROOT/mise.toml")"

BUNDLE="$(mkdir -p "$1" && cd "$1" && pwd)"
for d in node services; do
  if [ -e "$BUNDLE/$d" ]; then
    echo "[services] $BUNDLE/$d already exists; start from a bundle without it" >&2
    exit 1
  fi
done

# One commit for the whole bundle: the one tools/runtime/build.sh recorded.
[ -f "$BUNDLE/COMMIT" ] || {
  echo "[services] $BUNDLE/COMMIT is missing; run tools/runtime/build.sh $1 first" >&2
  exit 1
}
recorded="$(cat "$BUNDLE/COMMIT")"
head="$(git -C "$REPO_ROOT" rev-parse HEAD)"
if [ "$recorded" != "$head" ]; then
  echo "[services] the bundle's source/ is commit $recorded, but this checkout is at $head; build both from one commit" >&2
  exit 1
fi

# What the services are built from: their own sources, the workspace packages,
# the dependencies, and this build itself. None may differ from the commit.
changed="$(git -C "$REPO_ROOT" status --porcelain -- apps/orchestrator apps/processor packages \
  package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json mise.toml tools/services)"
if [ -n "$changed" ]; then
  echo "[services] uncommitted changes to what the services are built from; commit them first:" >&2
  echo "$changed" >&2
  exit 1
fi

CACHE="$HERE/.cache"
NODE_TARBALL="node-v$NODE_VERSION-linux-x64.tar.xz"
mkdir -p "$CACHE"
if [ ! -f "$CACHE/$NODE_TARBALL" ]; then
  echo "[services] downloading Node $NODE_VERSION"
  curl -sSfL -o "$CACHE/$NODE_TARBALL.part" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL"
  mv "$CACHE/$NODE_TARBALL.part" "$CACHE/$NODE_TARBALL"
fi
echo "$NODE_SHA256  $CACHE/$NODE_TARBALL" | sha256sum -c --quiet - || {
  echo "[services] $NODE_TARBALL does not match the pinned SHA-256; refusing it" >&2
  exit 1
}
mkdir -p "$BUNDLE/node/bin"
tar -xJf "$CACHE/$NODE_TARBALL" -C "$BUNDLE/node" --strip-components=1 \
  "node-v$NODE_VERSION-linux-x64/bin/node" "node-v$NODE_VERSION-linux-x64/LICENSE"

# The workspace packages the services import, built as they are published (dist/).
for pkg in @verichron/contracts @verichron/workspace-lock @verichron/etl-db-reader; do
  pnpm --dir "$REPO_ROOT" --silent --filter "$pkg" build
done
node "$HERE/compile.mjs" "$BUNDLE/services"

echo "[services] built: $BUNDLE/node (Node $NODE_VERSION), $BUNDLE/services"
