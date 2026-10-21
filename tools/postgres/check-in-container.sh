#!/usr/bin/env bash
# Runs inside the pinned container (check.sh). As root it moves the build and
# checks its libraries; then, as an unprivileged user, it runs the server and
# applies the migrations (`check-in-container.sh server <prefix>`).
set -euo pipefail

fail() {
  echo "[postgres] FAIL: $*" >&2
  exit 1
}

if [ "${1:-}" = server ]; then
  PG="$2"
  "$PG/bin/initdb" -D "$HOME/data" -A peer --no-instructions > "$HOME/initdb.log"
  mkdir "$HOME/socket"
  "$PG/bin/pg_ctl" -D "$HOME/data" -l "$HOME/server.log" -w \
    -o "-c listen_addresses='' -c unix_socket_directories=$HOME/socket" start > /dev/null
  # Warnings and errors only: 0025's "does not exist, skipping" is expected here.
  q() { PGOPTIONS='-c client_min_messages=warning' "$PG/bin/psql" -X -q -v ON_ERROR_STOP=1 -h "$HOME/socket" -d postgres "$@"; }

  # 3. Socket-only, reached with peer authentication (no password exists).
  [ "$(q -tAc 'SHOW listen_addresses')" = "" ] || fail "the server listens on TCP"
  echo "[postgres] ok: socket only, peer authentication"

  # 4. Every migration, in order, as the reader's tests apply them.
  for f in /migrations/*.sql; do
    q -f "$f" > /dev/null || fail "$(basename "$f") did not apply"
  done
  echo "[postgres] ok: $(find /migrations -name '*.sql' | wc -l) migrations applied"
  ext="$(q -tAc "SELECT string_agg(extname, ' ' ORDER BY extname) FROM pg_extension")"
  [ "$ext" = "pg_trgm plpgsql" ] || fail "extensions: $ext"
  echo "[postgres] ok: extensions $ext"

  "$PG/bin/pg_ctl" -D "$HOME/data" -w stop > /dev/null
  exit 0
fi

# 1. Moved: a different path from the one it was built for.
PG=/opt/somewhere-else/postgresql
mkdir -p /opt/somewhere-else
cp -a /build/postgresql "$PG"
ldd "$PG/bin/psql" | grep -q "libpq.so.5 => $PG/bin/../lib/libpq.so.5" \
  || fail "psql does not load the build's own libpq: $(ldd "$PG/bin/psql" | grep libpq)"
for bin in "$PG"/bin/*; do
  if ldd "$bin" 2> /dev/null | grep -q "not found"; then
    fail "$bin: $(ldd "$bin" | grep "not found")"
  fi
done
echo "[postgres] ok: runs from a moved path, with its own libpq"

# 2. Every library the server loads, indirect ones included, but the kernel's
# vDSO and the loader: only Debian 13's base system.
needed="$(ldd "$PG/bin/postgres" | awk '{print $1}' | grep -v -e linux-vdso -e ld-linux | sort | tr '\n' ' ')"
[ "$needed" = "libc.so.6 libm.so.6 libz.so.1 " ] || fail "the server loads: $needed"
echo "[postgres] ok: the server loads only $needed"

useradd -m checker
chown -R checker "$PG"
su checker -s /bin/bash -c "/check-in-container.sh server $PG"
