#!/usr/bin/env bash
# Runs inside the pinned build container (build.sh). Root installs the build
# tools; an unprivileged user with the host's uid compiles and installs, so the
# result in /out belongs to whoever ran build.sh.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends \
  build-essential bison flex pkg-config bzip2 zlib1g-dev >/dev/null

groupadd -o -g "$HOST_GID" builder
useradd -o -m -u "$HOST_UID" -g "$HOST_GID" builder

su builder -s /bin/bash -c '
set -euo pipefail
cd ~
tar xjf /src/postgresql-$POSTGRES_VERSION.tar.bz2
cd postgresql-$POSTGRES_VERSION
# make turns \$$ORIGIN into \$ORIGIN, and the recipe shell into a literal
# $ORIGIN: the binaries look for libraries beside themselves, wherever moved.
./configure --prefix=/out/postgresql --without-icu --without-readline --disable-rpath \
  "LDFLAGS=-Wl,-rpath,\\\$\$ORIGIN/../lib" > ~/configure.log 2>&1 || { tail -30 ~/configure.log; exit 1; }
make -s -j"$(nproc)" world-bin > ~/make.log 2>&1 || { tail -30 ~/make.log; exit 1; }
make -s install-world-bin > ~/install.log 2>&1 || { tail -30 ~/install.log; exit 1; }
'
