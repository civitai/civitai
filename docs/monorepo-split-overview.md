# Separating Moderator Pages into a Standalone App

## Problem

Two issues with the current single-app build:

1. **Build time**: The app compiles 367 page entry points on every build. Of those, **~85 are moderator pages and mod API routes** that most developers and all end users never touch. Removing them from the main build means ~23% fewer webpack entry points and faster compilation.

2. **Deployment bloat**: The main web app ships all 42 moderator pages, 36 mod API routes, and 57 admin API routes in its production bundle. Users download code they'll never use, and internal tooling is exposed as part of the main application surface area.

### Page Breakdown

| Category | Files | % of total | LOC |
|----------|-------|------------|-----|
| Moderator pages | 42 | 11% | 9,731 |
| Mod API routes | 36 | 10% | 2,805 |
| Admin API routes (moderation-related) | ~7 | 2% | ~1,500 |
| Admin API routes (system/cron/migrations) | ~50 | 14% | ~7,265 |
| Everything else | 232 | 63% | — |
| **Total** | **367** | | |

**Note on `/api/admin/` routes**: Most admin routes are webhook/cron endpoints for system operations (cache management, data migrations, payment processing), not moderator tools. Only ~7 are actual moderation actions (`delete-images`, `unpublish-all-models`, `rescan-images`, `cancel-subscription`, `grant-subscription`, `deliver-prepaid-buzz`, `manage-sanity-checks`). The rest should stay in the main app. See the [Admin Route Analysis](#admin-route-analysis) section for the full breakdown.

Additionally, the tRPC endpoint (`src/pages/api/trpc/[trpc].ts`) imports the full `appRouter` with all 78 routers on every build. The dedicated `modRouter` can be conditionally excluded to reduce server bundle compilation.

**Goal**: Deploy the main app _without_ moderator pages. Deploy moderator tooling as a separate app. Reduce build time for both.

---

## Why Not a Full Monorepo Refactor?

A traditional full monorepo split (Turborepo, pnpm workspaces, `apps/` + `packages/`) would require:

- Moving all 2,500+ source files into workspace packages
- Rewriting every `~/` import path across the entire codebase
- Extracting Prisma, auth, tRPC, and UI into shared packages
- **Every active branch would have catastrophic merge conflicts**

This is a multi-month effort with high risk and no incremental value until it's fully complete.

However, a **staged monorepo** — moving only moderator code — is feasible. See the two approaches below.

---

## Approach A: Staged Monorepo (Recommended)

Move only the moderator pages into a separate Next.js app within a pnpm workspace. The main app stays at the project root — zero files move for the main app. The moderator app imports shared code from `src/` via the `~/` path alias.

**Key insight**: Moderator pages are leaf nodes in the dependency graph. They import from `src/`, but nothing in `src/` imports from them. This means moving them doesn't break any existing code.

### Directory Structure

```text
civitai/                           # Main app stays here (UNCHANGED)
├── apps/
│   └── moderator/                 # NEW — separate Next.js app
│       ├── package.json
│       ├── next.config.mjs
│       ├── tsconfig.json          # ~/  →  ../../src/
│       └── pages/
│           ├── _app.tsx           # Thin wrapper importing providers from ../../src
│           ├── _document.tsx
│           ├── moderator/         # MOVED from src/pages/moderator/
│           └── api/
│               ├── mod/           # MOVED from src/pages/api/mod/
│               ├── admin/         # MOVED from src/pages/api/admin/
│               ├── auth/          # Re-exports main app's NextAuth config
│               ├── trpc/          # Re-exports main app's tRPC handler
│               └── user/          # Re-exports user settings API
├── src/                           # UNCHANGED (minus the moved pages)
│   ├── pages/                     # Main app pages (moderator/ and api/mod/ removed)
│   ├── components/                # All shared components stay here
│   ├── server/                    # All shared server code stays here
│   └── ...
├── package.json                   # Updated: add workspace config
├── pnpm-workspace.yaml            # NEW
├── turbo.json                     # NEW (optional, for build caching)
├── next.config.mjs                # Main app config (minor update)
└── Dockerfile.web / .moderator    # Separate Docker builds
```

### How It Works

1. **pnpm workspaces** manages both apps. The moderator app at `apps/moderator/` is a separate workspace with its own `package.json` and `next.config.mjs`.

2. **Shared code stays in `src/`**. The moderator app's `tsconfig.json` maps `~/` to `../../src/`, so all existing imports in the moved pages work without changes. The moderator app's `next.config.mjs` uses a webpack alias to resolve `~/` at build time.

3. **Each app builds independently**. `pnpm build` builds the main app (without moderator pages). `pnpm --filter moderator build` builds the moderator app. With Turborepo, both builds can be cached and run in parallel.

4. **Local dev** also works independently: `pnpm dev` runs the main app, `pnpm --filter moderator dev` runs the moderator app.

### What Moves

| From | To | Files |
|------|----|-------|
| `src/pages/moderator/` | `apps/moderator/pages/moderator/` | 42 |
| `src/pages/api/mod/` | `apps/moderator/pages/api/mod/` | 36 |
| ~7 moderation-related routes from `src/pages/api/admin/` | `apps/moderator/pages/api/admin/` | ~7 |
| **Total moved** | | **~85** |

The remaining ~50 admin API routes (system/cron/migration endpoints) stay in the main app. See [Admin Route Analysis](#admin-route-analysis).

### What Stays in `src/`

- `src/components/Moderation/ModerationNav.tsx` — imported by `AppHeader.tsx` in main app
- `src/components/Moderation/ImpersonateButton.tsx` — imported by `AppHeader.tsx` in main app
- `src/server/routers/moderator/` — registered in root router (conditionally excluded from web build)
- All other shared code (components, hooks, utils, server, store) — unchanged

### Merge Conflict Impact

**~85 files move** from `src/pages/` to `apps/moderator/pages/`. If another branch modifies one of these files, git shows "deleted in ours, modified in theirs." The fix is straightforward: move their modified version to the new location.

**In practice, the risk is low** because:

- Moderator pages are niche — few feature branches touch them
- The directories being moved are leaf-level (`moderator/`, `api/mod/`, `api/admin/`) — not shared infrastructure
- One-time migration, coordinated with the team

**Main app `src/` code**: zero import changes needed. The dependency flows one way (mod pages → shared src), so removing the pages doesn't break anything.

### Challenges

1. **Next.js cross-directory imports**: The moderator app needs to import from `../../src/`. Requires a webpack alias in `next.config.mjs` and `transpilePackages` config to handle the external source.

2. **`_app.tsx` duplication**: The moderator app needs its own `_app.tsx` with the same provider stack. This is a thin wrapper that imports providers from `../../src/providers/`.

3. **One edge case**: `src/utils/memberships.util.ts` imports a handler from `src/pages/api/admin/refresh-sessions`. This import needs to be refactored (extract the handler to `src/server/` and have both the API route and the util import from there).

### Build-Time Savings

- Main app compiles **~282 pages** instead of 367 (~23% fewer entry points)
- Moderator app compiles only **~90 pages** (mod pages + mod API routes + ~7 admin routes + shared essentials)
- With Turborepo, unchanged apps skip rebuilding entirely
- Local dev with `pnpm dev` only processes main app pages

---

## Approach B: Build-Time Page Exclusion (Simpler Alternative)

If the staged monorepo feels like too much change at once, this lighter approach keeps all code in place and uses build scripts to temporarily exclude pages.

```text
Same Git Repo (no structural changes)
├── build:web        → Docker image WITHOUT moderator pages
└── build:moderator  → Docker image WITH moderator pages (+ shared essentials)
```

### How It Works

1. **`build:web`** — A script moves `src/pages/moderator/` and `src/pages/api/mod/` to a temporary backup, replaces them with catch-all 404 pages, runs `next build`, then restores the originals. Sets `BUILD_TARGET=web` so the tRPC router conditionally excludes the `modRouter`.

2. **`build:moderator`** — Inverse: moves non-moderator pages out, keeps moderator pages + shared essentials (`_app.tsx`, `_document.tsx`, `api/auth/`, `api/trpc/`, `api/user/`), builds, restores.

3. **Merge conflict risk: effectively zero.** No files move permanently. Only new scripts and Dockerfiles are added.

4. **Downside**: No benefit during local dev. `pnpm dev` still loads all 367 pages. The file-move trick only works at build time because restoring files between dev sessions would be fragile.

### Build-Time Savings (Same as Approach A)

For `build:web`, removing 135 page entry points (37% of total) means:

- **Fewer webpack compilations** — each page is a separate entry point that webpack processes
- **Smaller server bundle** — less code to compile, optimize, and minify
- **Reduced tRPC type surface** — conditionally excluding the `modRouter` removes it from the `AppRouter` type

Note: 22+ other routers have individual `moderatorProcedure` endpoints scattered within them. These stay in both builds — the overhead is minimal and they already return FORBIDDEN for non-moderators.

---

## Comparison

| | Approach A: Staged Monorepo | Approach B: Build-Time Exclusion |
|---|---|---|
| **Build-time savings** | Yes (both production and dev) | Yes (production only) |
| **Local dev savings** | Yes (`pnpm dev` skips mod pages) | No (dev loads all pages) |
| **Merge conflict risk** | Low (~85 files move, but niche) | Effectively zero |
| **Structural clarity** | High (separate app, clean boundary) | Low (same codebase, script-based) |
| **Complexity** | Medium (workspace setup, webpack config) | Low (build scripts only) |
| **Upgrade path** | Already a monorepo — extend naturally | Needs migration later |
| **Turborepo caching** | Yes | No |

---

## Deployment Architecture (Both Approaches)

```text
                    ┌─────────────────┐
                    │  Load Balancer / │
                    │  Reverse Proxy   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              │              ▼
    ┌─────────────────┐      │    ┌─────────────────┐
    │   Web Container  │      │    │  Mod Container   │
    │                  │      │    │                  │
    │  All pages       │      │    │  /moderator/*    │
    │  EXCEPT          │      │    │  /api/mod/*      │
    │  /moderator/*    │      │    │  /api/admin (7)  │
    │  /api/mod/*      │      │    │  /api/auth/*     │
    │                  │      │    │  /api/trpc/*     │
    └────────┬────────┘      │    └────────┬────────┘
             │               │             │
             └───────────────┼─────────────┘
                             │
                    ┌────────┴────────┐
                    │   Shared Infra   │
                    │                  │
                    │  PostgreSQL      │
                    │  Redis           │
                    │  Meilisearch     │
                    │  ClickHouse      │
                    │  S3 / CloudFlare │
                    └─────────────────┘
```

Both containers share:

- **Database** — Same PostgreSQL instance, same Prisma schema
- **Auth** — Same `NEXTAUTH_SECRET`, same session cookies
- **Redis** — Same cache, same session store
- **Search** — Same Meilisearch instance

A user logged in on the main app is automatically authenticated on the moderator app (shared cookie domain).

### Routing Options

- **Path-based** (simpler): `civitai.com/moderator/*` → mod container, everything else → web container
- **Subdomain**: `mod.civitai.com` → mod container, `civitai.com` → web container

---

## What Stays in Both Builds

- **Auth**: Shared NextAuth session (both apps need it)
- **tRPC**: Moderator pages call shared tRPC endpoints (e.g., `trpc.image.moderate`), so most routers stay in both builds
- **Database**: Shared Prisma schema and tables
- **22+ routers with scattered `moderatorProcedure` endpoints** — the overhead is minimal and they return FORBIDDEN for non-moderators regardless

---

## Admin Route Analysis

Most `/api/admin/` routes are **not** moderator tools — they're webhook/cron endpoints for system operations. Here's the categorization:

### Move to Moderator App (~7 routes)

These are actual moderation actions called from moderator UI or used as mod tools:

| Route | Purpose |
|-------|---------|
| `delete-images` | Batch image removal for content moderation |
| `unpublish-all-models` | Mass unpublish models (ban consequence) |
| `rescan-images` | Trigger image rescanning for moderation |
| `cancel-subscription` | Cancel user subscriptions as mod action |
| `grant-subscription` | Grant memberships as mod action |
| `deliver-prepaid-buzz` | Complete prepaid buzz delivery |
| `manage-sanity-checks` | Manage sanity-check entries (already uses `ModEndpoint`) |

### Maybe Move (~3 routes)

| Route | Purpose | Notes |
|-------|---------|-------|
| `permission` | Grant/revoke feature permissions | Could be mod tool |
| `refresh-sessions` | Force session refresh | Useful for immediate permission effects |
| `users` | User lookup by IDs | Useful for mod context |

### Stay in Main App (~50 routes)

| Category | Examples |
|----------|---------|
| System/cron | `clean-up-old-notifications`, `creator-comp-payout`, `pay-daily-challenge-users` |
| Cache management | `clear-cache-by-pattern`, `fetch-cache-by-pattern`, `purge-cache-tag` |
| Data migrations | `migrate-likes`, `migrate-metrics`, `migrate-model-metrics` |
| Debug utilities | `cache-check`, `header-check`, `test` |
| External integrations | `update-freshdesk-customer`, `add-manual-assignments` |
| Generation system | `orchestrator/index`, `orchestrator/timings` |
| Temp/one-time scripts | `src/pages/api/admin/temp/` (~23 files) |

---

## Open Questions

@dev: Please review and comment on these:

1. **Which approach**: Staged monorepo (A) or build-time exclusion (B)?
2. **Deployment routing**: Path-based (`/moderator/*` → mod container) or subdomain (`mod.civitai.com`)?
3. **Moderator build scope**: Should the moderator app include _only_ mod/admin pages, or also include the full app (so moderators can use one URL for everything)?
4. **CI/CD**: Should both containers build on every push, or only when relevant files change?
5. **Feature flags in mod app**: Some moderator pages are feature-flagged. Should the mod app respect the same feature flag service?
