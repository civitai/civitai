#!/usr/bin/env bash
# One-command local dev entrypoint. Invoked as `nix run .#dev` -- flake.nix wraps
# this file with `pkgs.writeShellApplication`, which supplies
# `set -o errexit -o nounset -o pipefail` and puts the flake's node, pnpm, git
# and postgresql client on PATH ahead of anything ambient. Docker deliberately
# comes from the host, not from nix: the CLI must match the daemon you are
# already running.
#
# Every step is idempotent and non-destructive. It will not overwrite an
# existing .env.development, will not recreate volumes, and will not reseed.
# Running it in a checkout that already works should change nothing except
# starting containers that were stopped.

usage() {
  cat <<'EOF'
Usage: nix run .#dev [--full] [--no-start] [--skip-install]

  (default)       base services + install + `next dev` on http://localhost:3000
  --full          also start the signals/buzz containers from ghcr.io. These are
                  private images; you need `docker login ghcr.io` first.
  --no-start      do the bootstrap, then stop. Leaves services running.
  --skip-install  skip `pnpm install` (use when you know node_modules is current)
  -h, --help      this message

Not done for you, because both are destructive and slow:
  migrations      `make run-migrations`
  seed data       `make reseed`
EOF
}

COMPOSE_FILE=docker-compose.base.yml
START_DEV=1
RUN_INSTALL=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --full) COMPOSE_FILE=docker-compose.yml ;;
    --no-start) START_DEV=0 ;;
    --skip-install) RUN_INSTALL=0 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "dev: unknown argument '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- locate the repo ---------------------------------------------------------
# Guard the VALUE, not just the `cd`: `cd ""` is a no-op returning 0 on bash
# <= 5.2, so `cd "$ROOT" || exit` sails past an empty ROOT and runs against
# whatever cwd it inherited.
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$ROOT" ] || [ ! -d "$ROOT" ]; then
  echo "dev: not inside a git checkout. Run this from the civitai repo." >&2
  exit 1
fi
if [ ! -f "$ROOT/$COMPOSE_FILE" ] || [ ! -f "$ROOT/package.json" ]; then
  echo "dev: $ROOT does not look like the civitai repo (no $COMPOSE_FILE)." >&2
  exit 1
fi
cd "$ROOT"

# Compose derives its project name from the directory it is run in, so every
# git worktree would otherwise get its OWN stack -- and the second one to start
# fails on the port binds, which reads as this script being broken. Pin the
# project so all worktrees share the one local stack (and the one local
# database), which is what the primary clone's directory name already produces.
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-civitai}"

step "toolchain (from the flake, not from your PATH)"
echo "  node   $(node --version)  ($(command -v node))"
echo "  pnpm   $(pnpm --version)  ($(command -v pnpm))"

# --- docker ------------------------------------------------------------------
step "docker"
if ! command -v docker >/dev/null 2>&1; then
  echo "dev: docker is not on PATH. The service stack is docker-compose; install" >&2
  echo "     docker and make sure your user can talk to the daemon." >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "dev: 'docker compose' is unavailable (compose v2 is required)." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "dev: the docker daemon is not reachable. Start it, or add yourself to the" >&2
  echo "     docker group, then re-run." >&2
  exit 1
fi
echo "  $(docker --version)"
echo "  $(docker compose version)"

# --- submodule ---------------------------------------------------------------
# Worktrees and fresh clones do not check this out for you, and without it
# `pnpm typecheck` produces a wall of 'Cannot find module' that looks like a
# broken branch.
step "event-engine-common submodule"
if [ -f event-engine-common/package.json ]; then
  echo "  already checked out"
else
  git submodule update --init event-engine-common
fi

# --- env file ----------------------------------------------------------------
step ".env.development"
if [ -f .env.development ]; then
  echo "  exists, leaving it alone"
else
  cp .env-example .env.development
  echo "  created from .env-example."
  echo "  S3_UPLOAD_KEY / S3_UPLOAD_SECRET are placeholders: mint real ones at"
  echo "  http://localhost:9001 (minioadmin/minioadmin) -> Access Keys."
fi

# --- services ----------------------------------------------------------------
step "services ($COMPOSE_FILE, project $COMPOSE_PROJECT_NAME)"
docker compose -f "$COMPOSE_FILE" up -d

step "waiting for postgres on localhost:15432"
ready=0
for _ in $(seq 1 60); do
  if pg_isready -h localhost -p 15432 -q; then
    ready=1
    break
  fi
  sleep 2
done
if [ "$ready" -eq 1 ]; then
  echo "  ready"
else
  echo "dev: postgres did not accept connections within 120s." >&2
  echo "     Check: docker compose -f $COMPOSE_FILE logs db" >&2
  exit 1
fi

# --- dependencies ------------------------------------------------------------
if [ "$RUN_INSTALL" -eq 1 ]; then
  step "pnpm install"
  pnpm install
else
  step "pnpm install (skipped)"
fi

# --- done --------------------------------------------------------------------
cat <<EOF

Environment is up.

  app          http://localhost:3000   (once next dev finishes compiling)
  minio        http://localhost:9001   minioadmin / minioadmin
  maildev      http://localhost:1080
  postgres     localhost:15432         psql -h localhost -p 15432 -U postgres civitai
  meilisearch  http://localhost:7700

First time on an empty database? Run these once, they are slow and destructive:

  make run-migrations
  make reseed

EOF

if [ "$START_DEV" -eq 0 ]; then
  echo "--no-start given; not launching the dev server."
  exit 0
fi

step "next dev"
exec pnpm dev
