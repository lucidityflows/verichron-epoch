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
