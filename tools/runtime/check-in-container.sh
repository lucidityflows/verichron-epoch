#!/usr/bin/env bash
# Runs inside the pinned container (check.sh). As root it moves the bundle and
# checks psycopg2's link to libpq; then, as an unprivileged user, it starts the
# bundled server and connects to it (`check-in-container.sh connect <bundle>`).
set -euo pipefail

fail() {
  echo "[runtime] FAIL: $*" >&2
  exit 1
}

if [ "${1:-}" = connect ]; then
  B="$2"
  "$B/postgresql/bin/initdb" -D "$HOME/data" -A peer --no-instructions > "$HOME/initdb.log"
  mkdir "$HOME/socket"
  "$B/postgresql/bin/pg_ctl" -D "$HOME/data" -l "$HOME/server.log" -w \
    -o "-c listen_addresses='' -c unix_socket_directories=$HOME/socket" start > /dev/null
  # The venv's own python link is absolute (bundle packaging, EPOCH-478), so
  # the moved interpreter runs with the moved environment's site-packages.
  python=("$B"/python/cpython-*/bin/python3)
  site=("$B"/runtime-venv/lib/python3*/site-packages)
  # libpq reports its version as major * 10000 + minor: 17.11 is 170011.
  want=$((${POSTGRES_VERSION%.*} * 10000 + ${POSTGRES_VERSION#*.}))
  "${python[0]}" -I - "${site[0]}" "$HOME/socket" "$want" << 'EOF'
import sys

site, socket, want = sys.argv[1], sys.argv[2], int(sys.argv[3])
sys.path.insert(0, site)
import psycopg2  # noqa: E402

libpq = psycopg2.extensions.libpq_version()
if libpq != want:
    sys.exit(f"[runtime] FAIL: psycopg2 is built against libpq {libpq}, not the bundle's {want}")
with psycopg2.connect(host=socket, dbname="postgres") as conn, conn.cursor() as cur:
    cur.execute("SHOW server_version_num")
    server = int(cur.fetchone()[0])
if server != want:
    sys.exit(f"[runtime] FAIL: connected to PostgreSQL {server}, not the bundle's {want}")
print(f"[runtime] ok: psycopg2 {psycopg2.__version__.split()[0]}, libpq {libpq}, connected to the bundled server")
EOF
  "$B/postgresql/bin/pg_ctl" -D "$HOME/data" -w stop > /dev/null
  exit 0
fi

# Moved: a different path from the one it was built in.
B=/opt/somewhere-else/bundle
mkdir -p /opt/somewhere-else
cp -a /built "$B"
so=("$B"/runtime-venv/lib/python3*/site-packages/psycopg2/_psycopg*.so)
[ -f "${so[0]}" ] || fail "no psycopg2 extension in $B/runtime-venv"
ldd "${so[0]}" | grep -q "libpq.so.5 => $B/runtime-venv/.*/postgresql/lib/libpq.so.5" \
  || fail "psycopg2 does not load the bundle's libpq: $(ldd "${so[0]}" | grep libpq)"
echo "[runtime] ok: moved, psycopg2 loads the bundle's own libpq"

useradd -m checker
chown -R checker "$B"
su checker -s /bin/bash -c "POSTGRES_VERSION=$POSTGRES_VERSION /check-in-container.sh connect $B"
