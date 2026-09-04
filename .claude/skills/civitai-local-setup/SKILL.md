---
name: civitai-local-setup
description: First-time bootstrap of a Civitai checkout on a new machine — nvm/corepack, the event-engine-common submodule, .env.development, the docker-compose base services, and the optional NixOS flake path (nix run .#dev / .#doctor). Use when setting up the repo from nothing or when local services are missing. Day-to-day dev-server control is the /dev-server skill, not this.
---

# Civitai local setup

CLAUDE.md carries the toolchain versions and the `/dev-server` rule. This file carries the one-time bootstrap.

From nothing to a running app (the default path — no Nix):

```bash
nvm use                                        # .nvmrc -> 24.19.0
corepack enable
git submodule update --init event-engine-common
cp .env-example .env.development
docker compose -f docker-compose.base.yml up -d
pnpm install && pnpm dev
```

**Optional, NixOS only** — the flake does the same in one command. Nothing requires
it, and it is used by one maintainer; do not assume a contributor has it:

```bash
nix run .#dev          # docker preflight, submodule, .env.development, compose up,
                       # wait for postgres, pnpm install, next dev on :3000
nix run .#dev -- --no-start   # bootstrap only
nix run .#doctor              # are the flake's pins still in step with the repo?
```

In an existing checkout that already works:
1. Install dependencies: `pnpm install`
2. Generate Prisma client: `pnpm run db:generate`
3. Start the services if they are down: `make start`
4. Start dev server: use the `/dev-server` skill. The daemon is spawned with
   `process.execPath`, so whichever node first ran a CLI verb is the node it keeps
   until it is shut down — run it under the node from `.nvmrc`. (On NixOS,
   `nix run .#dev-server` does that for you.)
