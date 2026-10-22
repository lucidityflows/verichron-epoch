#!/usr/bin/env bash
# Runs inside the pinned container (check.sh). As root it moves the bundle; then,
# as an unprivileged user with nothing on PATH but the base system, it runs the
# services (`check-in-container.sh run <bundle>`).
set -euo pipefail

fail() {
  echo "[services] FAIL: $*" >&2
  exit 1
}

if [ "${1:-}" = run ]; then
  B="$2"
  node="$B/node/bin/node"
  [ "$("$node" --version)" = "v$NODE_VERSION" ] || fail "the bundled Node is $("$node" --version), not v$NODE_VERSION"
  echo "[services] ok: the bundled Node is v$NODE_VERSION"

  # An empty workspace, as the contracts define one.
  ws="$HOME/workspace"
  mkdir -p "$ws"
  printf '%s' '{"schema_version":1,"backups":[],"summary_files":{"processor_json_path":"summary.json","processor_markdown_path":"summary.md"},"task_logs_path":"logs"}' > "$ws/workspace.json"

  # The orchestrator stops at the empty workspace, before any database: the
  # address is never used (the app-managed database is step 4).
  set +e
  orchestrator="$(DATABASE_URL='postgresql://unused@/unused?host=/nonexistent' \
    "$node" "$B/services/orchestrator.mjs" --workspace "$ws" --summary-path "$ws/call.json" 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "the orchestrator exited $status: $orchestrator"
  grep -q 'validated Python ' <<< "$orchestrator" || fail "the orchestrator did not validate the bundle's Python: $orchestrator"
  grep -q 'discovered 5 enabled stage(s)' <<< "$orchestrator" || fail "the orchestrator did not find the stages: $orchestrator"
  grep -q '"error": "No successfully decrypted backups were found in the workspace."' "$ws/call.json" \
    || fail "the orchestrator did not stop at the empty workspace: $(cat "$ws/call.json")"
  echo "[services] ok: the orchestrator validated the bundle's Python, found 5 stages, and stopped at the empty workspace"

  # The processor identifies its tools, then stops at a source with no backups.
  mkdir -p "$HOME/source"
  set +e
  processor="$("$node" "$B/services/processor.mjs" --source "$HOME/source" --workspace "$ws" --output events 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] || fail "the processor exited $status: $processor"
  grep -q 'Decrypt tool: iphone_backup_decrypt ' <<< "$processor" || fail "the processor did not run the bundle's decrypt: $processor"
  commit="$(cat "$B/tools/ileapp/iLEAPP.commit")"
  grep -q "iLEAPP: ${commit:0:12}" <<< "$processor" || fail "the processor did not read iLEAPP's recorded commit: $processor"
  grep -q 'no backup directories found' <<< "$processor" || fail "the processor did not stop at the empty source: $processor"
  echo "[services] ok: the processor ran the bundle's decrypt, read iLEAPP ${commit:0:12}, and stopped at the empty source"

  # The database server (EPOCH-477), with the XDG directories a desktop session gives.
  export XDG_DATA_HOME="$HOME/data" XDG_RUNTIME_DIR="$HOME/run"
  mkdir -p "$XDG_DATA_HOME" && mkdir -m 700 "$XDG_RUNTIME_DIR"
  dbserver() { "$node" "$B/services/dbserver.mjs" "$@"; }
  first="$(dbserver ensure)" || fail "dbserver ensure failed on the first start"
  url="$("$node" -e 'const r = JSON.parse(process.argv[1]); if (!r.created) process.exit(1); console.log(r.database_url)' "$first")" \
    || fail "the first start did not create the database: $first"
  socket="$XDG_RUNTIME_DIR/verichron-epoch"
  psql() { "$B/postgresql/bin/psql" -X -q -v ON_ERROR_STOP=1 -tA "$@"; }
  admin="postgresql://verichron_epoch_admin@/verichron_epoch?host=$socket"
  [ "$(psql "$admin" -c 'SHOW listen_addresses')" = "" ] || fail "the server listens on TCP"
  migrations="$(find "$B/source/packages/etl-db-writer/migrations" -name '*.sql' | wc -l)"
  [ "$(psql "$admin" -c 'SELECT count(*) FROM schema_migrations')" = "$migrations" ] || fail "not every migration was applied"
  [ "$(psql "$admin" -c "SELECT string_agg(extname, ' ' ORDER BY extname) FROM pg_extension")" = "pg_trgm plpgsql" ] \
    || fail "unexpected extensions"
  [ "$(psql "$url" -c 'SELECT count(*) FROM forensic_records')" = "0" ] || fail "the runtime login cannot read"
  ! psql "$url" -c 'TRUNCATE forensic_records' 2> /dev/null || fail "the runtime login could TRUNCATE"
  ! psql "postgresql://postgres@/verichron_epoch?host=$socket" -c 'SELECT 1' 2> /dev/null || fail "the OS account reached the postgres role"
  echo "[services] ok: the database server created the database: socket only, $migrations migrations, the runtime login cannot TRUNCATE"

  dbserver stop
  ! psql "$admin" -c 'SELECT 1' 2> /dev/null || fail "the server still runs after stop"
  again="$(dbserver ensure)" || fail "dbserver ensure failed on the second start"
  "$node" -e 'const r = JSON.parse(process.argv[1]); if (r.created || r.database_url !== process.argv[2]) process.exit(1)' "$again" "$url" \
    || fail "the second start did not reuse the database: $again"
  echo "[services] ok: stopped, and started again on the same database"

  # Two overlapping starts: one waits for the other's lock and finds its
  # server, so neither stops the server the other started.
  dbserver stop
  dbserver ensure > "$HOME/first.json" 2> "$HOME/first.err" &
  one=$!
  dbserver ensure > "$HOME/second.json" 2> "$HOME/second.err" &
  two=$!
  wait "$one" || fail "the first of two overlapping starts failed: $(cat "$HOME/first.err")"
  wait "$two" || fail "the second of two overlapping starts failed: $(cat "$HOME/second.err")"
  psql "$admin" -c 'SELECT 1' > /dev/null || fail "the server stopped after two overlapping starts"
  echo "[services] ok: two overlapping starts both succeeded, and the server stayed up"

  psql "$admin" -c "DELETE FROM schema_migrations WHERE filename = (SELECT max(filename) FROM schema_migrations)"
  dbserver stop
  set +e
  behind="$(dbserver ensure 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] && grep -q 'is behind this version' <<< "$behind" || fail "a database behind this version was not refused: $behind"
  # A refused start leaves no server behind (R14).
  ! psql "$admin" -c 'SELECT 1' 2> /dev/null || fail "the server still runs after a refused start"

  # An unfinished first start, with a server still running on it as an older
  # version would have left it: refused, and the server stopped, so removing
  # the data and starting again works.
  rm "$XDG_DATA_HOME/verichron-epoch/postgresql.ready"
  "$B/postgresql/bin/pg_ctl" -D "$XDG_DATA_HOME/verichron-epoch/postgresql" -w -l "$HOME/orphan.log" \
    -o "-c listen_addresses='' -c unix_socket_directories=$socket" start > /dev/null
  set +e
  unfinished="$(dbserver ensure 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 1 ] && grep -q 'was never finished' <<< "$unfinished" || fail "an unfinished database was not refused: $unfinished"
  ! psql "$admin" -c 'SELECT 1' 2> /dev/null || fail "the server left on an unfinished database still runs"
  rm -r "$XDG_DATA_HOME/verichron-epoch/postgresql"
  fresh="$(dbserver ensure)" || fail "starting again after removing the unfinished database failed"
  grep -q '"created":true' <<< "$fresh" || fail "starting again did not create the database: $fresh"
  dbserver stop
  echo "[services] ok: refused a database behind this version and an unfinished one, leaving no server running; started again cleanly"
  exit 0
fi

# Moved: a different path from the one it was built at, with its MANIFEST.
B=/opt/somewhere-else/bundle
mkdir -p /opt/somewhere-else
cp -a /built "$B"
[ -e "$B/MANIFEST" ] || touch "$B/MANIFEST"

useradd -m checker
chown -R checker "$B"
su checker -s /bin/bash -c "env -i HOME=/home/checker PATH=/usr/bin:/bin NODE_VERSION=$NODE_VERSION /check-in-container.sh run $B"
