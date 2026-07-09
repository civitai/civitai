# Monorepo Conversion Plan

> **Historical plan — amended since.** Records the original conversion approach. What actually
> shipped differs in two places: (1) the Prisma **schema + generated client + `enums.ts`/`models.ts`**
> landed in a dedicated **`@civitai/db-schema`** package (with a `prisma-kysely` generator), and
> `@civitai/db` kept only the *runtime* client factories and depends on db-schema; (2) **Turborepo
> was later adopted** (`turbo.json`) despite the "not Turborepo" note below. For the current
> structure see [monorepo-directory-snapshot.md](./monorepo-directory-snapshot.md).

## Goal

Convert the existing repo into a pnpm workspace monorepo, starting by extracting **globally-used infrastructure** (Prisma schema/client, Postgres pools, Redis, ClickHouse, Axiom logging) into shared packages. Future apps (the moderator app from [moderator-app-shared-modules.md](./moderator-app-shared-modules.md)) consume those packages instead of importing from `~/server/...`.

Supersedes an earlier submodule-based proposal — what was going to be a submodule is now a workspace package, and the package set has narrowed to infrastructure only (db, redis, clickhouse, axiom, telemetry).

## Why pnpm workspaces (not Turborepo, not Nx)

- Package manager is already pnpm 10.28
- Workspaces are a single-line config change in root `package.json`
- No build orchestration needed initially — Next.js compiles packages transparently via `transpilePackages`
- Turborepo can be layered on later for CI caching if build times become a problem; not required day-1

## Base-package rule

**Base packages do not import from each other.** Each base package (db, redis, clickhouse, axiom, telemetry) is self-contained — external deps only, no `@civitai/*` deps on a sibling base package. Higher-level packages (e.g. future `civitai-moderator-common`) may compose multiple base packages, but base packages stay independent. If two base packages need shared constants, they own their own copy or expose them via a subpath (e.g. `@civitai/redis/keys`). This keeps each base package usable on its own and prevents a brittle dependency graph between low-level layers.

**Base packages are infrastructure only.** Civitai-specific domain constants (bit-flag interpretations like `browsingLevel.constants.ts`, identifier formats like `air.ts`, bitwise helpers like `flags.ts`) stay in the main app. They're not infrastructure — they're domain conventions. Extracting them is deferred to whenever the satellite app actually needs them.

## Layout decision: main app stays at root

```text
/
├── package.json              # root: pnpm workspace config + main app deps
├── pnpm-workspace.yaml       # new
├── next.config.mjs           # main app config (unchanged)
├── src/                      # main app source (unchanged)
├── prisma/                   # MOVES to packages/civitai-db
├── packages/
│   ├── civitai-db/
│   ├── civitai-redis/
│   ├── civitai-clickhouse/
│   ├── civitai-axiom/
│   └── civitai-telemetry/    # OTEL helpers (withSpan, etc.) — auto-instrumentation stays per-app
└── apps/
    └── moderator/            # added later
```

**Why main at root, not `apps/main/`:** moving 2,500+ files into `apps/main/` triggers the exact catastrophe [monorepo-split-overview.md](./monorepo-split-overview.md) was right to reject. Leaving main at root means `~/` imports never change. New apps live in `apps/`, shared code in `packages/`. The asymmetry is a feature: it lets the conversion be incremental.

If symmetry becomes important later (e.g., a third app makes the root-as-app pattern feel weird), `git mv src/ apps/main/src/` becomes a one-off cleanup once the workspace exists.

## Workspace bootstrap (Phase 0)

1. Add `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - '.'
     - 'packages/*'
     - 'apps/*'
   ```
2. Add to root `package.json`: `"workspaces": ["packages/*", "apps/*"]` (informational; pnpm uses the yaml).
3. Add `transpilePackages: ['@civitai/*']` to `next.config.mjs` so Next compiles workspace packages on demand (no separate build step needed).
4. Create empty package directories with minimal `package.json` files (`name: "@civitai/db"`, `version: "0.0.0"`, `main: "src/index.ts"`).
5. Verify `pnpm install` works and `pnpm run typecheck` still passes.

**Checkpoint:** workspace is alive, nothing imported from it yet.

## Package extraction order

Move packages in dependency order. Each phase ends with `pnpm install`, `pnpm run typecheck`, `pnpm run build` all green.

### Phase 1: `@civitai/db` (Postgres — schema, client, pools)

Everything Postgres in one package: the Prisma schema, generated client,
migrations, programmability scripts, pg connection pools, and helpers.
A future second DB schema (e.g. analytics, separate product) would get
its own package (`myapp-db`) — this one is the canonical Civitai schema.

**Move:**
- `prisma/schema.full.prisma` → `packages/civitai-db/prisma/schema.full.prisma`
- `prisma/migrations/` → `packages/civitai-db/prisma/migrations/`
- `prisma/programmability/` → `packages/civitai-db/prisma/programmability/`
- `prisma/seed.ts` → `packages/civitai-db/prisma/seed.ts`
- `src/server/db/client.ts` → `packages/civitai-db/src/client.ts` (Prisma client wrapper)
- `src/server/db/db-helpers.ts` → `packages/civitai-db/src/db-helpers.ts` (553 lines — pg pools, `cancellableQuery`, prom-client histogram registration)
- `src/server/db/pgDb.ts`, `notifDb.ts`, `datapacketDb.ts`, `db-lag-helpers.ts` → `packages/civitai-db/src/`
- `src/shared/utils/prisma/enums.ts` → `packages/civitai-db/src/enums.ts` (Prisma-generated)
- `src/shared/utils/prisma/models.ts` → `packages/civitai-db/src/models.ts` (Prisma-generated)

**Prisma client output:** add to schema:
```prisma
generator client {
  provider = "prisma-client-js"
  output   = "../generated/client"
}
```
The client now lives *inside* the package, not in root `node_modules/.prisma/client`. Both apps import from `@civitai/db/client`.

**Package exports** (set up `exports` field in `package.json`):
```json
{
  "exports": {
    ".": "./src/index.ts",
    "./client": "./generated/client/index.js",
    "./enums": "./src/enums.ts"
  }
}
```

**Update root scripts:**
- `db:generate`: now runs inside the package
- `db:migrate`: paths in migration scripts get updated

**Refactor for monorepo:**

The current code uses module-level singletons that read `env` directly:
```typescript
// today
import { env } from '~/env/server';
const instanceUrlMap = { primary: env.DATABASE_URL, ... };
export const dbWrite = createClient('primary');
```

For a package consumed by N apps, expose a **factory**:
```typescript
// packages/civitai-db/src/index.ts
export function createDbClients(config: {
  databaseUrl: string;
  databaseReplicaUrl?: string;
  notificationDbUrl: string;
  notificationDbReplicaUrl?: string;
  datapacketReplicaUrl?: string;
  serviceLabel: string;       // for prom-client labels — distinguishes apps
}): {
  dbWrite: PrismaClient;
  dbRead: PrismaClient;
  pgDb: AugmentedPool;
  notifDb: AugmentedPool;
  // ...
}
```

Main app keeps a thin wrapper at `src/server/db/client.ts`:
```typescript
import { createDbClients } from '@civitai/db';
import { env } from '~/env/server';

const clients = createDbClients({
  databaseUrl: env.DATABASE_URL,
  // ...
  serviceLabel: 'civitai-app',
});

export const { dbWrite, dbRead, pgDb, notifDb } = clients;
```
Call sites in main app **don't change** — they still `import { dbWrite } from '~/server/db/client'`. Only the implementation moves.

**Gotchas:**
- `db-helpers.ts:7` imports `dbWrite` from `~/server/db/client` — that's an in-package circular dep once the file moves. Untangle: pass `dbWrite` into helpers that need it, or restructure so `client.ts` and `db-helpers.ts` don't import each other.
- The prom-client `Histogram` registration uses a try/catch fallback for HMR (`db-helpers.ts:30-35`). Keep that pattern — it also handles multiple apps in the same process during testing.
- `Prisma.Sql` type imports come from `@prisma/client`, which lives in this package. Same runtime, same types — just a different module path.

### Phase 2: `@civitai/redis`

**Move:**
- `src/server/redis/client.ts` (1,105 lines — clients + helpers)
- `src/server/redis/caches.ts` (1,571 lines — the cache key constants, TTLs, and `createCachedObject` infrastructure)
- `src/server/redis/queues.ts`, `entity-metric.redis.ts`, `entity-metric-populate.ts`, `resource-data.redis.ts`, `fail-open-log.ts`
- `src/utils/cache-helpers.ts` if it's pure helpers (verify)

**Factory pattern:**
```typescript
export function createRedisClients(config: {
  redisUrl: string;
  sysRedisUrl: string;
  failOpenLogger?: (event: object) => void;
}): {
  redis: RedisClient;
  sysRedis: RedisClient;
  // ...
}
```

The `fail-open-log.ts` currently uses `logToAxiom` directly. Inject the logger via config so the redis package doesn't hard-depend on `@civitai/axiom` — base packages don't import each other.

**Cache key constants:** the key strings + TTLs live inside this package (extracted from `caches.ts` into `keys.ts`) and are exported via a subpath: `@civitai/redis/keys`. A consumer that only wants the keys (e.g. a script that invalidates cache without instantiating a redis client) imports `@civitai/redis/keys` directly; tree-shaking keeps the redis client out of their bundle.

### Phase 3: `@civitai/clickhouse`

**Move:** `src/server/clickhouse/client.ts` (733 lines).

Same factory pattern as `@civitai/db`. ClickHouse client is simpler — single URL, no replica routing.

```typescript
export function createClickhouseClient(config: {
  url: string;
  database: string;
  username: string;
  password: string;
}): ClickHouseClient;
```

If ClickHouse query helpers live in services (e.g., event tracking helpers), leave those in the app — only the connection layer moves.

### Phase 4: `@civitai/axiom`

**Move:** `src/server/logging/client.ts` (58 lines — `axiom`, `safeError`, `logToAxiom`).

Smallest, simplest package. Almost a single-file package, but useful as a clean dependency boundary.

```typescript
export function createAxiomLogger(config: {
  token?: string;
  orgId?: string;
  datastream?: string;
  podName?: string;
  echoToStderr?: boolean;
}): { logToAxiom, safeError };
```

### Phase 5: `@civitai/telemetry`

OTEL is **two things** that have to be separated:

1. **Auto-instrumentation registration** — `src/instrumentation.node.ts` calls `sdk.start()` and patches Prisma/Redis/HTTP at process load. **This stays per-app** (every app has its own `instrumentation.node.ts` with its own service name). Cannot move into a package without losing the auto-load behavior.
2. **Helpers** — `withSpan`, span attribute helpers, the `src/utils/otel-helpers.ts` utilities. **These move** into `@civitai/telemetry`.

The package can also export a `bootstrapOtel(config)` function that does what `instrumentation.node.ts` does today, so the per-app file becomes a 3-liner:
```typescript
// apps/moderator/src/instrumentation.node.ts
import { bootstrapOtel } from '@civitai/telemetry/node';
bootstrapOtel({ serviceName: 'civitai-moderator' });
```

`prom-client` metrics registration (`src/server/prom/client.ts`) follows the same pattern — helpers in the package, registration call in the app.

## Cross-cutting concerns

### env validation

Currently in `src/env/server.ts` (T3-style zod validation). Two options:
- **Per-app env:** each app validates its own env. Packages receive parsed config via factories (preferred — already aligned with the factory pattern above).
- **Shared env package:** `@civitai/env` exports the zod schema. Brittle when apps need different subsets.

Recommend per-app env. Packages never import `env` directly.

### Migration tooling

`prisma/migrations/` moves to `packages/civitai-db/prisma/migrations/`. The migration scripts in `scripts/` (e.g., `prisma-migrate-with-views-workaround.mjs`) update their paths. Manual application convention (per CLAUDE.md) doesn't change.

### Prisma client version pinning

`@prisma/client` and `prisma` (CLI) move to `packages/civitai-db/package.json`. Main app no longer declares them directly — depends on `@civitai/db` which depends on `@prisma/client`. Single Prisma version across the workspace.

### CI

- One `pnpm install` at workspace root installs everything
- `pnpm -r run typecheck` typechecks all packages + apps
- `pnpm run build` (in main app) still produces a Next standalone bundle
- Existing CI workflows mostly survive — main entry points are unchanged
- Add `paths:` filters to `pr-check.yml` so changes inside `apps/moderator/` don't retrigger main-app builds (and vice versa); without it every PR rebuilds everything

### Docker

Two specific changes to the existing `Dockerfile`:

1. **Workspace-aware install layer.** Before `pnpm install`, copy `pnpm-workspace.yaml` plus every `package.json` in the workspace (root + `packages/*` + `apps/*`), not just root `package.json`. This preserves the install-layer caching trick — lockfile + package.jsons rarely change, so the install layer stays warm.

   ```dockerfile
   COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
   COPY packages/*/package.json ./packages/
   COPY apps/*/package.json ./apps/   # only after satellites exist
   RUN pnpm install --frozen-lockfile
   ```

2. **Updated Prisma schema paths.** Current Dockerfile has two `COPY` lines that pin `prisma/schema.full.prisma` and `prisma/schema.prisma` for layer caching — update both to `packages/civitai-db/prisma/...`.

For the satellite app's eventual `apps/moderator/Dockerfile`, use `pnpm deploy --filter <app> --prod /tmp/out` to produce a slim deployment bundle containing only that app's transitive deps. That bundle becomes the COPY source for the runner stage. This is the pnpm-blessed pattern for monorepo Docker images.

### Next.js `output: 'standalone'` with workspace packages

The main app's production runtime depends on `.next/standalone` (Dockerfile line 61). Standalone mode uses `nft` (Node File Trace) to determine what to ship. With workspace packages, you need **one of**:

1. **`transpilePackages: ['@civitai/*']`** in `next.config.mjs` — Next inlines the package source into the build output. Simplest, already in the Phase 0 plan.
2. **`outputFileTracingRoot: path.join(__dirname, '../..')`** — tells `nft` to follow symlinks to the workspace root. Required only if packages have their own `tsc --build` step producing pre-built `.js`.

Going with option 1. Option 2 only matters if you later want each package to have a build output for some reason (publishing, faster cold builds with caching).

### Tooling explicitly not needed

- **Turborepo / Nx.** Worth it when many packages × many apps × slow CI. For 6 packages + 2 apps, raw pnpm is simpler. Add later if CI build time becomes a real problem.
- **Changesets / lerna.** Only for externally-published packages. `workspace:*` handles internal versioning.
- **TypeScript project references** (`references` in tsconfig). Next + `transpilePackages` handles cross-package compilation transparently.
- **Separate publish/registry setup.** Packages stay internal.

### Migration of existing branches

Best to do this on a **freeze week** with minimal active branches. Each open branch will need a rebase that picks up the package boundary. The shim-export approach (Phase 1's re-export trick) softens the blow: branches that haven't been touched still compile because old import paths keep working.

### Git history preservation

Git tracks renames *implicitly* — it infers them at read time by comparing deleted vs. added file content per commit, with a default 50% similarity threshold. To make sure `git log --follow` and `git blame` keep working across the move, follow this pattern per file:

**Three-commit-per-file pattern:**

1. **Pure move.** `git mv src/server/db/db-helpers.ts packages/civitai-db/src/db-helpers.ts` — no content changes. Git unambiguously detects the rename.
2. **Refactor.** Now edit imports, swap `env` for factory config, untangle circular deps. Small diff, correctly attributed via blame.
3. **Add shim** (if applicable). Create the new one-liner re-export at the old path. It's a genuinely new file — no history needed because the original content's history lives at the package path.

**Tools the team should know:**

- `git log --follow <path>` — shows full history across renames. Plain `git log <path>` does *not*.
- `git blame` — follows simple renames automatically. `git blame -C` also detects content copied from other files (useful for file *splits*).
- GitHub web UI — follows renames in "View blame" and file history without flags.

**Pitfalls to avoid:**

- **Combining move + significant edit in one commit.** If content similarity drops below 50%, Git misses the rename and history becomes findable but not followable.
- **Squash-merging the migration PR.** Collapses the three-commit pattern into one big diff, increasing the chance rename detection fails. Use **rebase-merge** or a **merge commit** for migration PRs.
- **File splits.** If `db-helpers.ts` is split into multiple files during the move, Git only auto-detects the rename for the file with the highest content overlap. Prefer move-then-split (move file, then in a later commit split it) over split-then-move.

## Decisions

1. **Package naming.** `@civitai/...` scoped, or unscoped (`civitai-...`)?
@dev: scoped is good
@ai: Confirmed — all packages use the `@civitai/` scope. Reserve the npm org name (even if never publishing publicly, it makes future publishing trivial and avoids name collisions).

2. **Single `@civitai/data` package vs. four (`db`, `redis`, `clickhouse`, `axiom`)?**
@dev: I'm fine with four
@ai: Confirmed — four narrow packages. A future text-only utility app can depend on `@civitai/db` alone without pulling in ClickHouse or Axiom.

3. **Schema-common scope.** Should it include the `~/server/schema/*.schema.ts` zod files used by moderator pages, or defer those to a later phase?
@dev: If there is server schema constants that we need, then they should be extracted. I don't think any of these smaller sub-projects should need zod schemas to work
@ai: Agreed. The Phase 1–5 infrastructure packages (db/redis/clickhouse/axiom/telemetry) don't import any zod schemas — they only need Prisma types. Any `~/server/schema/*.schema.ts` extraction is deferred until the moderator-app phase, when we know exactly which schemas the satellite needs (`report.schema`, `strike.schema`, `image.schema`, `scanner-review.schema` are the likely candidates from the moderator dependency analysis — see [moderator-app-shared-modules.md](./moderator-app-shared-modules.md)).

4. **Re-export shims (Phase 1 transition).** Keep them indefinitely (drift-tolerant) or set a deadline to delete them after main-app migration completes?
@dev: Not sure what you mean there. We probably want to keep them drift tolerant
@ai: Clarified — "re-export shim" means leaving the old file (e.g. `src/server/db/client.ts`) as a one-line file that re-exports from the new package: `export * from '@civitai/db'` (or a thin wrapper that calls `createDbClients` with main-app env). Existing imports `~/server/db/client` continue compiling unchanged. **Drift-tolerant** = keep these shim files indefinitely so we never need to mass-rewrite the ~2,500 call sites in main app. Going with drift-tolerant. Cost is having two valid import paths for the same code (some convention noise in reviews); benefit is zero forced churn.

5. **Move main app to `apps/main/` eventually?**
@dev: I think we would move it to apps/main/ eventually.
@dev (update): Skipping Phase 6 for now to avoid needing a freeze week. New apps live in `apps/`; main app stays at root indefinitely. Revisit only if a third app or strong reason emerges.
@ai: Acknowledged. Phase 6 is now genuinely optional — the shim approach and factory-pattern packages don't depend on it. Main-at-root is fully supported by pnpm workspaces as a first-class member (`packages: ['.', 'packages/*', 'apps/*']`). The asymmetric layout has no functional cost; the only friction is mild aesthetic inconsistency if a third app eventually joins.

### Phase 6 (optional, not planned): move main app to `apps/main/`

Currently **skipped indefinitely** to avoid the freeze-week cost. The asymmetric layout (main at root + satellites in `apps/`) is the planned permanent state.

If a future trigger justifies revisiting — a third app, strong consistency preference, tooling that breaks on asymmetry — the move would be:

- `git mv src/ apps/main/src/`
- `git mv next.config.mjs apps/main/`
- `git mv prisma-related root scripts → apps/main/` (only the app-specific ones, not workspace-level)
- Update root `package.json` → workspace-only (no app deps)
- Update `pnpm-workspace.yaml` to drop root from the packages list
- Update CI workflows that target the root
- Requires a freeze week with no active feature branches

## Phase summary

| Phase | Package | Effort | Risk |
|---|---|---|---|
| 0 | Workspace bootstrap | Low | Low — just config |
| 1 | `@civitai/db` | High | Medium — Prisma client path change is the trickiest single step; circular dep in `db-helpers.ts` to untangle |
| 2 | `@civitai/redis` | Medium | Low — lots of files, mostly mechanical |
| 3 | `@civitai/clickhouse` | Low | Low |
| 4 | `@civitai/axiom` | Low | Low |
| 5 | `@civitai/telemetry` | Medium | Medium — splitting auto-instrumentation from helpers requires care |
| 6 | Move main app to `apps/main/` | — | **Not planned** — kept at root indefinitely to avoid freeze-week cost |

After Phase 5, the foundation is in place for `apps/moderator` to exist as a workspace member that consumes these packages — that's a separate plan (see [moderator-app-shared-modules.md](./moderator-app-shared-modules.md)).
