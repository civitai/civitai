# Monorepo — Directory Snapshot

The **current** workspace layout (the foundation conversion has landed). See
[monorepo-conversion-plan.md](./monorepo-conversion-plan.md) for the original plan/phases and
[monorepo-package-adaptation-plan.md](./monorepo-package-adaptation-plan.md) for per-package detail.

> **Doc map.** This file = current structure. Plans/records: [conversion-plan](./monorepo-conversion-plan.md),
> [package-adaptation-plan](./monorepo-package-adaptation-plan.md),
> [bootstrap-handoff](./monorepo-bootstrap-handoff.md),
> [split-overview](./monorepo-split-overview.md) (moderator app),
> [env-vars](./plans/monorepo-env-vars.md). Auth hub: [centralized-auth-app](./centralized-auth-app.md),
> [auth-verification-strategy](./auth-verification-strategy.md),
> [auth-hub-launch-checklist](./auth-hub-launch-checklist.md).

## Scope

Foundation packages extracted + the first satellite apps (`apps/auth`, `apps/moderator`) scaffolded.
The **optional** final move — relocating the main app from root `src/` into `apps/main/` — is still
deferred (see the end of this doc).

## Tooling

- **pnpm workspaces** (pnpm 10.28) + **Turborepo** (`turbo.json`) for task orchestration, with
  package dependency-boundary enforcement (an ESLint rule stops base packages from importing each
  other or the main app).
- All shared packages use the `@civitai/` scope.
- Narrow infrastructure packages (not one bundled `@civitai/data`), so an app can depend on
  `@civitai/db` alone without pulling in ClickHouse or Axiom.
- Re-export shims keep existing `~/...` imports in the main app working unchanged — no mass rewrite.

## Base-package rule

**Base packages do not import from each other.** Each package below (`civitai-db`, `civitai-redis`, `civitai-clickhouse`, `civitai-axiom`, `civitai-telemetry`) is self-contained infrastructure: external deps only, no `@civitai/*` deps. Higher-level packages (e.g. a future `civitai-moderator-common`) may depend on multiple base packages — but base packages stay independent. If two base packages need shared constants, they own their own copy or expose them via a subpath (e.g. `@civitai/redis/keys`).

**Base packages are infrastructure only.** Civitai-specific domain constants (bit-flag interpretations like `browsingLevel.constants.ts`, identifier formats like `air.ts`, bitwise helpers like `flags.ts`) stay in the main app for now. They're not infrastructure — they're domain conventions. We deferred extracting them; the satellite app can re-evaluate when it actually needs them.

## Directory layout

```text
model-share/
├── .browser/                          # unchanged
├── .claude/                           # unchanged
├── .devcontainer/
├── .github/                           # CI workflows — minor edits (pnpm install at root; typecheck adds `-r`)
├── .husky/
├── .ladle/
├── .vscode/
├── CLAUDE.md
├── Dockerfile                         # may need adjustment for workspace install
├── Makefile
├── README.md
├── docker-compose.base.yml
├── docker-compose.yml
│
├── package.json                       # MAIN APP deps still live here (Next, Mantine, etc.)
│                                      # Adds workspace dep references: "@civitai/db": "workspace:*", etc.
│                                      # Drops: @prisma/client, prisma, pg, ioredis, @clickhouse/client,
│                                      #        @axiomhq/axiom-node, @opentelemetry/* (moved into packages)
├── pnpm-workspace.yaml                # NEW — defines packages: '.', 'packages/*', 'apps/*'
├── pnpm-lock.yaml                     # one lockfile for the whole workspace
├── tsconfig.json                      # unchanged (still rooted at ./src for the main app)
├── next.config.mjs                    # adds transpilePackages: ['@civitai/*']
├── tailwind.config.ts                 # unchanged
├── postcss.config.cjs                 # unchanged
├── eslint-local-rules.js              # unchanged
│
├── src/                               # MAIN APP — entirely unchanged file layout
│   ├── app/
│   ├── components/
│   ├── env/                           # unchanged — main app's own env validation
│   ├── hooks/
│   ├── instrumentation.node.ts        # SHRUNK — now calls bootstrapOtel({ serviceName: 'civitai-app' })
│   ├── instrumentation.ts             # unchanged
│   ├── libs/
│   ├── middleware.ts
│   ├── pages/
│   ├── providers/
│   ├── server/
│   │   ├── db/
│   │   │   ├── client.ts              # SHIM — re-exports from @civitai/db with main-app env wiring
│   │   │   ├── db-helpers.ts          # SHIM — re-exports from @civitai/db
│   │   │   ├── pgDb.ts                # SHIM
│   │   │   ├── notifDb.ts             # SHIM
│   │   │   ├── datapacketDb.ts        # SHIM
│   │   │   └── db-lag-helpers.ts      # SHIM
│   │   ├── redis/
│   │   │   ├── client.ts              # SHIM — re-exports from @civitai/redis
│   │   │   ├── caches.ts              # SHIM
│   │   │   ├── queues.ts              # SHIM
│   │   │   ├── entity-metric.redis.ts # SHIM
│   │   │   └── ... (rest are shims)
│   │   ├── clickhouse/
│   │   │   └── client.ts              # SHIM — re-exports from @civitai/clickhouse
│   │   ├── logging/
│   │   │   └── client.ts              # SHIM — re-exports from @civitai/axiom
│   │   ├── services/                  # unchanged (still imports via ~/server/db/client, etc.)
│   │   ├── routers/                   # unchanged
│   │   ├── schema/                    # unchanged (zod schemas stay here for now)
│   │   └── ... (rest unchanged)
│   ├── shared/
│   │   ├── constants/                            # unchanged — domain constants stay in main app
│   │   │   ├── browsingLevel.constants.ts        # unchanged (DB-encoded NSFW bits)
│   │   │   ├── model-version-flags.constants.ts  # unchanged
│   │   │   ├── user-flags.constants.ts           # unchanged
│   │   │   └── ...
│   │   ├── utils/
│   │   │   ├── air.ts                            # unchanged (AIR identifier parser)
│   │   │   ├── flags.ts                          # unchanged (bitwise helpers)
│   │   │   └── prisma/
│   │   │       ├── enums.ts                      # SHIM — re-exports from @civitai/db (Prisma-generated)
│   │   │       └── models.ts                     # SHIM — re-exports from @civitai/db
│   │   └── ... (data-graph, tiptap, etc. unchanged)
│   ├── store/
│   ├── styles/
│   ├── types/
│   ├── utils/
│   │   └── otel-helpers.ts            # SHIM — re-exports from @civitai/telemetry
│   └── workers/
│
├── packages/                          # NEW — all shared packages live here
│   │
│   ├── civitai-db-schema/             # @civitai/db-schema — the Postgres CONTRACT (source of truth):
│   │   │                                 Prisma schema, migrations, and generated client + types.
│   │   ├── package.json               # dep: kysely. exports: '.', './enums', './models', './kysely'
│   │   ├── prisma/
│   │   │   ├── schema.full.prisma     # source schema (incl. the generator blocks)
│   │   │   ├── schema.prisma          # auto-generated slim schema (strips @no-type models)
│   │   │   ├── migrations/            # full migration history (applied MANUALLY — see CLAUDE.md)
│   │   │   ├── programmability/       # views, functions, triggers
│   │   │   └── seed.ts
│   │   └── src/
│   │       ├── index.ts               # re-exports the generated @prisma/client (bare import)
│   │       ├── enums.ts               # generated (prisma-enum-generator) → '@civitai/db-schema/enums'
│   │       ├── models.ts              # generated (typescript-interfaces) → '@civitai/db-schema/models'
│   │       └── kysely/                # generated (prisma-kysely) → '@civitai/db-schema/kysely'
│   │           ├── types.ts           #   Kysely `DB` table types (Generated<>/ColumnType<> wrappers)
│   │           └── enums.ts           #   Kysely enum unions
│   │
│   ├── civitai-db/                    # @civitai/db — Postgres RUNTIME only; depends on db-schema.
│   │   ├── package.json               # deps: @civitai/db-schema, kysely, pg, prom-client. exports: '.', './kysely'
│   │   └── src/
│   │       ├── index.ts               # createPrismaClients(config) + pg Pool factory
│   │       ├── client.ts              # Prisma client wrapper
│   │       ├── db-helpers.ts          # pg pools, cancellableQuery, prom histograms
│   │       ├── kysely.ts              # createKyselyClients(config) — Kysely client builder → './kysely'
│   │       ├── concurrency-helpers.ts
│   │       ├── kv-helpers.ts
│   │       └── env.ts                 # loadDbEnv() (lazy, package-owned)
│   │
│   ├── civitai-redis/                 # @civitai/redis
│   │   ├── package.json               # deps: redis (or ioredis) — no other base packages
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts               # exports createRedisClients(config)
│   │       ├── keys.ts                # FUTURE — key constants & TTLs (exported via
│   │       │                             @civitai/redis/keys subpath so consumers can
│   │       │                             import just the keys without instantiating clients)
│   │       ├── client.ts              # MOVED from src/server/redis/client.ts (1,105 lines)
│   │       ├── caches.ts              # MOVED (~1,571 lines — keys stay inside this package)
│   │       ├── queues.ts              # MOVED
│   │       ├── entity-metric.redis.ts # MOVED
│   │       ├── entity-metric-populate.ts # MOVED
│   │       ├── resource-data.redis.ts # MOVED
│   │       └── fail-open-log.ts       # MOVED (refactored to accept a logger function via config)
│   │
│   ├── civitai-clickhouse/            # @civitai/clickhouse
│   │   ├── package.json               # deps: @clickhouse/client
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts               # exports createClickhouseClient(config)
│   │       └── client.ts              # MOVED from src/server/clickhouse/client.ts (733 lines)
│   │
│   ├── civitai-axiom/                 # @civitai/axiom
│   │   ├── package.json               # deps: @axiomhq/axiom-node
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts               # exports createAxiomLogger(config) — { logToAxiom, safeError }
│   │       └── client.ts              # MOVED from src/server/logging/client.ts (58 lines)
│   │
│   ├── civitai-telemetry/             # @civitai/telemetry
│   │   ├── package.json               # deps: @opentelemetry/*
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts               # exports withSpan + helpers (browser-safe subset)
│   │       ├── node.ts                # exports bootstrapOtel(config) for instrumentation.node.ts
│   │       ├── otel-helpers.ts        # MOVED from src/utils/otel-helpers.ts
│   │       └── prom.ts                # MOVED from src/server/prom/client.ts (helpers; per-app registration stays in app)
│   │
│   ├── civitai-auth/                  # @civitai/auth — centralized-auth SDK (hub + spokes). Infra-free
│   │   │                                (redis injected). deps: jose, next-auth, zod.
│   │   └── src/                       # createAuthVerifier (local RS256/JWKS verify, no per-request hop),
│   │       │                            createSessionSigner (hub RS256 issuance + JWKS + OIDC id_token),
│   │       │                            createSessionRegistry (cross-app revocation marker),
│   │       │                            cookie/redirect/constants contracts. __tests__/ (vitest).
│   │
│   ├── civitai-email/                 # @civitai/email — sendEmail / createEmail (nodemailer). deps: nodemailer, zod
│   │   └── src/
│   │
│   └── civitai-brand/                 # @civitai/brand — framework-agnostic logo SVGs (data + string
│       │                                builders), shared across Svelte + React (presentation, not infra).
│       └── src/                       # exports: '.', './paths', './gradients', './holiday', './svg'
│
├── apps/                              # satellite apps — each its own workspace (package.json + build)
│   ├── auth/                          # @civitai/auth-app — SvelteKit login hub (auth.civitai.com): the
│   │                                    sole session-token ISSUER. Email magic-link + OAuth, JWKS
│   │                                    endpoint, cross-root sync, logout/revocation. Verifies via
│   │                                    @civitai/auth; queries via Kysely (@civitai/db-schema/kysely).
│   │                                    Has its own Dockerfile (adapter-node).
│   └── moderator/                     # Next.js content-moderation app (scaffold): a spoke that verifies
│                                        the shared cookie via @civitai/auth (JWKS), no login UI.
│
├── event-engine-common/               # EXISTING submodule — untouched (stays a submodule for now)
├── designs/                           # unchanged
├── docs/                              # unchanged
├── containers/                        # unchanged
├── analyze/
└── (other unchanged files: .env, .env-example, .dockerignore, etc.)
```

## Key things to notice

- **`src/` looks almost identical to today.** Every file that was moved into a package leaves a one-line shim behind at its old path. The diff to call sites in the main app is zero.
- **`prisma/` at root is gone.** It lives in `packages/civitai-db-schema/prisma/`. The `db:generate` / `db:migrate*` scripts point there; `db:generate` runs three generators — the Prisma client, the `enums.ts`/`models.ts` interfaces, and **`prisma-kysely`** (Kysely `DB` types under `src/kysely/`). Migrations are still applied **manually** (see CLAUDE.md).
- **Contract vs. runtime are split.** `@civitai/db-schema` owns the schema + generated client/types (the *contract*); `@civitai/db` owns the *runtime* (Prisma/pg/Kysely client factories) and depends on db-schema. Type-only consumers import `@civitai/db-schema` (or its `./kysely` subpath); consumers that need a live client use `@civitai/db`.
- **Per-app `instrumentation.node.ts` shrinks from 97 lines to ~3** — just calls `bootstrapOtel({ serviceName: 'civitai-app' })`. The OTEL SDK setup moves into the telemetry package.
- **`apps/` now holds `auth` (the SvelteKit login hub) and `moderator` (Next.js scaffold).** The main app still lives at the repo root (`src/`); moving it into `apps/main/` is the deferred final step below.
- **`event-engine-common/` stays a git submodule.** Converting it to a workspace package is a separate decision that doesn't need to block this work.

## After Phase 7 (the optional final move)

Everything currently in `src/`, `next.config.mjs`, etc. moves to `apps/main/`. The root becomes a pure workspace shell:

```text
model-share/
├── package.json              # workspace root only — no app deps
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json        # shared TS settings
├── apps/
│   ├── main/                 # everything that was at root
│   │   ├── package.json
│   │   ├── next.config.mjs
│   │   ├── tsconfig.json
│   │   └── src/
│   └── moderator/            # the satellite app
├── packages/                 # same as Phase 6 snapshot
├── docs/
├── containers/
├── Makefile
└── (config files)
```

Phase 7 is deferred until the satellite app exists and proves the workspace setup is stable.
