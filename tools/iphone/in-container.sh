#!/usr/bin/env bash
# Runs inside the pinned build container (build.sh), offline from the verified
# sources in /sources. Root installs the build tools; an unprivileged user
# with the host's uid builds (`in-container.sh build`), so the result in
# /bundle belongs to whoever ran build.sh.
set -euo pipefail

# The tools a pull runs (iosBackupSource.ts); nothing else of libimobiledevice ships.
TOOLS=(idevicebackup2 idevicecrashreport idevice_id ideviceinfo plistutil)

if [ "${1:-}" = build ]; then
  prefix="$HOME/prefix"
  mkdir -p "$HOME/src" && cd "$HOME/src"
  while IFS='|' read -r name version _url _sha256 archive args; do
    tar xjf "/sources/$archive"
    (
      cd "$name-$version"
      # shellcheck disable=SC2086 # the pin's configure arguments, split as written
      PKG_CONFIG_PATH="$prefix/lib/pkgconfig" ./configure -q --prefix="$prefix" --disable-static $args > /dev/null
      make -s -j"$(nproc)" > "$HOME/$name.log" 2>&1 || { tail -30 "$HOME/$name.log"; exit 1; }
      make -s install >> "$HOME/$name.log" 2>&1
    )
  done < /sources/pins.txt

  # sqlite3: the shell, with SQLite built into it, no readline (GPL).
  tar xzf "/sources/$SQLITE_TARBALL"
  (
    cd "${SQLITE_TARBALL%.tar.gz}"
    ./configure --prefix="$HOME/sqlite" --disable-shared --disable-readline > "$HOME/sqlite.log" 2>&1 \
      || { tail -30 "$HOME/sqlite.log"; exit 1; }
    make -s -j"$(nproc)" sqlite3 >> "$HOME/sqlite.log" 2>&1 || { tail -30 "$HOME/sqlite.log"; exit 1; }
    cp sqlite3 "$HOME/sqlite3"
  )

  mkdir -p /bundle/bin /bundle/lib
  for tool in "${TOOLS[@]}"; do
    cp "$prefix/bin/$tool" /bundle/bin/
  done
  cp "$HOME/sqlite3" /bundle/bin/sqlite3

  # Each library the tools load from the build, under the name they load it by.
  for lib in $(ldd /bundle/bin/* | awk -v p="$prefix/lib/" 'index($3, p) == 1 {print $1}' | sort -u); do
    cp -L "$prefix/lib/$lib" "/bundle/lib/$lib"
  done
  # libtool also writes the build prefix into each search path; only the relative one stays.
  for f in /bundle/bin/* /bundle/lib/*; do
    case "$f" in */lib/*) path='$ORIGIN' ;; *) path='$ORIGIN/../lib' ;; esac
    patchelf --set-rpath "$path" "$f"
  done
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq > /dev/null
apt-get install -y -qq --no-install-recommends \
  build-essential pkg-config libssl-dev libcurl4-openssl-dev zlib1g-dev bzip2 patchelf > /dev/null

groupadd -o -g "$HOST_GID" builder
useradd -o -m -u "$HOST_UID" -g "$HOST_GID" builder
su builder -s /bin/bash -c "SQLITE_TARBALL=$SQLITE_TARBALL /in-container.sh build"
