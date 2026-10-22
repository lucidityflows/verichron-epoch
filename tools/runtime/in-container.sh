#!/usr/bin/env bash
# Runs inside the pinned build container (build.sh). Root installs the
# compiler; an unprivileged user with the host's uid lays out the bundle's
# Python parts and builds them (`in-container.sh build`), so the result in
# /bundle belongs to whoever ran build.sh.
set -euo pipefail

if [ "${1:-}" = build ]; then
  # The commit's files: our Python source, and each tool beside it.
  mkdir -p /bundle/source /bundle/tools
  (cd /source && tar -c --exclude=./tools .) | tar -x -C /bundle/source
  cp -a /source/tools/decrypt /source/tools/ileapp /bundle/tools/

  # The bundle's pg_config first, so psycopg2 builds against its libpq. No
  # cache: a psycopg2 wheel built against another libpq must never be reused.
  export PATH=/bundle/postgresql/bin:/opt/uv:$PATH UV_NO_CACHE=1 UV_PYTHON_INSTALL_DIR=/bundle/python
  # Named explicitly: tools/ has no .python-version above it in the bundle.
  python_version="$(tr -d '[:space:]' < /source/.python-version)"

  # What runs: the lockfile with no dependency groups. psycopg2 finds libpq
  # from runtime-venv/lib/python3.14/site-packages/psycopg2, up to the root.
  uv venv --relocatable -q --python "$python_version" /bundle/runtime-venv
  (cd /bundle/source && UV_PROJECT_ENVIRONMENT=/bundle/runtime-venv \
    LDFLAGS="-Wl,-rpath,\$ORIGIN/../../../../../postgresql/lib" \
    uv sync --locked --no-default-groups -q)

  # Each tool from its own lockfile, into its own environment, as in development.
  for tool in decrypt ileapp; do
    uv venv --relocatable -q --python "$python_version" "/bundle/tools/$tool/.venv"
    (cd "/bundle/tools/$tool" && uv sync --locked -q)
  done

  python="$(echo /bundle/python/cpython-"$python_version"-*/bin/python3)"
  for env in /bundle/runtime-venv /bundle/tools/decrypt/.venv /bundle/tools/ileapp/.venv; do
    "$python" -I /relocate.py "$env" /bundle
  done
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq > /dev/null
apt-get install -y -qq --no-install-recommends build-essential ca-certificates > /dev/null
mkdir -p /opt/uv && tar -xzf /uv.tar.gz -C /opt/uv --strip-components=1

groupadd -o -g "$HOST_GID" builder
useradd -o -m -u "$HOST_UID" -g "$HOST_GID" builder

su builder -s /bin/bash -c "/in-container.sh build"
