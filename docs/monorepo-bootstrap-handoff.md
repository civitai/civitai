# Session Handoff — Monorepo Bootstrap

This document captures the state and reasoning from the planning session that produced this worktree, so a fresh Claude session can pick up the work without re-discovering decisions.

## Where you are

- **Worktree:** `c:\Work\model-share-monorepo-bootstrap`
- **Branch:** `monorepo-bootstrap` (branched from `main`)
- **HEAD:** at latest `origin/main` (synced before the moves)
- **Nothing is committed on this branch yet** — all changes are staged, awaiting review.

## What's staged (uncommitted)

Run `git status --short` to see the live state. As of handoff:

- **616 renames (R)** — pure file moves, zero content changes. Every file is at 100% similarity (`R100`).
- **3 new docs (A)** — the planning docs in `docs/`:
  - `monorepo-conversion-plan.md` — the full plan with phases, decisions, and operational details
  - `monorepo-directory-snapshot.md` — shareable view of the post-conversion directory layout
  - `moderator-app-shared-modules.md` — separate dependency analysis for the future moderator app (referenced from the conversion plan but doesn't gate this work)

The staged moves implement **Phase 1–5 file relocations** into `packages/civitai-{db,redis,clickhouse,axiom,telemetry}/`. Build is intentionally broken at this point — re-export shims (described in the plan) come in follow-up commits.

## Key decisions (with reasoning)

These were settled in conversation; read them before suggesting alternatives.

1. **Five base packages, not six.** No `civitai-schema-common`. The user's instinct was right: the only files that would have lived there were domain constants (bit-flag interpretations like `browsingLevel.constants.ts`, identifier formats like `air.ts`, and the generic `flags.ts` helper). Those are **not infrastructure** — they're domain conventions. They stay in `src/shared/` in the main app for now. Re-evaluate only when the satellite app actually needs them.

2. **Base packages are infrastructure only.** `civitai-db`, `civitai-redis`, `civitai-clickhouse`, `civitai-axiom`, `civitai-telemetry`. Each wraps a single piece of runtime infrastructure.

3. **Base packages don't import from each other.** No `@civitai/*` deps on a sibling base package. External deps only. Higher-level packages (e.g. a future `civitai-moderator-common`) may compose multiple base packages, but base packages stay independent. If two base packages need shared constants, expose them via a subpath (e.g. `@civitai/redis/keys`).
   - **Amended (2026-06-03):** one exception — a **contract/leaf layer** below the infra packages. `@civitai/db-schema` is a pure schema + generated-types artifact with no runtime; infra packages may depend **downward** on it (like depending on `@prisma/client`). The rule still forbids one infra package importing *another infra package's runtime* — a types/schema package is a lower layer, not a sibling.

4. **~~All Prisma stuff lives in `civitai-db`.~~ AMENDED (2026-06-03): split into two packages.** The Prisma *schema, migrations, programmability, generated client, `enums.ts`, `models.ts`* move down into **`@civitai/db-schema`** (the source-of-truth contract). **`@civitai/db`** keeps only the Prisma-client *runtime* (`createPrismaClients` factory, pg `Pool` factory, query helpers) and imports the generated client/types from `@civitai/db-schema`.
   - **Why:** the [`civitai-advertising`](file:///C:/Work/civitai-advertising) app drives **Kysely** off a Prisma-generated schema (two generators on one `schema.prisma`; runtime is `new Kysely<DB>()` over raw `pg`, never the Prisma client). Splitting the contract out lets a future app pick Kysely without dragging in the Prisma-client runtime.
   - **`prisma-kysely` is baked in now:** the schema package runs a second generator (`prisma-kysely`) emitting Kysely `DB` types via subpath `@civitai/db-schema/kysely`, so a Kysely consumer is unblocked without re-touching the schema package.
   - Still **6 packages**, distinct from the rejected `civitai-schema-common` (decision 1) — that was *domain constants*; this is the *Prisma DB contract*. A future second DB schema still gets its own package. See `docs/monorepo-package-adaptation-plan.md` §4 for the full layout.

5. **Main app stays at repo root.** Symmetric `apps/main/` layout (Phase 6 in the plan) is **not planned**. Skipped to avoid a freeze-week mass-move. New apps live in `apps/`; main stays at root indefinitely.

6. **Re-export shims are kept indefinitely.** The plan to keep old import paths (`~/server/db/client`, etc.) as one-line re-exports forwarding to `@civitai/db` is the drift-tolerant approach. Means main-app call sites never need touching. Two valid import paths for the same code is acceptable.

7. **OTEL auto-instrumentation stays per-app.** `src/instrumentation.node.ts` keeps the `sdk.start()` call (with the app-specific service name); only the helpers (`withSpan`, etc.) and the prom-client helpers move into `@civitai/telemetry`. Same applies to per-app `prom-client` registration.

8. **Factory pattern, not module-level singletons.** Today's `db-helpers.ts` exports `dbWrite` as a constant that reads `env` directly. In the monorepo state, each package exports a `createXClients(config)` factory; each app instantiates with its own env and a `serviceLabel` (for prom-client labels). Main-app call sites don't change because a thin wrapper file (the shim) re-exposes the same names.

## Constraints that affect implementation

- **Prisma client output** moves into the package via `output = "../generated/client"` in `schema.full.prisma`. Both apps import from `@civitai/db/client`, never from `@prisma/client` directly. This avoids two-copies-with-nominally-different-types.
- **Dockerfile** has two existing `COPY` lines pinning Prisma schema paths (lines 11 and 38 of the current Dockerfile) — they need updating to `packages/civitai-db/prisma/...`. Workspace install layer needs to copy `pnpm-workspace.yaml` + all `packages/*/package.json` before `pnpm install`.
- **Next.js `output: 'standalone'`** needs `transpilePackages: ['@civitai/*']` added to `next.config.mjs` (the alternative, `outputFileTracingRoot`, only matters if packages have pre-built `tsc` output, which we're not doing).
- **Manual migrations.** Civitai applies Prisma migrations manually (`prisma migrate deploy` is forbidden per `CLAUDE.md`). The move doesn't change that — migrations move to `packages/civitai-db/prisma/migrations/` and human still runs them by hand. The `scripts/prisma-migrate-with-views-workaround.mjs` references need their paths updated.
- **`db-helpers.ts` has a circular-dep landmine.** Line 7 imports `dbWrite` from `~/server/db/client.ts`. When both move into the same package, this becomes an in-package cycle. Untangle by passing `dbWrite` into helpers that need it, or restructure so the two files don't import each other.
- **HMR-safe prom-client registration.** `db-helpers.ts:30-35` has a try/catch fallback for re-registering the Histogram when HMR re-runs the module. Keep that pattern — it also handles multiple apps in the same process during testing.

## Planning docs in this repo

Read these (in order) before making decisions:

1. **`docs/monorepo-conversion-plan.md`** — the source of truth. Has phases, all open-question decisions with `@dev:`/`@ai:` exchanges, operational details (Docker, CI, Next standalone).
2. **`docs/monorepo-directory-snapshot.md`** — shareable directory-tree view of the post-conversion state.
3. **`docs/moderator-app-shared-modules.md`** — separate analysis for the future moderator app (relevant context, not blocking this work).

## What's next (the actual work)

The current staged commit is the **file-relocation step**. After it's committed, the remaining phases are:

**Phase 0 — Workspace bootstrap** (config only, no file changes):

- Add `pnpm-workspace.yaml` with `packages: ['.', 'packages/*', 'apps/*']`
- Add `transpilePackages: ['@civitai/*']` to `next.config.mjs`
- Create `package.json` for each of the 5 new packages (`@civitai/db`, `@civitai/redis`, `@civitai/clickhouse`, `@civitai/axiom`, `@civitai/telemetry`) with name + version + main field
- Each gets a `tsconfig.json` (copy the pattern from `event-engine-common/tsconfig.json`)

**Phase 1 — `@civitai/db`** (this is the heaviest one):

- Add `@prisma/client`, `prisma`, `pg`, `prom-client` to `packages/civitai-db/package.json`
- Update `schema.full.prisma` with `output = "../generated/client"`
- Update root scripts (`db:generate`, `db:migrate`, etc.) to point at the new path
- Refactor `db-helpers.ts` into a `createDbClients(config)` factory
- Untangle the `client.ts` ↔ `db-helpers.ts` circular dep
- Write re-export shim at `src/server/db/client.ts` (and others) that calls `createDbClients` with main-app env and re-exports the same names. Existing call sites in main app keep working unchanged.
- Verify: `pnpm run typecheck`, `pnpm run build`, `pnpm run dev` all work.

**Phases 2–5 — same pattern for redis, clickhouse, axiom, telemetry.** Each is mostly mechanical after Phase 1 establishes the factory + shim pattern. See the plan for specifics.

**Phase 6** — skipped (per decision 5 above).

## Commit shape (user's preference TBD)

The user hasn't committed to a commit-split scheme yet. Two reasonable options:

- **One commit:** `chore: bootstrap monorepo layout (pure file moves + planning docs)`
- **Two commits:** `docs: ...` then `refactor: move infra files to packages/* (pure rename)`

The two-commit split is what the previous worktree used and reads cleaner. Either works for rename-detection. Ask the user before committing.

## Things to be careful about

- **Don't combine move + edit in one commit.** Git rename detection has a 50% similarity threshold. If you `git mv` + edit content in the same commit, history may not follow. The current staged state is pure-move; preserve that by committing it before any refactors.
- **Don't squash-merge the migration PRs.** Squash collapses the move/refactor/shim commits into one big diff, raising the risk that Git misses renames. Use rebase-merge or merge-commit for the monorepo conversion PR(s).
- **Origin's `monorepo-conversion` branch is an artifact.** Previous worktree (now deleted) had an earlier rename-detection test on branch `monorepo-conversion` (commit `22d242dee` with the now-rejected schema-common split). That branch is left untouched on origin as a record of the rename test. Don't try to "fix" it.
- **Verify rename detection after any rebase.** If you rebase this branch and the rebase combines commits, re-check `git log --stat HEAD~..HEAD` shows `R100` entries, not paired `A`+`D`.
- **The 3 planning docs are currently staged as new files (`A`).** Same commit will include them. If you split commits, decide which commit they belong to.

## Quick verification commands

```bash
# How many staged renames?
git -C c:/Work/model-share-monorepo-bootstrap status --short | awk '{print $1}' | sort | uniq -c

# Are renames at 100% similarity?
git -C c:/Work/model-share-monorepo-bootstrap diff --cached -M --stat | tail -5

# Where does a file's history live now? (spot-check rename detection)
git -C c:/Work/model-share-monorepo-bootstrap log --follow --oneline -5 -- packages/civitai-db/src/db-helpers.ts

# Confirm worktree is at latest main
git -C c:/Work/model-share-monorepo-bootstrap fetch origin main
git -C c:/Work/model-share-monorepo-bootstrap log --oneline HEAD..origin/main
```
