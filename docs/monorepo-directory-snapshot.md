# Monorepo — Directory Snapshot

This shows what the repo will look like after the planned monorepo conversion lands. See [monorepo-conversion-plan.md](./monorepo-conversion-plan.md) for the full plan, phases, and rationale.

## Scope of this snapshot

State **after Phase 6** (foundation packages extracted), **before optional Phase 7** (which moves the main app into `apps/main/`).

## Tooling

- **pnpm workspaces** (we already use pnpm 10.28). No Turborepo / Nx required.
- All shared packages use the `@civitai/` scope.
- Four narrow infrastructure packages instead of one bundled `@civitai/data`, so a future text-only utility app can depend on `@civitai/db` alone without pulling in ClickHouse or Axiom.
- Re-export shims keep all existing `~/...` imports in the main app working unchanged — no mass-rewrite of call sites.

## Directory layout

```
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
│   │   ├── constants/
│   │   │   ├── browsingLevel.constants.ts        # SHIM — re-exports from @civitai/schema-common
│   │   │   ├── model-version-flags.constants.ts  # SHIM
│   │   │   ├── user-flags.constants.ts           # SHIM
│   │   │   └── ... (others unchanged)
│   │   ├── utils/
│   │   │   ├── air.ts                            # SHIM
│   │   │   ├── flags.ts                          # SHIM
│   │   │   └── prisma/
│   │   │       ├── enums.ts                      # SHIM
│   │   │       └── models.ts                     # SHIM
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
│   ├── civitai-schema-common/         # @civitai/schema-common
│   │   ├── package.json               # deps: @prisma/client, prisma (CLI), zod
│   │   ├── tsconfig.json
│   │   ├── README.md
│   │   ├── prisma/
│   │   │   ├── schema.full.prisma     # MOVED from root /prisma/
│   │   │   ├── schema.prisma          # MOVED (auto-generated slim)
│   │   │   ├── migrations/            # MOVED — full migration history
│   │   │   ├── programmability/       # MOVED — views, functions, etc.
│   │   │   └── seed.ts                # MOVED
│   │   ├── generated/
│   │   │   └── client/                # output of `prisma generate` — both apps import from here
│   │   └── src/
│   │       ├── index.ts               # main entry — re-exports enums, flags, air
│   │       ├── enums.ts               # MOVED from src/shared/utils/prisma/enums.ts
│   │       ├── models.ts              # MOVED
│   │       ├── flags.ts               # MOVED from src/shared/utils/flags.ts
│   │       ├── air.ts                 # MOVED from src/shared/utils/air.ts
│   │       ├── browsing-level.ts      # MOVED from src/shared/constants/browsingLevel.constants.ts
│   │       ├── model-version-flags.ts # MOVED
│   │       ├── user-flags.ts          # MOVED
│   │       └── redis-keys.ts          # MOVED — key constants & TTLs from src/server/redis/caches.ts
│   │
│   ├── civitai-db/                    # @civitai/db
│   │   ├── package.json               # deps: pg, @civitai/schema-common, prom-client
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts               # exports createDbClients(config)
│   │       ├── pools.ts               # MOVED from src/server/db/db-helpers.ts (553 lines)
│   │       ├── client.ts              # MOVED from src/server/db/client.ts (Prisma wrapper)
│   │       ├── pgDb.ts                # MOVED
│   │       ├── notifDb.ts             # MOVED
│   │       ├── datapacketDb.ts        # MOVED
│   │       └── db-lag-helpers.ts      # MOVED
│   │
│   ├── civitai-redis/                 # @civitai/redis
│   │   ├── package.json               # deps: redis (or ioredis), @civitai/schema-common
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts               # exports createRedisClients(config)
│   │       ├── client.ts              # MOVED from src/server/redis/client.ts (1,105 lines)
│   │       ├── caches.ts              # MOVED (~1,571 lines minus keys, which moved to schema-common)
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
│   └── civitai-telemetry/             # @civitai/telemetry
│       ├── package.json               # deps: @opentelemetry/*
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts               # exports withSpan + helpers (browser-safe subset)
│           ├── node.ts                # exports bootstrapOtel(config) for instrumentation.node.ts
│           ├── otel-helpers.ts        # MOVED from src/utils/otel-helpers.ts
│           └── prom.ts                # MOVED from src/server/prom/client.ts (helpers; per-app registration stays in app)
│
├── apps/                              # NEW — empty for now; populated when moderator app is built
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
- **`prisma/` at root is gone.** It's entirely inside `packages/civitai-schema-common/prisma/`. The `db:generate`, `db:migrate`, etc. scripts now point at the package path.
- **No `node_modules/.prisma/client`.** The generated Prisma client lives at `packages/civitai-schema-common/generated/client/`. Both main app and any future apps import from `@civitai/schema-common/client`.
- **Per-app `instrumentation.node.ts` shrinks from 97 lines to ~3** — just calls `bootstrapOtel({ serviceName: 'civitai-app' })`. The OTEL SDK setup moves into the telemetry package.
- **`apps/` is empty until the moderator app is built.** Phases 0–6 are foundation-only.
- **`event-engine-common/` stays a git submodule.** Converting it to a workspace package is a separate decision that doesn't need to block this work.

## After Phase 7 (the optional final move)

Everything currently in `src/`, `next.config.mjs`, etc. moves to `apps/main/`. The root becomes a pure workspace shell:

```
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
