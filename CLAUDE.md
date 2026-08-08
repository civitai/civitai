# Civitai Development Guide

## How to work with us
We use markdown documents to discuss plans. Documentation goes in the `docs/` folder.

### Inline Comments
Comments from us are marked with `@dev:` and you can leave comments as well with `@ai:`.

## Tech Stack Overview

### Core Technologies
- **Framework**: Next.js 16 with TypeScript
- **UI Library**: Mantine v7
- **Styling**: Tailwind CSS + SCSS Modules
- **Database**: PostgreSQL with Prisma ORM
- **API**: tRPC
- **State Management**: Zustand
- **Authentication**: `@civitai/auth` — hub-driven `civ-token`. **NextAuth is fully removed**; `src/providers/SessionProvider.tsx` and `src/types/session.ts` are first-party replacements for `next-auth/react`. Remaining `next-auth` mentions in `src/` are comments about the cutover, not imports.
- **Search**: Meilisearch
- **Image Processing**: Sharp

### Monorepo Layout
This is a pnpm workspace, not just the Next.js app:
- `src/` — the main civitai.com app (everything below unless stated otherwise)
- `apps/` — sibling apps: `auth`, `creator-studio`, `event-engine`, `moderator`, `notifications`, `orchestrator-gateway`, `storage`. Each has its own `dev`/`release` script (`pnpm dev:auth`, `pnpm release:moderator`, …).
- `packages/civitai-*` — shared workspace packages consumed as `workspace:*` (`civitai-auth`, `civitai-db`, `civitai-db-schema`, `civitai-redis`, `civitai-ui`, `civitai-shared`, …).
- `event-engine-common/` — a git **submodule**. It doesn't come with a fresh worktree; see Git Worktrees below.

To add a new app, use the `scaffold-civitai-app` skill and follow `docs/packages/new-app-integration.md`.

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
pnpm run test:unit:run    # Vitest unit suite (the one you almost always want)
pnpm run test:component   # Vitest component suite (browser mode — see Git Worktrees for NixOS)
pnpm run test:lint-rules  # Convention guards (see below)
pnpm test                 # Playwright e2e
pnpm run test:ui          # Playwright with UI
```

Both vitest suites are projects in `vitest.config.mts` (`--project unit` / `--project component`).

#### Never put unit tests under `src/pages`
Next.js 16 treats **every** `.ts`/`.tsx` file under `src/pages` (incl. nested `__tests__/`) as a route, and `next build` runs a route-type validator over it. A Vitest test file there fails the build with `Type '...test' does not satisfy the constraint 'ApiRouteConfig'. Property 'default' is missing` — and **only `next build` catches it**: `pnpm typecheck`, `pnpm test`/vitest, and the CI typecheck/unit/component tasks all pass, so it sneaks through to the preview `build-image` step. Keep handler tests in a `__tests__/` dir **outside** `src/pages` (e.g. `src/server/__tests__/`) and import the handler via the `~/pages/...` alias. (Bit us on PR #2653.)

#### Prefer `importOriginal` over hand-listed `vi.mock` exports
A `vi.mock` that lists exports by hand couples the test to the **entire transitive import graph** of the thing under test, and nothing warns you when that graph grows. Adding one service import can drag in a module that builds `pLimit`/prom collectors at load (e.g. `~/server/search-index` → `meilisearch/client`), and the suite then fails to load with an error far from the change — `pnpm typecheck` and `pnpm lint` stay green, so **only CI catches it**. Spread the real module and override only what you need:
```ts
vi.mock('~/server/prom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof PromClient>()),
  dbReadFallbackCounter: { inc: vi.fn() },
}));
```
Use a top-level `import type * as PromClient` — an inline `typeof import('...')` trips `consistent-type-imports`.

**Before widening a mock, check whether the import edge is needed at all.** A failing suite may be telling you the code pulled in a dependency it doesn't want, not that the mock is too narrow, and widening it would hide that. (Bit us twice in one day, Aug 2026, on two branches; one of those three suites was fixed by extracting the helpers into their own module instead.)

#### Convention guards run as tests
Several repo conventions are enforced by tests, not by eslint — `pnpm run test:lint-rules` runs all of them:
`no-wholesale-module-mock` (the `importOriginal` rule above), `no-io-in-transaction`, `no-module-scope-cache`, `no-unloadable-image-fixture`. They live in `src/server/services/__tests__/`. If one fails, fix the code — don't add an exemption without saying why.

#### A passing test says nothing about how it FAILS — check the revert
**"The tests would catch a regression here" is a claim about the failure mode, not about coverage.** A green
suite proves current behaviour. Whether a revert is *legible* is a separate property, and it is the one that
decides if the test protects anything. Review your own tests by asking what a reverted fix would look like:
an assertion message, a timeout, or nothing at all.

🔴 **Proving a property by absence of termination is not proof — a test runner cannot observe it.** A fake
that drives a loop and never terminates turns a regression into an infinite loop of `await`-on-already-resolved
promises. That is a pure **microtask** loop: it starves the macrotask queue, and vitest's `testTimeout` is
`setTimeout`-based, so **it never fires**. Measured: 4,194,305 iterations in 4 s with a 300 ms `setTimeout`
that never ran. CI hangs until the job is killed — no assertion failure, no timeout, nothing to read.

So **any fake driving a bounded loop must terminate on its own**, and the test must assert the loop stopped
early. Capping a cursor fake at 50 pages turns an unreportable hang into `expected 51 to be less than 5` in
under a second. Same rule as sizing a slow-path regression test so a revert *fails fast* rather than wedging
the runner — see the `n = 10_000` cap in `session-invalidation.test.ts` and the terminating pages beside it.

Two things this does NOT cover, stated so a green run isn't over-read: the paging guard in
`test:lint-rules` catches cursor-shaped fakes only, so it reduces this class rather than closing it; and a
loop driven by something other than a cursor is still on you to bound.

(The formulation above is @ivy's, from reviewing PR #3756 — where the assertions were all correct and the
failure mode was a hang. Both reviewers checked the assertions; neither asked what a revert would print.)

#### Never `await` a browser-test state that DELETES ITSELF
`expect.element` polls — first attempt immediate, then every **50 ms** — against the test's remaining budget (browser-mode `testTimeout` defaults to **15 s**, and the `component` project does not override it). Awaiting a state to **arrive** is safe: load only makes it arrive later and the matcher keeps polling. Awaiting a state that will **leave** — a spinner on a ceiling, a debounce window, anything a component tears down on a timer — is a race the matcher cannot win: once the state is gone it never comes back, so every remaining poll is also too late. Such a test is green on a quiet box, red on a busy one, and has no PR to blame.

Fix it structurally, in this order:
1. **Make the state absorbing** — drive the component so nothing can take the state away (e.g. `rerender` with a window so large the timer can never fire), *then* assert it. Add a negative control proving the prop change alone did not produce the state.
2. **Don't assert the transient at all** — await the absorbing end-state, and pin that the intermediate step happened via a non-DOM observable (a mock call count).

🔴 Do **not** widen the matcher budget, add a `retry`, or enlarge the component's own timeout instead. Those convert a fast failure into a slow one and leave the race unwinnable whenever the machine is slow enough — which is exactly when CI runs.

⚠️ **A ~15 s failing test is a candidate filter, NOT a diagnosis.** It means only that some `expect.element` was never satisfied: four *non-race* mutations all failed at 14.97–15.09 s, and two **healthy, passing** tests legitimately run 15.06 s / 15.26 s waiting out a real 15 s product timeout. To tell a self-deleting state from one that never arrived, read the observable **synchronously right after the action** (present-then-gone vs never-present), or **enlarge the component's own window** and see whether the failure disappears — diagnostic only, since shipping that widening is what this rule forbids.

Worked examples of both fixes: the two retry tests in `src/components/Apps/AppsSubmitEditView.browser.test.tsx`. Measurements behind every number above: `claudedocs/rca-appblocks-component-suite-flake-2026-08-05.md` (PR #3645).

### Database
```bash
pnpm run db:migrate:empty    # Create an empty migration file
pnpm run db:generate         # Regenerate the slim schema + Prisma client
pnpm run db:check-generated  # Fail if the committed generated client is stale
```

**`schema.full.prisma` is the only schema you edit.** `packages/civitai-db-schema/prisma/schema.full.prisma` is the single tracked schema. `pnpm run db:generate` runs `scripts/generate-slim-schema.js`, which strips `@no-type` models/enums to produce `packages/civitai-db-schema/prisma/schema.prisma` (what `package.json`'s `prisma.schema` points at), then runs `prisma generate`. Both `schema.prisma` files — that one **and** the leftover `prisma/schema.prisma` at the repo root — are gitignored build artifacts; editing either is silently overwritten on the next generate. `pnpm run db:check-generated` regenerates and diffs `packages/civitai-db-schema/src`, so a forgotten regen fails there.

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

## Server-Side Architecture Map

`src/server/` holds the most-edited (and largest) code in the repo. Read the *specific* file before changing it — several are huge, so grep within them rather than reading end-to-end (`services/image.service.ts` is 8K+ lines).

- **tRPC API** — `trpc.ts` (root router + procedure helpers), `createContext.ts`, `middleware.trpc.ts`, `routers/` (~100 per-domain routers), `controllers/`, `schema/` (zod input contracts), `selectors/` (Prisma `select` fragments).
- **Images** — `services/image.service.ts` (**8K+ lines**; the hot feed path — `getInfiniteImages`, `getAllImages`, NSFW/own-content merge). API surface `src/pages/api/v1/images/index.ts`; index sync `search-index/images.search-index.ts`.
- **Models** — `services/model.service.ts`, `search-index/models.search-index.ts`.
- **Search (Meilisearch)** — `meilisearch/client.ts` (tags requests with `X-Search-Actor`), `meilisearch/cleanup.ts`, `search-index/base.search-index.ts` (shared sync engine).
- **Redis / caching** — `redis/client.ts` (clients incl. sysRedis), `redis/caches.ts` (`createCachedObject` defs + TTLs, e.g. `imageMetaCache`, `tagIdsForImagesCache`), `utils/cache-helpers.ts`.
- **Orchestrator (generation)** — `orchestrator/get-orchestrator-token.ts` (`getOrchestratorToken`), `services/orchestrator/orchestrator.service.ts`.
- **Auth** — `auth/get-server-auth-session.ts`, `auth/session-verifier.ts` + `auth/session-cache.ts` + `auth/session-invalidation.ts`, `auth/token-claims.ts`, `auth/civ-cookie.ts`, `auth/oauth-bridge.ts`, `auth/route-guard.ts`, `auth/bearer-token.ts`. Shared logic lives in `packages/civitai-auth`; the hub itself is `apps/auth`.
- **Jobs (cron)** — `jobs/job.ts` (runner) + individual jobs `jobs/*.ts` (e.g. `entity-moderation.ts`, `search-index-sync.ts`).
- **Metrics / analytics** — `metrics/*.metrics.ts` (ClickHouse-backed entity metrics), `clickhouse/`.
- **DB** — `db/db-helpers.ts` (raw pg-pool config: `connectionTimeoutMillis`, labeled pool gauges), Prisma client. **Schema is `packages/civitai-db-schema/prisma/schema.full.prisma`, and migrations are applied manually — see the Database rule above.**
- **Telemetry** — `src/instrumentation.node.ts` (OTEL: Prisma/Redis/HTTP auto-instrumentation + custom `withSpan()` from `utils/otel-helpers.ts`), `schema/track.schema.ts` (ClickHouse action/event tags), `prom/client.ts`.
- **Health** — `src/pages/api/health.ts` runs sub-checks concurrently, each raced at `HEALTHCHECK_TIMEOUT` and the whole set raced against an overall deadline, reporting partial results as checks settle. Checks can be suppressed or demoted to non-critical via the `HEALTHCHECK_DISABLED` env var and the Redis-backed `DISABLED_HEALTHCHECKS` / `NON_CRITICAL_HEALTHCHECKS` keys.
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

**Explain decisions in your response, not in the file.** Rationale for a choice you just made — why you picked this shape, what you deliberately left out, what you considered and rejected — belongs in your reply to us, where we're already reading it. A comment justifying your work to a reviewer is the single most common way this section gets violated. If you catch yourself writing something you'd also say in chat, say it in chat only.

**Comment in a separate pass.** Write the code first with no comments, then reread it and add back only what's needed. Comments written while authoring never get evaluated — the reasoning is fresh, so it feels non-obvious when it isn't. Judge them against code you're reading, not code you're writing.

**The keep test.** For every comment that survives, you should be able to name the specific future edit that goes wrong without it. If the answer is "it's helpful context" or "it explains why this is correct," delete it. Being unable to name the failure means the code already says it — or should.

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

### Git Worktrees
When you create a new worktree (`git worktree add …`), **always initialize the `event-engine-common` submodule
in it**: `git submodule sync --recursive && git submodule update --init event-engine-common`.
Worktrees don't check out submodules automatically,
and without it `pnpm typecheck`/`build` fail with a wall of `Cannot find module '.../event-engine-common/...'`
errors (and the missing types cascade into unrelated `implicitly has an 'any' type` errors) — noise that looks
like your change broke something when it didn't.

**The worse consequence is a suite that doesn't fail — it vanishes.** Without the submodule,
`src/server/routers/__tests__/blocks.router.workflow.test.ts` fails to **collect** and contributes **0 tests**.
It doesn't report red, it reports nothing, and a run that collected nothing still finishes in a way that reads
as a pass to anyone checking an exit code or skimming a summary. **Validate any worktree test run by confirming
that file collected a nonzero count** — it was 308 tests on one base. If it reports 0, the run tells you nothing
about your change, whatever the summary says.

**A fresh worktree also has no `.envrc`.** It's gitignored, so it never comes with the checkout, and you silently
get system Node instead of the flake's pinned version. Measured: system Node **26.5.0** against the flake's
**22.22.2** produced 7 spurious `window.localStorage is undefined` failures under happy-dom plus 8 Prisma
`linux-nixos` engine errors — every one a false red that got attributed to the code under test. Create a minimal
`.envrc` containing `use flake` and `direnv allow` it. **Then confirm your cwd is actually the worktree**: one run
whose cwd was set to a different repo lost two suites to collection failures and **77 tests silently never ran**
(10849 → 10772) while the output otherwise looked entirely normal.

**Browser/component tests on NixOS: the host's browser bundle must match this repo's playwright pin — fix the
host, not `package.json`.**
The failure is *not* "no `chromium` on `PATH`" — a NixOS host that sets `PLAYWRIGHT_BROWSERS_PATH` (nixpkgs
`playwright-driver.browsers`) already has Chromium. Playwright pins **one exact Chromium build per release** and
looks it up by revision under that path, so a driver/bundle mismatch fails with
`browserType.launch: Executable doesn't exist at .../chromium_headless_shell-<rev>/...` — and the whole
`component` project then reports **`Test Files (130)` / `Tests no tests`**, i.e. 0 of 130 executed. That reads
like a broken suite, not a missing browser.

**The repo pin is `^1.57.0` and stays there — adapt the host to it.** `playwright` / `@playwright/test` resolve
to **1.57.0**, which wants Chromium revision **1200**. Before running, check the two numbers that have to be
equal: `node_modules/playwright/../playwright-core/browsers.json` (the revision playwright will look for) against
`ls $PLAYWRIGHT_BROWSERS_PATH` (the revisions the bundle actually has). If they differ, point
`PLAYWRIGHT_BROWSERS_PATH` at a `playwright-driver` bundle of the *matching* version instead of bumping the repo.
Nixpkgs carries exactly one playwright version per revision, so a host that drives several repos on different
playwright lines needs one pinned nixpkgs input per line and a per-project selector — the version skew is a
property of the host, not of this repo.

**Do not "fix" this by bumping the pin — the bump is not self-contained.** It was tried and reverted. CI runs
some Playwright jobs in **version-matched container images that ship their own browsers** (`PLAYWRIGHT_BROWSERS_PATH`
pointing inside the image) while executing the *workspace-local* `./node_modules/.bin/playwright`. Bumping this
repo alone desynchronises that pair and reproduces the same bug in CI: the preview smoke suite went **2 passed /
59 failed**, and every one of the 59 was `browserType.launch: Executable doesn't exist at
/ms-playwright/chromium_headless_shell-1228/...` — 177 occurrences (59 × 3 retries) and **zero** assertion or
timeout failures. Not one spec executed. So a bump needs a lockstep image-tag change owned by someone else, in
the same window, in both directions. Adapting the host costs one person nothing and no one else anything.

A caret range is also not a pin for a package with a 1:1 browser mapping: `^1.57.0` floating within the 1.57
line is fine (the Chromium build is stable across a minor line), but bumping the *minor* changes the revision.

Escape hatch if your host's bundle can't match the pin: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=<abs path to a
chrome/chrome-headless-shell binary>` — honoured by `vitest.config.mts`'s provider, and it bypasses the revision
lookup entirely. Before blaming any of this: **a stale `node_modules/.vite` cache — typical after a `kill -9` —
hangs for minutes at near-zero CPU. Clear it first.**

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
- Serve images through `EdgeImage`/`EdgeMedia`, not `next/image` — see Image Handling

### Security

**This repository is PUBLIC and permanently world-readable — including `docs/`, `claudedocs/`, `.claude/skills/`, and every commit in history. Write all of it for strangers.**

- Never commit secrets or API keys. Use environment variables; keep `.env.example` values placeholder-only.
- Sanitize user input with sanitize-html.
- Follow authentication best practices.

#### Do not commit these — they belong in the private infra repo

1. **Unfixed vulnerabilities.** No security review, audit, threat model, or handoff that lists an OPEN finding — especially not with `file:line`. A findings list is a to-do list for an attacker.
2. **Content-safety internals.** Classifier policy text, thresholds, trigger or carve-out term lists, per-label false-positive rates, documented blind spots. Describing the *architecture* is fine; publishing the *decision rules* is an evasion guide.
3. **Paths to production.** Bastion hosts, SSH forwards, kubectl contexts, namespaces, deployment names, port-forwards, connection recipes, canary rollback thresholds. Write "ask an infra owner for the connection recipe" instead.
4. **Private-repo contents.** Names and internal paths of the infra/GitOps/orchestrator/flag-state repos, especially any secret file path.
5. **Auth posture of internal services.** Never write down that a service has weak or no authentication, or which single header or secret is the only control in front of it.
6. **People and customers.** Staff names tied to owned systems, internal ticket IDs, private DM or ticket contents, and any named user's earnings, moderation status, or content classification.
7. **Bulk production data.** Arrays of real user IDs, emails, or account attributes — including inside one-shot `admin/temp` backfill scripts. Load them from a file at runtime; don't inline them.
8. **Secret inventories annotated with what they unlock.** Variable names alone are fine; "this one is the salt for every API key" is not.

#### Before committing a doc

Ask: *if a stranger read only this file, what could they do that they couldn't before?* If the answer is anything other than "understand the product or contribute code," it goes in the private repo. Write the architecture publicly and the operational specifics privately.

A useful tell: if you are documenting **why** a guard exists and **what it stops**, you are one sentence away from naming the bypass. Say what the control does, not what defeats it.

**Removal is not remediation.** Git history is public and permanent. Anything already committed must be treated as disclosed — fixed and rotated on that assumption, not merely deleted.

### Before Committing
1. Run type checking: `pnpm run typecheck`
2. Run linting: `pnpm run lint`
3. Format code: `pnpm run prettier:write`
4. Run the unit suite: `pnpm run test:unit:run`
5. If you touched `schema.full.prisma`: `pnpm run db:check-generated`
6. Test changes locally

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
- Register dialogs in `src/components/Dialog/dialog-registry2.ts` (URL-routed ones in `routed-dialog-registry.ts`)
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

Feature-specific documentation lives in `docs/features/`. Before implementing a feature, check if documentation exists.

Operational runbooks, security reviews, incident handoffs, and content-policy records do **not** live in `docs/` — this repo is public. See the Security section above.

### Core Systems Reference
| System | Documentation |
|--------|--------------|
| Image Resources | [docs/features/image-resources.md](docs/features/image-resources.md) |
| NSFW Filtering | [docs/features/nsfw-filtering.md](docs/features/nsfw-filtering.md) |
| Buzz Accounts | [docs/features/buzz-accounts.md](docs/features/buzz-accounts.md) |
| Monetization rules (paid access / fees / donation goals) | [docs/features/monetization-rules.md](docs/features/monetization-rules.md) |
| Notifications | [docs/features/notifications.md](docs/features/notifications.md) |
| Metrics/Analytics | [docs/features/entity-metrics.md](docs/features/entity-metrics.md) |
| Bitwise Flags | [docs/features/bitwise-flags.md](docs/features/bitwise-flags.md) |
| Civitai LLM Client | [docs/features/civitai-llm-client.md](docs/features/civitai-llm-client.md) |
| Challenge Platform | [docs/features/challenge-platform.md](docs/features/challenge-platform.md) |

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

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
