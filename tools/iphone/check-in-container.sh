#!/usr/bin/env bash
# Runs inside the pinned container (check.sh). As root it moves bin/ and lib/
# and reads their library paths; then, as an unprivileged user with nothing on
# PATH but the base system, it runs them (`check-in-container.sh run <bundle>`).
set -euo pipefail

fail() {
  echo "[iphone] FAIL: $*" >&2
  exit 1
}

TOOLS=(idevicebackup2 idevicecrashreport idevice_id ideviceinfo plistutil)

if [ "${1:-}" = run ]; then
  B="$2"
  for tool in "${TOOLS[@]}"; do
    "$B/bin/$tool" --help > /dev/null 2>&1 || "$B/bin/$tool" -h > /dev/null 2>&1 \
      || fail "$tool does not run from the bundle"
  done
  version="$("$B/bin/idevicebackup2" --version)"
  echo "[iphone] ok: every tool a pull runs starts from the bundle ($version)"

  [ "$("$B/bin/sqlite3" -version | awk '{print $1}')" = "$SQLITE_VERSION" ] \
    || fail "sqlite3 is $("$B/bin/sqlite3" -version), not $SQLITE_VERSION"
  db="$HOME/sample.db"
  "$B/bin/sqlite3" "$db" "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b'), ('c');"
  "$B/bin/sqlite3" "$db" .recover | "$B/bin/sqlite3" "$HOME/recovered.db" > /dev/null
  [ "$("$B/bin/sqlite3" "$HOME/recovered.db" 'SELECT count(*) FROM t')" = "3" ] || fail "sqlite3 .recover did not rebuild the database"
  echo "[iphone] ok: sqlite3 $SQLITE_VERSION runs from the bundle, and .recover rebuilds a database"
  exit 0
fi

# readelf, to read each binary's library path; the checking machine's, not the bundle's.
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq > /dev/null
apt-get install -y -qq --no-install-recommends binutils > /dev/null

# Moved: a different path from the one it was built at.
B=/opt/somewhere-else/bundle
mkdir -p "$B"
cp -a /built/bin /built/lib "$B/"

# Only Debian 13's base system, and the bundle's own libraries.
allowed='^(linux-vdso\.so\.1|/lib64/ld-linux-x86-64\.so\.2|libc\.so\.6|libm\.so\.6|libssl\.so\.3|libcrypto\.so\.3|libz\.so\.1|libzstd\.so\.1)$'
for f in "$B"/bin/* "$B"/lib/*; do
  runpath="$(readelf -d "$f" | sed -n 's/.*(RUNPATH).*\[\(.*\)\]/\1/p')"
  case "$runpath" in '$ORIGIN' | '$ORIGIN/../lib') ;; *) fail "$f searches $runpath for libraries" ;; esac
  while read -r name _ resolved _; do
    if [ "${resolved#"$B/"}" != "$resolved" ]; then continue; fi
    grep -qE "$allowed" <<< "$name" || fail "$(basename "$f") loads $name from outside the bundle (${resolved:-not found})"
  done < <(ldd "$f" | sed 's/^\s*//')
done
echo "[iphone] ok: moved; every library path is relative, and only the base system is loaded from outside the bundle"

useradd -m checker
chown -R checker "$B"
su checker -s /bin/bash -c "env -i HOME=/home/checker PATH=/usr/bin:/bin SQLITE_VERSION=$SQLITE_VERSION /check-in-container.sh run $B"
