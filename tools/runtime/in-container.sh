#!/usr/bin/env bash
# Runs inside the pinned build container (build.sh). Root installs the
# compiler; an unprivileged user with the host's uid builds, so the result in
# /bundle belongs to whoever ran build.sh.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq > /dev/null
apt-get install -y -qq --no-install-recommends build-essential ca-certificates > /dev/null
mkdir -p /opt/uv && tar -xzf /uv.tar.gz -C /opt/uv --strip-components=1

groupadd -o -g "$HOST_GID" builder
useradd -o -m -u "$HOST_UID" -g "$HOST_GID" builder

su builder -s /bin/bash -c '
set -euo pipefail
cp -a /source ~/work && cd ~/work
# The bundle'"'"'s pg_config first, so psycopg2 builds against its libpq. No
# cache: a psycopg2 wheel built against another libpq must never be reused.
export PATH=/bundle/postgresql/bin:/opt/uv:$PATH UV_NO_CACHE=1 UV_PYTHON_INSTALL_DIR=/bundle/python
export UV_PROJECT_ENVIRONMENT=/bundle/runtime-venv
export LDFLAGS="-Wl,-rpath,\$ORIGIN/../../../../../postgresql/lib"
uv sync --locked --no-default-groups -q
'
