#!/usr/bin/env bash
# Runs inside the pinned container (check.sh). As root it moves the bundle,
# leaves a decoy where the bundle was built, and checks the environments' links;
# then, as an unprivileged user, it runs what the bundle runs
# (`check-in-container.sh run <bundle>`).
set -euo pipefail

fail() {
  echo "[runtime] FAIL: $*" >&2
  exit 1
}

if [ "${1:-}" = run ]; then
  B="$2"
  entry() { # <environment> <script> [code]: load a script as its process would, without running main().
    "$1/bin/python" -I - "$2" << 'EOF'
import importlib.util
import sys

path = sys.argv[1]
sys.path.insert(0, path.rsplit("/", 1)[0])
spec = importlib.util.spec_from_file_location("entry", path)
spec.loader.exec_module(importlib.util.module_from_spec(spec))
EOF
  }

  # Every environment runs from the moved bundle, never the decoy.
  for env in "$B/runtime-venv" "$B/tools/decrypt/.venv" "$B/tools/ileapp/.venv"; do
    base="$("$env/bin/python" -I -c 'import sys; print(sys.base_prefix)')"
    case "$base" in "$B"/python/*) ;; *) fail "$env runs on $base, not the bundle's interpreter" ;; esac
  done
  echo "[runtime] ok: all three environments run on the moved bundle's interpreter"

  # What the orchestrator runs: every Python stage, the migrations, the runtime
  # login and the registry, from source/, with the contract files beside them.
  scripts=(packages/etl-db-writer/migrate.py packages/etl-db-writer/provision_roles.py apps/indicator_registry/register.py)
  for manifest in "$B"/source/apps/*/stage.json "$B"/source/apps/extractors/*/stage.json; do
    [ -f "$manifest" ] || continue
    runtime="$("$B/runtime-venv/bin/python" -I -c 'import json,sys; m=json.load(open(sys.argv[1])); print(m["runtime"], m["entrypoint"])' "$manifest")"
    [ "${runtime%% *}" = python ] && scripts+=("$(dirname "${manifest#"$B/source/"}")/${runtime#* }")
  done
  for script in "${scripts[@]}"; do
    entry "$B/runtime-venv" "$B/source/$script" || fail "$script does not load"
  done
  "$B/runtime-venv/bin/python" -I -c "
import sys, indicator_set
assert str(indicator_set.RESULTS_PATH).startswith('$B/source/'), indicator_set.RESULTS_PATH
assert indicator_set.RESULTS_PATH.is_file()
" || fail "the contract files are not read from the moved source/"
  echo "[runtime] ok: ${#scripts[@]} entry points load from source/, with their contract files"

  # psycopg2: the bundle's libpq, and the bundled server over its socket.
  "$B/postgresql/bin/initdb" -D "$HOME/data" -A peer --no-instructions > "$HOME/initdb.log"
  mkdir "$HOME/socket"
  "$B/postgresql/bin/pg_ctl" -D "$HOME/data" -l "$HOME/server.log" -w \
    -o "-c listen_addresses='' -c unix_socket_directories=$HOME/socket" start > /dev/null
  # libpq reports its version as major * 10000 + minor: 17.11 is 170011.
  want=$((${POSTGRES_VERSION%.*} * 10000 + ${POSTGRES_VERSION#*.}))
  "$B/runtime-venv/bin/python" -I - "$HOME/socket" "$want" << 'EOF'
import sys

import psycopg2

socket, want = sys.argv[1], int(sys.argv[2])
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

  # The decrypt and iLEAPP, each from its own environment.
  "$B/tools/decrypt/.venv/bin/python" -I "$B/tools/decrypt/decrypt_backup.py" --version > /dev/null \
    || fail "the decrypt does not run"
  (cd "$B/tools/ileapp/iLEAPP" && "$B/tools/ileapp/.venv/bin/python" -I - << 'EOF') || fail "iLEAPP's plugins do not load"
import sys

sys.path.insert(0, ".")
import pi_heif  # noqa: E402
import pillow_heif  # noqa: E402
import scripts.plugin_loader as pl  # noqa: E402

assert pillow_heif.register_heif_opener is pi_heif.register_heif_opener
modules = {p.module_name for p in pl.PluginLoader(plugin_paths=[pl.PLUGINPATH]).plugins}
# The three that decode HEIC, through pi-heif (licensing audit B1).
assert {"geodMapTiles", "springboard", "photosDbexif"} <= modules, sorted(modules)
print(f"[runtime] ok: the decrypt runs; iLEAPP loads {len(modules)} plugin modules, HEIF from pi-heif")
EOF
  exit 0
fi

# Moved: a different path from the one it was built at.
B=/opt/somewhere-else/bundle
mkdir -p /opt/somewhere-else
cp -a /built "$B"

# A decoy interpreter where the bundle was built: a path left absolute would
# reach it, and the checks above would see it.
mkdir -p /bundle/python
cp -a "$B"/python/cpython-* /bundle/python/

for env in "$B/runtime-venv" "$B/tools/decrypt/.venv" "$B/tools/ileapp/.venv"; do
  link="$(readlink "$env/bin/python")"
  case "$link" in /*) fail "$env/bin/python is absolute: $link" ;; esac
  ! grep -q '^home *=' "$env/pyvenv.cfg" || fail "$env/pyvenv.cfg still sets home"
done
so=("$B"/runtime-venv/lib/python3*/site-packages/psycopg2/_psycopg*.so)
ldd "${so[0]}" | grep -q "libpq.so.5 => $B/runtime-venv/.*/postgresql/lib/libpq.so.5" \
  || fail "psycopg2 does not load the bundle's libpq: $(ldd "${so[0]}" | grep libpq)"
echo "[runtime] ok: moved; relative interpreter links, and psycopg2 loads the bundle's libpq"

useradd -m checker
chown -R checker "$B"
su checker -s /bin/bash -c "POSTGRES_VERSION=$POSTGRES_VERSION /check-in-container.sh run $B"
