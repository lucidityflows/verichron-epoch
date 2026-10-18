#!/usr/bin/env bash
#
# Set up a development environment for Verichron Epoch (EPOCH-458).
#
# Run through mise, which puts the pinned Node, pnpm and uv on PATH:
#   mise run check    report missing or wrong prerequisites; change nothing
#   mise run setup    check, then install every environment from the lockfiles
#
# The script checks every prerequisite first and reports all problems at once,
# each with the command that fixes it. It changes nothing unless every check
# passes. Installs use the lockfiles only (`uv sync --locked`,
# `pnpm install --frozen-lockfile`); a lockfile that doesn't match its manifest
# is an error, not something to repair here.
#
# Environments it creates:
#   .venv/           the uv workspace (our Python code), Python from .python-version
#   tools/decrypt/.venv the backup decrypt, pinned; run by the processor
#   tools/ileapp/.venv  iLEAPP's runtime, pinned; run by the processor
#   node_modules/    the pnpm workspace

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

CHECK_ONLY=0
case "${1:-}" in
  --check) CHECK_ONLY=1 ;;
  "") ;;
  *) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

# Versions come from the files that enforce them; nothing is repeated here.
NODE_WANT="$(sed -n 's/^node = "\(.*\)"$/\1/p' mise.toml)"
UV_WANT="$(sed -n 's/^uv = "\(.*\)"$/\1/p' mise.toml)"
PNPM_WANT="$(sed -n 's/.*"packageManager": "pnpm@\([^"]*\)".*/\1/p' package.json)"
PYTHON_WANT="$(tr -d '[:space:]' < .python-version)"

problems=()
problem() { problems+=("$1"$'\n'"      fix: $2"); }
ok() { echo "  ok    $1"; }

case "$(uname -s)" in
  Darwin) COMPILER_FIX="xcode-select --install" ;;
  *)      COMPILER_FIX="sudo apt install build-essential   (Fedora: sudo dnf install gcc make)" ;;
esac

echo "[setup] checking prerequisites"

if command -v mise >/dev/null 2>&1; then
  ok "mise $(mise --version 2>/dev/null | awk '{print $1}')"
else
  problem "mise is not installed (it provides the pinned Node, pnpm and uv)" \
    "curl https://mise.run | sh, then activate it in your shell (https://mise.jdx.dev/getting-started.html)"
fi

have_node="$(node --version 2>/dev/null | sed 's/^v//' || true)"
if [ "$have_node" = "$NODE_WANT" ]; then
  ok "node $have_node"
else
  problem "node ${have_node:-not found}, need $NODE_WANT" "mise install, and run this through \`mise run setup\`"
fi

have_uv="$(uv --version 2>/dev/null | awk '{print $2}' || true)"
if [ "$have_uv" = "$UV_WANT" ]; then
  ok "uv $have_uv"
else
  problem "uv ${have_uv:-not found}, need $UV_WANT" "mise install, and run this through \`mise run setup\`"
fi

have_pnpm="$(pnpm --version 2>/dev/null || true)"
if [ "$have_pnpm" = "$PNPM_WANT" ]; then
  ok "pnpm $have_pnpm"
else
  problem "pnpm ${have_pnpm:-not found}, need $PNPM_WANT" "mise install, and run this through \`mise run setup\`"
fi

# Two of iLEAPP's dependencies (pyliblzfse, astc-decomp-faster) publish no Linux
# wheels, so building tools/ileapp compiles them. uv's managed Python ships the
# headers; only the compiler is needed.
if command -v cc >/dev/null 2>&1 && echo 'int main(void){return 0;}' | cc -x c -o /dev/null - >/dev/null 2>&1; then
  ok "C compiler ($(cc --version 2>/dev/null | head -1))"
else
  problem "no working C compiler (needed to build iLEAPP's environment)" "$COMPILER_FIX"
fi

if ! docker compose version >/dev/null 2>&1; then
  problem "docker with the compose plugin is not available (local PostgreSQL)" \
    "install Docker Engine or Docker Desktop (https://docs.docker.com/engine/install/)"
elif ! docker info >/dev/null 2>&1; then
  # The client is installed but can't reach the daemon: it isn't running, or
  # this user may not use its socket.
  problem "docker is installed but its daemon is not reachable (not running, or permission denied)" \
    "start Docker; on Linux, also: sudo usermod -aG docker \$USER, then log out and back in"
else
  ok "docker compose $(docker compose version --short 2>/dev/null)"
fi

if [ -f .env ]; then
  missing_vars=()
  for var in DB_USER DB_PASSWORD DB_APP_USER DB_APP_PASSWORD DB_NAME DB_HOST DB_PORT; do
    grep -Eq "^${var}=.+" .env || missing_vars+=("$var")
  done
  if [ ${#missing_vars[@]} -eq 0 ]; then
    ok ".env"
  else
    problem ".env has no value for: ${missing_vars[*]}" "edit .env and set them"
  fi
else
  problem ".env is missing" "cp .env.example .env, then set DB_USER, DB_PASSWORD, DB_APP_USER, DB_APP_PASSWORD, DB_NAME, DB_HOST, DB_PORT"
fi

if [ ${#problems[@]} -gt 0 ]; then
  echo
  echo "[setup] ${#problems[@]} problem(s); nothing was changed:"
  for p in "${problems[@]}"; do
    echo "  - $p"
  done
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "[setup] all prerequisites present (check only; nothing was changed)"
  exit 0
fi

echo "[setup] installing"

# docker compose reads infra/.env; keep it the same file as the root .env.
if [ ! -e infra/.env ]; then
  ln -s ../.env infra/.env
fi
echo "  done  infra/.env -> ../.env"

git submodule sync --recursive >/dev/null
git submodule update --init --recursive
echo "  done  submodules (iLEAPP)"

uv sync --locked
echo "  done  workspace .venv (Python $PYTHON_WANT)"

uv sync --locked --project tools/decrypt
echo "  done  tools/decrypt/.venv ($(tools/decrypt/.venv/bin/python -I tools/decrypt/decrypt_backup.py --version 2>/dev/null))"

uv sync --locked --project tools/ileapp
echo "  done  tools/ileapp/.venv"

pnpm install --frozen-lockfile
echo "  done  node_modules"

git config core.hooksPath .githooks
echo "  done  git hooks (.githooks)"

cat <<EOF

[setup] complete. Next:
  docker compose -f infra/docker-compose.yml up -d postgres
  uv run python packages/etl-db-writer/migrate.py
EOF
