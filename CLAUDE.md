# Civitai Development Guide

## How to work with us
We use markdown documents to discuss plans. Documentation goes in the `docs/` folder.

### Inline Comments
Occasionally, we comment back and forth as we make plans. Comments from us, are marked with `@dev:` and you can leave comments as well with `@ai:`. Please make comments inline in the document. If there are actions are requested in my comments, please take them.

**New Comment Marking**: When you add new comments, use an asterisk after the mention (e.g., `@justin:*` or `@meta:*`). Once you reply or acknowledge a comment, remove the asterisk so that I know it's been seen. Note: Sometimes I might forget to add the asterisk to my new comments, so please check all comments regardless of marking.

**Example**
```
@dev: This comment has been processed (asterisk removed)
@ai: Of course
@dev:* This is a new comment that needs attention
```

## Repository Layout

pnpm workspaces (`.`, `packages/*`, `apps/*`) with turbo. The root package **is**
the main Next.js app (`src/`), not just a workspace container.

- **`src/`** — the main app; most work happens here
- **`packages/civitai-*`** — shared libraries (`auth`, `buzz`, `db`, `db-schema`,
  `redis`, `clickhouse`, `shared`, `ui`, `telemetry`, …)
- **`apps/*`** — spoke apps (`auth`, `moderator`, `event-engine`, `storage`,
  `notifications`, `creator-studio`, `orchestrator-gateway`), each with its own
  release script and tag prefix
- **`event-engine-common`** — git submodule; `git submodule update --init` it or
  typecheck fails with a wall of `Cannot find module`

### Adding a `@civitai/*` package means editing three files

A `@civitai/*` import is resolved in up to three places, and they don't all list
the same packages today:

1. `tsconfig.json` `paths`
2. `next.config.mjs` `transpilePackages`
3. `vitest.config.mts` `civitaiWorkspacePkgs` (vitest doesn't read tsconfig paths)

Miss the third and every suite that transitively imports the package fails to
*collect*, not merely fail.

## Tech Stack Overview

**Pages Router** (`src/pages`) — there is no `app/` directory, no server
components, no `"use client"`. Every `.ts`/`.tsx` under `src/pages` is a route, so
no colocated helpers, components or tests live there.

### Core Technologies
- **Framework**: Next.js 16 with TypeScript (`.nvmrc` pins Node 24.18.0)
- **UI Library**: Mantine v7
- **Styling**: Tailwind CSS + SCSS Modules
- **Database**: PostgreSQL with Prisma ORM
- **API**: tRPC
- **State Management**: Zustand
- **Authentication**: custom — `src/server/auth/`, shared impl in `packages/civitai-auth`
- **Search**: Meilisearch
- **Image Processing**: Sharp

### Additional Libraries
- React Query (Tanstack Query) for data fetching
- React Hook Form with Zod validation
- Tiptap for rich text editing
- Chart.js for data visualization
- Stripe/Paddle/PayPal for payments

## Build Commands

### Development
**Always use the `/dev-server` skill** to manage dev servers. Never use `pnpm run dev` directly.

### Build & Deploy
```bash
pnpm run build            # Production build
```

### Code Quality
```bash
pnpm run typecheck        # full repo
pnpm run lint             # ESLint over src/
pnpm exec prettier --write <files>   # only what you touched — see Before Committing
```

### Testing
```bash
pnpm test:unit:run        # ~8,900 unit tests (node env) — the usual one
pnpm test:unit:run <path>  # single file; add -t "name" for a single test
pnpm test:component       # ~860 component tests in real Chromium, slower
pnpm test                 # Playwright e2e (tests/); preview-* need PREVIEW_URL
```

Several dozen unit files fail to *collect* without the submodule, and the
component suite can report two extra failures on a cold cache. Both look like you
broke something. Run the suite on unmodified `main` first and compare — see
[CONTRIBUTING.md](CONTRIBUTING.md) for the details and the `prettier --write`
footgun.

#### Never put unit tests under `src/pages`
Next.js 16 treats **every** `.ts`/`.tsx` file under `src/pages` (incl. nested `__tests__/`) as a route, and `next build` runs a route-type validator over it. A Vitest test file there fails the build with `Type '...test' does not satisfy the constraint 'ApiRouteConfig'. Property 'default' is missing` — and **only `next build` catches it**: `pnpm typecheck`, `pnpm test`/vitest, and the CI typecheck/unit/component tasks all pass, so it sneaks through to the preview `build-image` step. Keep handler tests in a `__tests__/` dir **outside** `src/pages` (e.g. `src/server/__tests__/`) and import the handler via the `~/pages/...` alias. (Bit us on PR #2653.)

### Database
```bash
pnpm run db:migrate:empty  # Create an empty migration file
```

**CRITICAL: We do NOT use `prisma migrate deploy`. Migrations are applied manually.**
- Migration files in `packages/civitai-db-schema/prisma/migrations/` exist for review/history but are never auto-run. That is the only directory Prisma reads — the `prisma/migrations/` path at the repo root predates the monorepo, no longer exists, and CI blocks re-creating it.
- Each environment's DB is updated by a human running the SQL directly (psql, retool, etc.)
- The `_prisma_migrations` table is not the source of truth — do not rely on it
- When you add a new migration: write the SQL, commit it, and surface to the user that it needs to be applied manually to wherever they want it (preview / staging / prod)
- Never suggest `prisma migrate deploy`, `prisma migrate resolve`, or any auto-apply path

### Release (requires user permission)
```bash
pnpm run release          # Patch release (0.0.x) - default
pnpm run release:minor    # Minor release (0.x.0)
pnpm run release:major    # Major release (x.0.0)
```
**IMPORTANT**: Never run release commands without explicit user approval. These commands bump the version, push tags, and rebase the release branch.

## `src/server`

Layered `routers/` (zod input in `schema/`) -> `controllers/` -> `services/` -> `db/`,
plus `search-index/`, `redis/`, `jobs/`, `metrics/`. **Grep for the symbol** — the big
services are 4-8K lines (`image.service.ts` is 8.2K).

Non-obvious things that cost real work to rediscover:

- **Reads use `dbRead`, writes `dbWrite`.** A read that must observe a just-committed
  write goes through `db/db-lag-helpers.ts`, not `dbWrite`.
- **No awaited I/O inside `db.$transaction`.** `local-rules/no-io-in-transaction`
  flags it but is set to `warn`, so `pnpm lint` stays green — capture ids in the
  callback and do `fetch`/S3/Redis/search work after it commits.
- **The image feed has two backends**: `getAllImages` (Postgres) and
  `getAllImagesIndex` (Meilisearch), chosen in `image.controller.ts` behind a Flipt
  flag. A filtering or NSFW change applied to one silently misses the other.
- **A search-index field is two edits**: declare it in `onIndexSetup`'s
  searchable/sortable/filterable lists *and* emit it from the transformer. Existing
  documents are not backfilled — they need a re-index.
- **Feature flags live only in** `services/feature-flags.service.ts` (`availability`
  is the Flipt-down fallback, `fliptKey` the runtime ramp); client side
  `useFeatureFlags()`. Don't invent a `NEXT_PUBLIC_` env var.
- `api/health.ts` runs its sub-checks under `Promise.all`, so one slow check trips
  the kubelet probe budget.

## Component Standards

Match the surrounding file. The things you would otherwise guess wrong:

- Enums come from `~/shared/utils/prisma/enums`, **not** `@prisma/client`
- tRPC client is `~/utils/trpc`; current user is `useCurrentUser()` from `~/hooks/useCurrentUser`
- Images use `EdgeMedia`/`EdgeImage` (CDN-aware), not `next/image`
- Dialogs are registered in `src/components/Dialog/dialog-registry2.ts`
- Global state Zustand, server state React Query, forms React Hook Form + Zod

### Comments

Comments are not type-checked, so they rot silently and become misleading. Bias
toward none. Comment the non-obvious *why* — a rationale, tradeoff, gotcha or
workaround a reader cannot recover from the code. Never narrate what the next line
does, and don't describe nearby code's current behaviour; that is exactly what goes
stale. When you edit code carrying stale or what-narrating comments, fix or delete
them rather than preserving them.

## Environment Setup

`src/env/server.ts` and `src/env/client.mjs` are the authoritative env-var lists.

### Local Development
1. Install dependencies: `pnpm install`
2. Generate Prisma client: `pnpm run db:generate`
3. Start dev server: Use `/dev-server` skill

### Git Worktrees
When you create a new worktree (`git worktree add …`), **always initialize the `event-engine-common` submodule
in it**: `git submodule sync --recursive && git submodule update --init event-engine-common`.
Worktrees don't check out submodules automatically,
and without it `pnpm typecheck`/`build` fail with a wall of `Cannot find module '.../event-engine-common/...'`
errors (and the missing types cascade into unrelated `implicitly has an 'any' type` errors) — noise that looks
like your change broke something when it didn't.

## Important Notes

- Service files run 4-8K lines. **Grep for the symbol; don't read the file** —
  `image.service.ts` alone is ~100K tokens.
- Prettier/ESLint do not start at zero: ~789 unformatted `src` files and ~3,470
  eslint warnings pre-exist. Never "fix" files you didn't touch.
- When corrected, re-read the correction before proceeding.

### Before Committing
1. Run type checking: `pnpm run typecheck`
2. Run linting: `pnpm run lint`
3. Format **only what you touched**: `pnpm exec prettier --write <files>`.
   Never `pnpm prettier:write` — it ignores arguments and reformats the repo, and
   789 of 4,116 `src` files fail `--check` today (see `lint.yml`), so that lands a
   ~789-file diff. CI blocks on files you *add*; modified files are report-only.
4. Test changes locally

### Stacked PRs — don't
- **NEVER use stacked PRs** — base every PR directly on the integration branch (`main`, or a feature integration branch like `feat/...`), never on another open PR's branch. Stacked PRs silently mis-merge: a squash-merged parent doesn't retarget the child, so the child lands on the orphaned parent branch instead of the real base and its changes go missing.
- If a change depends on an unmerged PR, **wait for that PR to merge, then branch off the updated base** — or fold both changes into a single PR.
- (Bit us 2026-06-13: PR #2520's App Blocks W11 F5 was stacked on #2518 (F6) → #2520 squash-merged into the #2518 branch instead of `feat/app-blocks-main-v1`; corrected via #2525.)

## Common Patterns

Infinite scroll uses the `MasonryColumns/` components with React Query infinite
queries; file uploads go through the S3 upload hooks. Otherwise: find the nearest
existing example rather than inventing a pattern.

## Debug Endpoints (`src/pages/api/testing/*`)

`src/pages/api/testing/*.ts` is the convention for hidden debug endpoints. Each endpoint is guarded by `WEBHOOK_TOKEN` (via `WebhookEndpoint(...)`, which checks the `?token=` query param) and exposes a handful of POST actions for experimenting with a feature without paying real money or hand-editing the DB.

**To use one**: read the endpoint's source file directly — the top-of-file comment documents the available actions and required params, and the zod schema is the authoritative contract. Agents should never need a wrapper skill; cURL with `?token=$WEBHOOK_TOKEN` appended to the URL is enough.

**When adding a new debug endpoint**:
1. Drop it at `src/pages/api/testing/<feature>.ts`
2. Use `WebhookEndpoint(handler)` for auth
3. Lead the file with a block comment listing each action + its params + a one-line description (see `src/pages/api/testing/referrals.ts` for the pattern)
4. Scope every destructive action to a single `userId`/`refereeId` per call so a misuse can't cascade

## Feature Documentation

Before implementing a feature, `ls docs/features/` — ~59 files, yours is probably
there. Wider design docs and investigations live in `docs/`.

## Troubleshooting

Out of memory: `pnpm run dev-debug` (8 GB) or `dev-low` (6 GB). Dev servers are
managed by the `/dev-server` skill — never `pnpm run dev` directly.
