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

## Shell env (agent shells)
Non-interactive `zsh -c` doesn't persist state between calls, so don't re-`cd`/`export` each time — devrc's `.zshenv` pre-exports absolute, existence-guarded handles. Use them directly: `$CIVITAI` (this repo), `$DATAPACKET` (the k8s/deploy manifests repo), `$KC_DPPROD` (the dp-prod kubeconfig) — e.g. `git -C $DATAPACKET …`, `KUBECONFIG=$KC_DPPROD kubectl …`. There is no default `KUBECONFIG` — pick a cluster per command so a bare `kubectl` can't hit prod.

## Tech Stack Overview

### Core Technologies
- **Framework**: Next.js 14 with TypeScript
- **UI Library**: Mantine v7
- **Styling**: Tailwind CSS + SCSS Modules
- **Database**: PostgreSQL with Prisma ORM
- **API**: tRPC
- **State Management**: Zustand
- **Authentication**: NextAuth
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
pnpm run typecheck        # Run TypeScript type checking
pnpm run lint             # Run ESLint
pnpm run prettier:check   # Check Prettier formatting
pnpm run prettier:write   # Auto-fix Prettier formatting
```

### Testing
```bash
pnpm test                 # Run Playwright tests
pnpm run test:ui          # Run tests with UI
```

#### Never put unit tests under `src/pages`
Next.js 16 treats **every** `.ts`/`.tsx` file under `src/pages` (incl. nested `__tests__/`) as a route, and `next build` runs a route-type validator over it. A Vitest test file there fails the build with `Type '...test' does not satisfy the constraint 'ApiRouteConfig'. Property 'default' is missing` — and **only `next build` catches it**: `pnpm typecheck`, `pnpm test`/vitest, and the CI typecheck/unit/component tasks all pass, so it sneaks through to the preview `build-image` step. Keep handler tests in a `__tests__/` dir **outside** `src/pages` (e.g. `src/server/__tests__/`) and import the handler via the `~/pages/...` alias. (Bit us on PR #2653.)

### Database
```bash
pnpm run db:migrate:empty  # Create an empty migration file
```

**CRITICAL: We do NOT use `prisma migrate deploy`. Migrations are applied manually.**
- Migration files in `prisma/migrations/` exist for review/history but are never auto-run
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

## Server-Side Architecture Map

`src/server/` holds the most-edited (and largest) code in the repo. Read the *specific* file before changing it — several are huge, so grep within them rather than reading end-to-end (`services/image.service.ts` is ~7.9K lines).

- **tRPC API** — `trpc.ts` (root router + procedure helpers), `createContext.ts`, `middleware.trpc.ts`, `routers/` (~93 per-domain routers), `controllers/`, `schema/` (zod input contracts), `selectors/` (Prisma `select` fragments).
- **Images** — `services/image.service.ts` (**~7.9K lines**; the hot feed path — `getInfiniteImages`, `getAllImages`, NSFW/own-content merge). API surface `src/pages/api/v1/images/index.ts`; index sync `search-index/images.search-index.ts`.
- **Models** — `services/model.service.ts`, `search-index/models.search-index.ts`.
- **Search (Meilisearch)** — `meilisearch/client.ts` (tags requests with `X-Search-Actor`), `meilisearch/cleanup.ts`, `search-index/base.search-index.ts` (shared sync engine).
- **Redis / caching** — `redis/client.ts` (clients incl. sysRedis), `redis/caches.ts` (`createCachedObject` defs + TTLs, e.g. `imageMetaCache`, `tagIdsForImagesCache`), `utils/cache-helpers.ts`.
- **Orchestrator (generation)** — `orchestrator/get-orchestrator-token.ts` (`getOrchestratorToken`), `services/orchestrator/orchestrator.service.ts`.
- **Auth** — `auth/next-auth-options.ts`, `auth/session-user.ts`, `auth/token-refresh.ts`.
- **Jobs (cron)** — `jobs/job.ts` (runner) + individual jobs `jobs/*.ts` (e.g. `entity-moderation.ts`, `search-index-sync.ts`).
- **Metrics / analytics** — `metrics/*.metrics.ts` (ClickHouse-backed entity metrics), `clickhouse/`.
- **DB** — `db/db-helpers.ts` (raw pg-pool config: `connectionTimeoutMillis`, labeled pool gauges), Prisma client; schema `prisma/schema.prisma`. **Migrations are applied manually — see the Database rule above.**
- **Telemetry** — `src/instrumentation.node.ts` (OTEL: Prisma/Redis/HTTP auto-instrumentation + custom `withSpan()` from `utils/otel-helpers.ts`), `schema/track.schema.ts` (ClickHouse action/event tags), `prom/client.ts`.
- **Health** — `src/pages/api/health.ts` runs sub-checks under `Promise.all`; a single slow check (e.g. `searchMetrics`) can exceed the kubelet probe budget. `HEALTHCHECK_TIMEOUT` env gates it.
- **Other server domains** — `games/` (new-order/ratings), `webhooks/`, `paddle/` + `coinbase/` (payments), `notifications/`, `signals/`, `rewards/`; S3 helpers at `src/utils/s3-utils.ts`.

## Component Standards

### File Structure
```
src/
├── components/          # React components
│   ├── ComponentName/   # Component folder
│   │   ├── ComponentName.tsx
│   │   ├── ComponentName.module.scss  # Optional SCSS module
│   │   └── utils.ts     # Component utilities
├── hooks/              # Custom React hooks
├── server/             # Server-side code
├── utils/              # Shared utilities
└── store/              # Zustand stores
```

### Component Patterns

#### 1. Mantine Components
```tsx
import { Button, Group, Text } from '@mantine/core';
import { IconBolt } from '@tabler/icons-react';
```

#### 2. Tailwind Classes with clsx
```tsx
import clsx from 'clsx';

<div className={clsx('flex items-center gap-2', conditionalClass && 'bg-blue-500')} />
```

#### 3. SCSS Modules (when needed)
```tsx
import styles from './Component.module.scss';

<div className={styles.container} />
```

#### 4. TypeScript Patterns
- Use type imports when possible: `import type { ButtonProps } from '@mantine/core'`
- Define Props interfaces for components
- Use enums from `~/shared/utils/prisma/enums`

### Coding Standards

#### Imports Order
1. External libraries (React, Mantine, etc.)
2. Internal components (~/components/...)
3. Hooks (~/hooks/...)
4. Server/API code (~/server/...)
5. Utils and helpers (~/utils/...)
6. Types and enums
7. Styles

#### State Management
- Use Zustand for global state
- Use React Query for server state
- Use React Hook Form for forms

#### API Calls
```tsx
import { trpc } from '~/utils/trpc';

const { data, isLoading } = trpc.user.getProfile.useQuery();
```

#### Authentication
```tsx
import { useCurrentUser } from '~/hooks/useCurrentUser';

const currentUser = useCurrentUser();
```

#### Comments

Comments are not type-checked, so they rot silently and become misleading. Write the minimum comment needed and bias toward none.

- Default to no comment. If the code is clear on its own, leave it alone. Prefer a clearer name, smaller method, or better type over a comment that explains confusing code.
- Only comment the non-obvious why: a rationale, tradeoff, gotcha, invariant, or workaround that the reader cannot recover from the code itself. Link an issue/PR when relevant.
- Never narrate the what. No comments that restate the next line, label obvious steps (`// loop over items`), or describe what a well-named symbol already says.
- Don't describe nearby code's current behavior (e.g. "this gates on X so Y happens"). That is exactly what goes stale when the other code changes. Comment the surprising fact, not the mechanics.
- No process/banner noise: no change-log narration (`// added to fix...`), no "I changed X", no section-divider banners, no commented-out code.
- When you do comment, keep it to a line or two. A long block almost always means the code or naming should be clearer instead.

**Clean up as you go.** When you edit code that already has stale, redundant, or what-narrating comments, delete or fix them — don't preserve them just because they were there. The repo already has many such comments (a lot of them mine); treat touching nearby code as license to remove the noise, but keep edits scoped to what you're already working on rather than going on a separate comment-cleanup sweep.

## Environment Setup

### Required Environment Variables
- Database connection strings
- Authentication providers
- S3/CloudFlare credentials
- Payment provider keys
- Search service endpoints

### Local Development
1. Install dependencies: `pnpm install`
2. Generate Prisma client: `pnpm run db:generate`
3. Start dev server: Use `/dev-server` skill

## Important Notes

- Read the full file before editing. Plan all changes, then make ONE complete edit. If you've edited a file 3+ times, stop and re-read the user's requirements.
- When the user corrects you, stop and re-read their message. Quote back what they asked for and confirm before proceeding.
- Every few turns, re-read the original request to make sure you haven't drifted from the goal.
- Act sooner. Don't read more than 3-5 files before making a change. Get a basic understanding, make the change, then iterate.
- When stuck, summarize what you've tried and ask the user for guidance instead of retrying the same approach.
- Re-read the user's last message before responding. Follow through on every instruction completely.
- After 2 consecutive tool failures, stop and change your approach entirely. Explain what failed and try a different strategy.

### Performance
- Use dynamic imports for heavy components
- Implement virtual scrolling for large lists
- Optimize images with Next.js Image component

### Security
- Never commit secrets or API keys
- Use environment variables
- Sanitize user input with sanitize-html
- Follow authentication best practices

### Before Committing
1. Run type checking: `pnpm run typecheck`
2. Run linting: `pnpm run lint`
3. Format code: `pnpm run prettier:write`
4. Test changes locally

### Stacked PRs — don't
- **NEVER use stacked PRs** — base every PR directly on the integration branch (`main`, or a feature integration branch like `feat/...`), never on another open PR's branch. Stacked PRs silently mis-merge: a squash-merged parent doesn't retarget the child, so the child lands on the orphaned parent branch instead of the real base and its changes go missing.
- If a change depends on an unmerged PR, **wait for that PR to merge, then branch off the updated base** — or fold both changes into a single PR.
- (Bit us 2026-06-13: PR #2520's App Blocks W11 F5 was stacked on #2518 (F6) → #2520 squash-merged into the #2518 branch instead of `feat/app-blocks-main-v1`; corrected via #2525.)

## Common Patterns

### Infinite Scroll
Use MasonryGrid or virtual scrolling components with React Query infinite queries.

### Modals
Use Mantine modals with proper accessibility and keyboard handling.

#### Dialog Registry System
The project uses a dialog-registry system for managing modals:
- Register dialogs in `src/components/Dialog/dialog-registry.ts` or `dialog-registry2.ts`
- Use `DialogProvider` for context-based modal management
- `RoutedDialogProvider` for URL-based modal state
- Access dialogs through the registry for consistent modal handling across the app

### Forms
Use React Hook Form with Zod schemas for validation.

### File Uploads
Use the S3 upload hooks and providers in the codebase.

### Image Handling
Use EdgeImage component for optimized image loading with CDN support.

## Debug Endpoints (`src/pages/api/testing/*`)

`src/pages/api/testing/*.ts` is the convention for hidden debug endpoints. Each endpoint is guarded by `WEBHOOK_TOKEN` (via `WebhookEndpoint(...)`, which checks the `?token=` query param) and exposes a handful of POST actions for experimenting with a feature without paying real money or hand-editing the DB.

**To use one**: read the endpoint's source file directly — the top-of-file comment documents the available actions and required params, and the zod schema is the authoritative contract. Agents should never need a wrapper skill; cURL with `?token=$WEBHOOK_TOKEN` appended to the URL is enough.

**When adding a new debug endpoint**:
1. Drop it at `src/pages/api/testing/<feature>.ts`
2. Use `WebhookEndpoint(handler)` for auth
3. Lead the file with a block comment listing each action + its params + a one-line description (see `src/pages/api/testing/referrals.ts` for the pattern)
4. Scope every destructive action to a single `userId`/`refereeId` per call so a misuse can't cascade

## Feature Documentation

Feature-specific documentation lives in `docs/features/`. Before implementing a feature, check if documentation exists:

### Core Systems Reference
| System | Documentation |
|--------|--------------|
| Image Resources | [docs/features/image-resources.md](docs/features/image-resources.md) |
| NSFW Filtering | [docs/features/nsfw-filtering.md](docs/features/nsfw-filtering.md) |
| Buzz Accounts | [docs/features/buzz-accounts.md](docs/features/buzz-accounts.md) |
| Notifications | [docs/features/notifications.md](docs/features/notifications.md) |
| Metrics/Analytics | [docs/features/metrics-analytics.md](docs/features/metrics-analytics.md) |
| Bitwise Flags | [docs/features/bitwise-flags.md](docs/features/bitwise-flags.md) |
| Civitai LLM Client | [docs/features/civitai-llm-client.md](docs/features/civitai-llm-client.md) |

## Troubleshooting

### Memory Issues
Use cross-env NODE_OPTIONS with increased memory:
```bash
pnpm run dev-debug  # Includes --max_old_space_size=8192
```

### Build Failures
1. Clear .next folder
2. Clear node_modules and reinstall
3. Check for circular dependencies
4. Ensure all environment variables are set

### Database Issues
1. Check connection string
2. Apply pending migrations manually (we do NOT use `prisma migrate deploy` — see Database section above)
3. Regenerate client: `pnpm run db:generate`
