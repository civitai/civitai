# Civitai Development Guide

## How to work with us
We use markdown documents to discuss plans. Documentation goes in the `docs/` folder.

### Inline Comments
Comments from us are marked with `@dev:` and you can leave comments as well with `@ai:`.

### Filing follow-up work
🔴 **Never open an issue or ticket you cannot state a CLOSING CONDITION for.** Name what ends it **and** who or what checks it — either a mechanical check (a merged PR, a passing command, a metric back under threshold) **or** a named human judgement over named evidence ("X reviews the diff" — never "someone will decide"). If you can name neither, it is **not a work item**: say so in your reply, with why, instead of opening something nobody can close.

Why: a complete sweep of this org's open GitHub objects found that agent-filed **issues** survive dramatically longer than pull requests. The PRs close; the follow-up issues they spawn do not. Duplication turned out **not** to be the problem — closability was. The dominant pattern is *"merge a PR, then file follow-ups"*, and a follow-up filed at merge time is precisely the object born with no closing condition and no owner. Most such issues were also opened with no labels and no comments, so nothing downstream could triage them either.

**If you are an automated producer** — a bot, a scheduled job, or an agent that opens issues — also label what you create `agent/<producer>` and put a machine-readable marker in the body naming the producer and the closing condition, so the object can be reconciled and closed later instead of accumulating. Apply the label on **create only**; never let an update overwrite labels a human has set.

🔴 **Nothing enforces this.** There is no gate, no hook, and no CI check — it binds only the agents and people who read this file. If you are adding a new issue-creating producer, stamp it at the create site, because nothing will catch you if you don't.

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

## Build Commands

### Development
**Always use the `/dev-server` skill** to manage dev servers. Never use `pnpm run dev` directly.
That covers `moderator` and `creator-studio` too — `cli.mjs start --app <name>` runs them from the
worktree you are in, on a port the daemon reserves, with the auth hub started for you. The other
`apps/*` have no dev-server integration; use their own `pnpm dev:<name>`.

### Code Quality
```bash
pnpm run typecheck        # Run TypeScript type checking
pnpm run lint             # Run ESLint
pnpm run prettier:check   # Check Prettier formatting
pnpm run prettier:write   # Auto-fix Prettier formatting
```

#### SvelteKit apps have their own standard

`apps/moderator`, `apps/auth` and `apps/creator-studio` are SvelteKit 5 + Kysely + shadcn-svelte +
Tailwind v4 — none of the Mantine/tRPC/Prisma guidance above applies to them. Their shared conventions
live in **[`docs/svelte-app-standard.md`](docs/svelte-app-standard.md)**, and each app's `CLAUDE.md`
records only its deltas. Review a segment there with `svelte-correctness-review`,
`svelte-idiom-review` and `svelte-abstraction-review`.

#### In SvelteKit apps: use `typecheck`, never `check`

🔴 They are **not** synonyms. `check` prefixes `svelte-check` with `svelte-kit sync`, which regenerates ~690
files under `.svelte-kit/` while the Vite dev server is watching it — that collision froze an entire day
(2026-08-07). Reach for `check` **only** after changing the route tree; symptom is `Cannot find module
'./$types'` or props resolving to `never`. `build` runs `sync` too and catches nothing `svelte-check` doesn't.
**Read `svelte-check`'s WARNING lines, not just ERROR** — `state_referenced_locally` (a `$state` capturing only
the first value, so the UI silently shows stale data) appears there and nowhere else in the loop.

#### Never run `npx prettier --plugin=prettier-plugin-svelte` on `.svelte` files

🔴 It **empties every file it touches to zero bytes** and reports success on each one — 28 components in one
command (2026-08-07). The first symptom is `svelte-check` reporting props as `never`, which reads like stale
`$types` and sends you diagnosing the wrong thing. Note no root command formats `.svelte` at all (root Prettier
is 2.8.8, globs `.ts`/`.tsx`); `apps/creator-studio` formats itself, the other two are hand-formatted.

#### Prettier runs on UNCOMMITTED files only — never the whole repo

`prettier:write`/`prettier:check` are `scripts/prettier-changed.mjs`, which formats git-dirty files and nothing
else. 🔴 Do not widen them back to a `**/*` glob, and do not reach for a repo-wide `npx prettier --write`: the
repo is not Prettier-clean (789 of 4,116 `src` files) so that is a ~1,000-file commit that buries the actual
change **and rewrites other people's uncommitted work in place** (2026-08-08: one run produced 1,085 modified
files). CI scopes itself the same way and gates only on **added** files.

### Testing
```bash
pnpm run test:unit:run     # Vitest unit suite over src/ + scripts/ (the one you almost always want)
pnpm run test:packages:run # Vitest, the packages/* suites
pnpm run test:apps:run     # Vitest, the apps/* suites
pnpm run test:component    # Vitest component suite (browser mode — see Git Worktrees for NixOS)
pnpm run test:lint-rules   # Convention guards (see below)
pnpm test                  # Playwright e2e
pnpm run test:ui           # Playwright with UI
```

These are **separate suites over disjoint directories**, not layers of one — `test:unit:run` does not
run a single test under `packages/` or `apps/`, because the `unit` project's `include` is root-relative.
Which of them CI runs, and which of those can actually fail a check, differs per suite: see the job
comments in `.github/workflows/lint.yml`. `main` has no required status checks, so no suite blocks a
merge; the strongest a red one gets is rendering red for a human to notice, and a job marked
`continue-on-error` does not even do that.

The vitest suites are projects in `vitest.config.mts`. The unit suite is **two** projects —
`unit` and `unit-native` — so select it as **`--project 'unit*'`**, never `--project unit`.

🔴 **`--project unit` silently runs 1059 of 1065 files and exits 0.** The six `unit-native` files are
`exclude`d from `unit` rather than merely routed elsewhere, so naming one of them explicitly reports
`No test files found`. A selector matching one project and not the other is a green run over a
suite you did not run — the scripts above already use `'unit*'` for this reason.

#### Run the suites that cover your change; run the WHOLE suite once, at the end

The full unit suite is ~21,500 tests and ~75s, and `test:unit:run` is serialised through the dev-server
queue — so running it between edits blocks everyone else's runs for minutes at a time. Name the covering
suites before you start editing and run those on each iteration:

```bash
pnpm exec vitest run --project 'unit*' src/server/services/__tests__/strike.service.test.ts
```

Find them by grepping for the symbol, not by intuition — `grep -rln '<fn>' src --include=*.test.ts`.
Add `pnpm run test:lint-rules` (~1s) whenever you touch a transaction, a mock, or a module-scope
constant, since those guards are tests rather than eslint rules.

Then run the full suite **once** before committing. That last run is not optional — a service in
`src/server/services/` is imported widely enough that a behaviour change can surface anywhere — but one
run is what it is for.

🔴 **`vitest related` does NOT narrow this codebase — do not reach for it.** It walks the *importer*
graph transitively, and `user.service.ts` is a hub, so almost everything is related to almost
everything. Measured 2026-08-20: `src/server/services/mute-provenance.ts`, a **new leaf module imported
by three files**, selected **473 test files / 7,889 tests** — 40% of the suite, for the same wall-clock
as running all of it. Two source files gave the identical number.

⚠️ **A green full-suite run can still hide a failure you caused.** Read the failing-file list, not the
count: when 17 tests fail across 7 files, `git stash` and re-run those same files to see whether they
already failed on `main`. On Windows several do — see the portability notes in the `civitai-worktrees` skill.

#### Worker count: sized with `VITEST_MAX_WORKERS` / `--max-workers`, uncapped by default
Vitest picks its own worker count; both knobs resize **every** project including the browser pool, and
🔴 the env var does **not** reach a queued `test:unit:run` — only the CLI flag is forwarded. Measurements,
the container-CPU-quota caveat, and why uncapped is the default: `civitai-testing` skill.

#### Never put unit tests under `src/pages`
Next.js 16 treats **every** `.ts`/`.tsx` file under `src/pages` (incl. nested `__tests__/`) as a route, and `next build` runs a route-type validator over it. A Vitest test file there fails the build with `Type '...test' does not satisfy the constraint 'ApiRouteConfig'. Property 'default' is missing` — and **only `next build` catches it**: `pnpm typecheck`, `pnpm test`/vitest, and the CI typecheck/unit/component tasks all pass, so it sneaks through to the preview `build-image` step. Keep handler tests in a `__tests__/` dir **outside** `src/pages` (e.g. `src/server/__tests__/`) and import the handler via the `~/pages/...` alias. (Bit us on PR #2653.)

#### Prefer `importOriginal` over hand-listed `vi.mock` exports
A hand-listed `vi.mock` couples the test to the entire transitive import graph of the thing under test, and
nothing warns you when that graph grows — typecheck and lint stay green, so only CI catches it. Spread the
real module and override only what you need. **Before widening a mock, check whether the import edge is
needed at all.** Worked example and the two incidents: `civitai-testing` skill.

#### Convention guards run as tests
Several repo conventions are enforced by tests, not by eslint. 27 live in
`src/server/services/__tests__/no-*.test.ts` — `no-agent-ground-truth-write`, `no-coerce-boolean-in-api`,
`no-direct-shared-module-mock` (the shared-mock ratchet, see `docs/testing/shared-module-mocks.md`),
`no-doubled-free-slot-noun`, `no-hand-typed-redis-key-constants` (the Redis key-constant
ratchet — hand-typed `REDIS_KEYS` in an allowlisted mock had drifted 15 times), `no-io-in-transaction`,
`no-job-kind-on-remix-mint` (the remix provenance mint must sign `kind: 'mint'` — a `job`
token there is spendable on the upload path, which is the free remix-gallery submission),
`no-lint-rules-script-drift`,
`no-menu-target-tooltip-nesting` (a `Tooltip` INSIDE `Menu.Target` steals the ref the menu needs and
the trigger silently stops opening — six sites had it independently),
`no-module-scope-cache`, `no-pk-addressed-engagement-write`, `no-server-infra-in-app-graph`,
`no-sharp-outside-native-project`, `no-stale-moderator-route-probe`, `no-static-html2canvas-import`,
`no-unbounded-paging-fake`, `no-unbumped-draft-status-write` (a raw-SQL write that moves a Model
into `Draft` must set `"updatedAt" = now()`, or `remove-old-drafts` can cascade-delete it with no
grace period), `no-unguarded-billable-submit` (a user-token orchestrator submit must have its
owner checked — see `assertWorkflowOwner`), `no-unguarded-user-text`, `no-unloadable-image-fixture`,
`no-unmuteable-comment-processor`, `no-unscoped-email-verification-exemption`,
`no-untruthy-query-gate` (a query gated on a feature flag must coerce it — a sparse
flag reads `undefined`, and React Query treats that as enabled), `no-unverified-provenance-write`,
`no-unpriced-default-model`, `no-unwrapped-knob-rotation`, `no-wholesale-module-mock` (the `importOriginal` rule above) — plus
`hub-filter-parity` beside them, `src/server/schema/__tests__/track.addView.schema.test.ts`,
`src/server/notifications/__tests__/notification-settings-polarity.test.ts` and
`src/server/services/__tests__/video-leaderboard-badge-staging.test.ts`. If one fails, fix the code —
don't add an exemption without saying why.

🔴 **`pnpm run test:lint-rules` is a hand-maintained file list, not a glob**, so a guard missing from it fails
only in a full-suite run — hours later, in a file you weren't looking at. Five were missing at once when this
was last audited, on 2026-08-24, and were wired in then. **Add a new guard to the script in the same commit
you write it**, and don't read a green `test:lint-rules` as "all guards passed" without checking the directory
against the script.

`test:lint-rules` names 32 files today.

The count above, the count in the list, and the list itself are what went stale three times, so
`no-lint-rules-script-drift` fails when they disagree with the directory or the script. It reads two exact
phrasings — `<n> live in \`src/server/services/__tests__/no-*.test.ts\`` and
`` `test:lint-rules` names <n> files today `` — plus the backticked names in the list paragraph, so keep those
shapes when you edit the numbers. The same paragraph pair in `.claude/agents/civitai-test-review.md` is
covered too.

`test:lint-rules` is a convenience selector, not the enforcement point: these files match the `unit` project's
`include`, so they already run in `pnpm run test:unit:run` and in CI's `Unit tests` job. No workflow invokes
`test:lint-rules` itself.

#### A passing test says nothing about how it FAILS — check the revert
**"The tests would catch a regression here" is a claim about the failure mode, not about coverage.** Review
your own tests by asking what a reverted fix would print: an assertion message, a timeout, or nothing.

🔴 **Proving a property by absence of termination is not proof — a test runner cannot observe it.** A fake
that drives a loop and never terminates starves the macrotask queue, so vitest's `setTimeout`-based
`testTimeout` never fires and CI hangs with nothing to read. **Any fake driving a bounded loop must
terminate on its own**, and the test must assert the loop stopped early. Numbers and worked examples:
`civitai-testing` skill.

#### Never `await` a browser-test state that DELETES ITSELF
Awaiting a state to **arrive** is safe; awaiting one that will **leave** — a spinner on a ceiling, a debounce
window, anything torn down on a timer — is a race `expect.element` cannot win, green on a quiet box and red
on a busy one. Fix it structurally: make the state absorbing, or assert the end-state and pin the transient
via a mock call count.

🔴 Do **not** widen the matcher budget, add a `retry`, or enlarge the component's own timeout instead — that
converts a fast failure into a slow one and leaves the race unwinnable exactly when CI is slow. Diagnosis
procedure and worked examples: `civitai-testing` skill.

### Database
```bash
pnpm run db:migrate:empty    # Create an empty migration file
pnpm run db:generate         # Regenerate the slim schema + Prisma client
pnpm run db:check-generated  # Fail if the committed generated client is stale
pnpm run db:moderator:pull   # Re-introspect the moderator DB into apps/moderator/prisma/schema.prisma
```

**`schema.full.prisma` is the only schema you edit.** `packages/civitai-db-schema/prisma/schema.full.prisma` is the single tracked schema. `pnpm run db:generate` runs `scripts/generate-slim-schema.js`, which strips `@no-type` models/enums to produce `packages/civitai-db-schema/prisma/schema.prisma` (what `package.json`'s `prisma.schema` points at), then runs `prisma generate`. Both of the *main app’s* `schema.prisma` files — that one **and** the leftover `prisma/schema.prisma` at the repo root — are gitignored build artifacts; editing either is silently overwritten on the next generate. `apps/moderator/prisma/schema.prisma` is a separate, **tracked** schema for the moderator database: introspected, never authored, refreshed with `pnpm run db:moderator:pull` then `pnpm run db:moderator:generate` (see `apps/moderator/CLAUDE.md`). It is not produced by `db:generate`. `pnpm run db:check-generated` regenerates and diffs `packages/civitai-db-schema/src`, so a forgotten regen fails there.

#### Adding an enum value: DEPLOY FIRST, then migrate, then write

🔴 `ALTER TYPE ... ADD VALUE` is harmless on its own; **writing rows that use the new label is not.** Prisma
deserializes enum columns strictly, so a row carrying a label the running client doesn't know throws on **read**
— every page selecting that column 500s, and for a Prisma-mapped view that is every consumer of the view.
Order: **(1)** deploy the regenerated client, **(2)** apply the `ALTER TYPE`, **(3)** backfill / enable writes.
A backfill run before the deploy is what breaks the coupling — it writes rows regardless of what is deployed.
(Bit us 2026-08-19 on `ModelHashType.SHA256_12`: migration and a 1.5M-row backfill both ran ahead of the
deploy, and every model detail page reading the `ModelHash` view started 500ing.)

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

`src/server/` holds the most-edited (and largest) code in the repo. Read the *specific* file before changing it — several are huge, so grep within them rather than reading end-to-end.

- **tRPC API** — `trpc.ts` (root router + procedure helpers), `createContext.ts`, `middleware.trpc.ts`, `routers/` (~100 per-domain routers), `controllers/`, `schema/` (zod input contracts), `selectors/` (Prisma `select` fragments).
- **Images** — `services/image.service.ts` (**8K+ lines**; the hot feed path — `getInfiniteImages`, `getAllImages`, NSFW/own-content merge). API surface `src/pages/api/v1/images/index.ts`; index sync `search-index/images.search-index.ts`.
- **Models** — `services/model.service.ts`, `search-index/models.search-index.ts`.
- **Search (Meilisearch)** — `meilisearch/client.ts` (tags requests with `X-Search-Actor`), `meilisearch/cleanup.ts`, `search-index/base.search-index.ts` (shared sync engine).
- **Redis / caching** — `redis/client.ts` (clients incl. sysRedis), `redis/caches.ts` (`createCachedObject` defs + TTLs, e.g. `imageMetaCache`, `tagIdsForImagesCache`), `utils/cache-helpers.ts`.
- **Orchestrator (generation)** — `orchestrator/get-orchestrator-token.ts` (`getOrchestratorToken`), `services/orchestrator/orchestrator.service.ts`.
- **Auth** — `auth/get-server-auth-session.ts`, `auth/session-verifier.ts` + `auth/session-cache.ts` + `auth/session-invalidation.ts`, `auth/token-claims.ts`, `auth/civ-cookie.ts`, `auth/oauth-bridge.ts`, `auth/route-guard.ts`, `auth/bearer-token.ts`. Shared logic lives in `packages/civitai-auth`; the hub itself is `apps/auth`.
- **Jobs (cron)** — `jobs/job.ts` (runner) + individual jobs `jobs/*.ts` (e.g. `entity-moderation.ts`, `search-index-sync.ts`). **Adding a job to the `jobs` array in `src/pages/api/webhooks/run-jobs/[[...run]].ts` IS the scheduling — see below.**
- **Metrics / analytics** — `metrics/*.metrics.ts` (ClickHouse-backed entity metrics), `clickhouse/`.
- **DB** — `db/db-helpers.ts` (raw pg-pool config: `connectionTimeoutMillis`, labeled pool gauges), Prisma client. **Schema is `packages/civitai-db-schema/prisma/schema.full.prisma`, and migrations are applied manually — see the Database rule above.**
- **Telemetry** — `src/instrumentation.node.ts` (OTEL: Prisma/Redis/HTTP auto-instrumentation + custom `withSpan()` from `utils/otel-helpers.ts`), `schema/track.schema.ts` (ClickHouse action/event tags), `prom/client.ts`.
- **Health** — `src/pages/api/health.ts` runs sub-checks concurrently, each raced at `HEALTHCHECK_TIMEOUT` and the whole set raced against an overall deadline, reporting partial results as checks settle. Checks can be suppressed or demoted to non-critical via the `HEALTHCHECK_DISABLED` env var and the Redis-backed `DISABLED_HEALTHCHECKS` / `NON_CRITICAL_HEALTHCHECKS` keys.
- **Other server domains** — `games/` (new-order/ratings), `webhooks/`, `paddle/` + `coinbase/` (payments), `notifications/`, `signals/`, `rewards/`; S3 helpers at `src/utils/s3-utils.ts`.

### How a scheduled job actually gets scheduled

**Add it to the `jobs` array in `src/pages/api/webhooks/run-jobs/[[...run]].ts` and give `createJob` a real cron string. That is the whole registration.** A separate scheduler service reads the array — names and crons — from `src/pages/api/internal/get-jobs.ts` and registers a recurring trigger per entry, which then calls `run-jobs` back. So the cron string is load-bearing, not documentation.

Nothing *inside this repo* reads `Job.cron`, which is what makes this easy to get wrong. Grepping for a consumer finds none, and the infra repo contains a handful of hand-written Kubernetes CronJobs that curl `run-jobs` directly and whose comments say registration in the array "does NOT schedule anything". Those are per-job exceptions, not the mechanism. Two independent agents reading only that evidence concluded, wrongly, that a new job would never run and that the fix was another CronJob — which would have created a second scheduling path for the same job.

If a job genuinely needs a schedule the scheduler cannot express, say why in the job file, because the next reader has no way to tell that from an oversight.

## Component Standards

### Component Patterns

#### A `Popover` inside anything that clips needs `withinPortal`

`src/providers/ThemeProvider.tsx` sets `Popover: { defaultProps: { withinPortal: false } }` for the
whole app. So a `Popover` rendered inside a `Card`, an `overflow-hidden` wrapper or a scroll area
draws **inside** that container and is clipped by it — the dropdown comes out truncated, at every
call site, with nothing in the JSX pointing at the cause. Pass `withinPortal` explicitly there.

Only `Popover` carries it — `HoverCard` has no theme entry at all and `Tooltip`'s sets `withArrow`
alone. Several components pass `withinPortal` to those two anyway, so grepping for the prop does not
tell you which call sites actually needed it.

### Coding Standards

#### Imports Order
1. External libraries (React, Mantine, etc.)
2. Internal components (~/components/...)
3. Hooks (~/hooks/...)
4. Server/API code (~/server/...)
5. Utils and helpers (~/utils/...)
6. Types and enums
7. Styles

#### Enums come from `~/shared/utils/prisma/enums`, not `@prisma/client`
The instinct in a Prisma codebase is `@prisma/client`, and **nothing stops you** — `no-restricted-imports`
in `.eslintrc.js` covers `@civitai/generation-metadata` only. The repo is 832 files to 13 on this, so the
13 counterexamples (`ModelStatus`, `CollectionType`, `CollectionMode`, `ModelType`, `Availability`, …) read
as permission rather than as drift. Import `Prisma`/`PrismaClient` from `@prisma/client`; import every
enum from the shim.

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

**Nothing in the toolchain checks any of this** — comments aren't type-checked, so typecheck, lint, prettier and every test suite pass over a comment that is actively false. The `comment-review` agent is the only gate: it applies the keep test above, flags comments whose claims no longer resolve, trims the survivors to the fewest words that carry the fact, and calls out the ones whose real fix is a better name rather than a better comment.

## Environment Setup

### Local Development

**Toolchain: node `24.19.0` and pnpm 10.x.** `.nvmrc` is the authority (CI reads it
via `node-version-file:`, and the Dockerfile base image tracks it); `package.json`
declares `engines.node: ">=24.0.0 <25"`. On NixOS the flake owns both — it derives
its node major from `.nvmrc` instead of naming one, and `nix flake check` fails if
they disagree.

Start the dev server with the `/dev-server` skill, never `pnpm run dev`. The daemon is spawned with
`process.execPath`, so whichever node first ran a CLI verb is the node it keeps until shutdown — run it under
the node from `.nvmrc`. First-time machine bootstrap (corepack, submodule, `.env.development`, the
docker-compose base services, and the optional NixOS flake path): `civitai-local-setup` skill.

### Local development — the traps that cost hours

Every one of these presents as something OTHER than its cause, which is why they are
written down. None is OS-specific.

🔴 **`.env.development` is SILENTLY INERT for any key `.env` also defines — but only
when the dev-server daemon starts the app.** The daemon injects the primary
checkout's `.env` into the child's ENVIRONMENT, and a real environment variable beats
any dotenv file, so an override you add to `.env.development` never takes effect while
the value also exists in `.env`. Keys absent from `.env` DO get through, which is what
makes it confusing: half your overrides work. Running the app directly (`pnpm dev`)
uses ordinary Next precedence, where `.env.development` wins as documented.
**Diagnose it by reading the running process's environment, not the files** — but note
`/proc/<pid>/environ` (or its equivalent) shows only what was exported at exec time,
never values dotenv loaded at runtime, so use `@next/env`'s `loadEnvConfig` to see
what the app actually resolved. The tell is an override that plainly should work and
does not, e.g. a connection error naming a host you already pointed elsewhere.

🔴 **Sign-in needs the AUTH HUB, and its env does not come with a checkout.**
`apps/auth/.env` is gitignored, so a fresh clone has none and login simply fails.
It needs an **EC P-256 keypair whose private half is PKCS8** (a SEC1 key throws at
import), an issuer/JWKS pair pointing at the hub's own port, and `NEXTAUTH_SECRET` +
`AUTH_INTERNAL_TOKEN` **identical to the main app's**. Start it via the `/dev-server`
skill's `auth` verbs. Verify with the hub's JWKS endpoint: it must serve the `kid` of
the key you just generated — that is the positive control that it signs with your key.

🔴 **The hub always connects to Postgres over SSL, and a stock local Postgres has
none.** It rewrites its own connection string to `sslmode=no-verify`, so adding
`?sslmode=disable` to the URL does nothing. Login then fails with a generic
*"Something went wrong on our end."* on the form, and the real error —
`The server does not support SSL connections` — appears only in the hub's log. Give
the local database a self-signed certificate and turn SSL on; `no-verify` accepts it.

🔴 **Two database columns gate a usable local account, and one is silent.**
`isModerator` is the obvious one. The other is `onboarding`, which must equal
`OnboardingComplete` (see `src/server/common/enums.ts`) — otherwise every gated route
renders the **"Welcome!" onboarding wizard**, often with a hydration error, which
reads exactly like the route being broken. **Sessions are cached**: after changing
either column, clear the Redis caches AND log in again, or the app keeps serving the
old values from cache.

🔴 **Feature flags have TWO independent paths, and they fail apart.** Client/SSR gates
read the feature-flag service, which honours a `FEATURE_FLAG_<KEY>=public` environment
override (see `getEnvOverrides` in `src/server/services/feature-flags.service.ts`).
Several server-side gates call Flipt directly and fail closed, so the env override does
not reach them — set only that and you get a rendered page with an empty result set,
which looks like a broken query. **Take the flag's real key from `fliptKey` in that
service; never infer it from the camelCase name** — an unknown key evaluates false and
is indistinguishable from a feature that is legitimately off.

🔴 **App Blocks need a signing keypair or they 503.** With `BLOCK_TOKEN_PRIVATE_KEY` /
`BLOCK_TOKEN_PUBLIC_KEY` unset, `POST /api/v1/block-tokens` returns
`Block tokens not configured` and the UI shows **"Couldn't authenticate this app"** —
an auth-shaped message whose cause is missing configuration. The `kid` is derived from
the key, so no third variable is needed. Separately, a block's iframe loads from the
origin in its manifest, which is usually NOT served locally; the host then sits on its
boot skeleton indefinitely.

⚠ **`data-testid` attributes are stripped from production builds**
(`reactRemoveProperties` in `next.config.mjs`). They are reliable selectors for local
work and match nothing against a deployed environment.

### Git Worktrees

Worktrees live in `<repos-root>/worktrees/<name>` — all of them, no prefix on the directory name. Keep
them under the repos root: `.claude/skills/dev-server/scripts/defender-exclusions.ps1` excludes that
path from Defender real-time scanning, and a tree outside it silently runs slow. (Run it once with
`-ReposRoot <repos-root>` to cover the parent; its default only covers the single checkout it lives in.)

```bash
git fetch origin main
git worktree add <repos-root>/worktrees/<name> -b <branch> --no-track origin/main   # all three — see below
git -C <repos-root>/<primary-checkout> submodule sync --recursive
git -C <repos-root>/worktrees/<name> submodule update --init event-engine-common
printf 'use flake\n' > <repos-root>/worktrees/<name>/.envrc && direnv allow   # from inside the worktree
pnpm install
git -C <repos-root>/worktrees/<name> status -sb | head -1   # must print `## <branch>` and nothing else
```

**Check that last line before you start working.** A branch destined for a new PR has *no upstream* —
`## <branch>` alone. Anything after the `...` means the branch is already tracking something, and when
that something is `origin/main` the worktree is in the broken state described below. Verifying costs a
second here; not verifying stays invisible until the first `git pull` or `git status` on the branch.

**Always `-b <branch> --no-track origin/main`. Never the shorthand.** All three parts are load-bearing:
`-b` creates a new branch and **refuses if the name already exists** (which is what makes this safe to run
blind); `origin/main` is the base, without which the branch forks from *this* tree's stale `HEAD`; and
`--no-track` stops that base from also becoming the *upstream*, which `branch.autoSetupMerge` would otherwise
do behind your back — a base and an upstream are different things and git conflates them here.

🔴 **Without `--no-track` your feature branch tracks `main` forever.** `git pull` on it then **merges
`origin/main` into your feature branch**, and since this repo squash-merges, that merge commit is pure noise in
the diff. Tell with `git status -sb`: healthy is `## <branch>` alone, or `## <branch>...origin/<branch>` once
pushed; `## <branch>...origin/main` is the broken state. Fix with `git branch --unset-upstream`, then
`git push -u origin <branch>` on first push.

🔴 **Do not create worktrees with the `EnterWorktree` tool.** It puts the tree in `.claude/worktrees/` —
outside the Defender-excluded repos root, so it silently runs slow — and branches the shorthand way, so the new
branch comes out tracking `origin/main` instead of clean for a new PR. Use the recipe above. Entering an
*existing* worktree with `EnterWorktree` `path:` is fine — that creates nothing.

🔴 **`git worktree add <path>` with no branch and no base is the other trap**, because it looks like it worked:
git silently invents a branch named after the directory's basename and forks it from local `HEAD`. Nothing
errors, and the staleness only surfaces later as conflicts against a `main` that moved. Signature: **branch
name identical to the directory name** (that is how `worktrees/moderator-feedback` was created, 2026-08-20).
`git fetch origin main` on the first line is what keeps the base honest — remembering the flags does not help
if the ref they name is itself stale.

**Remove one when its PR merges** — don't hand-roll this, and don't reach for `git worktree remove`
(it refuses whenever `event-engine-common` is checked out):

```bash
node .claude/skills/dev-server/cli.mjs wt stale        # what's finished, and what's blocking each keeper
node .claude/skills/dev-server/cli.mjs wt rm <path>    # stops the server, unlinks links, deletes, prunes
```

`wt rm` refuses the primary worktree, a tree with uncommitted changes (`--force`) and one with a running dev
server (`--stop-server`), and deletes the branch only when `gh` reports a **merged** PR. 🔴 **Do not verify
merge state by hand with `git merge-base --is-ancestor`, or count unpushed commits with a bare
`git log --not --remotes`** — this repo squash-merges and the second has no positive rev, so both return
success-shaped output that tells you nothing. Correct commands and the numbers: `civitai-worktrees` skill.

**Setting the tree up once it exists** — initialize the `event-engine-common` submodule and create the
gitignored `.envrc`, or test runs from that tree are silently wrong: without the submodule
`src/server/routers/__tests__/blocks.router.workflow.test.ts` collects **0 tests** and still reads as a pass.
Full procedure, the NixOS `.envrc`/Prisma-engine consequences, and matching a host browser bundle to the
repo playwright pin: `civitai-worktrees` skill.

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
7. Run `comment-review` over the diff, and `docs-drift-review` over the commits — the two lanes with no
   automated gate. Neither is optional on a change that moved a file, renamed a script or command,
   retired an env var, or completed a tracked checklist item: those are what go stale silently, and a
   `CLAUDE.md` that is wrong is an instruction that gets followed.

### Stacked PRs — don't
- **NEVER use stacked PRs** — base every PR directly on the integration branch (`main`, or a feature integration branch like `feat/...`), never on another open PR's branch. Stacked PRs silently mis-merge: a squash-merged parent doesn't retarget the child, so the child lands on the orphaned parent branch instead of the real base and its changes go missing.
- If a change depends on an unmerged PR, **wait for that PR to merge, then branch off the updated base** — or fold both changes into a single PR.
- (Bit us 2026-06-13: PR #2520's App Blocks W11 F5 was stacked on #2518 (F6) → #2520 squash-merged into the #2518 branch instead of `feat/app-blocks-main-v1`; corrected via #2525.)

### Filing follow-up work: two lists, and the line between them

Work you generate about your own work — the deferred half of a review, a duplicate you noticed, a missing
index, a test you did not write — goes in the **`Agent Follow-ups`** list, not the team list. Resolve the
id with `find-list "Agent Follow-ups"`.

**`Synced Team`** stays what a human would recognise as the team's work: anything a person asked for out
loud, and anything security-shaped or user-facing-broken, filed at its real priority. Those never go in
the follow-ups list — the line exists so the new list does not become where real bugs go to be quiet.

Two rules for anything you file:

- **File as the human whose session you are running in**, not as the meta agent. Their name on it is what
  makes it findable by the person who has to decide it.
- **Name the PR or commit it fell out of.** A follow-up without that is a sentence nobody can act on six
  weeks later.

The follow-ups list is a queue to be worked down, not an archive.

## Common Patterns

### Modals
Use Mantine modals with proper accessibility and keyboard handling.

#### Dialog Registry System
The project uses a dialog-registry system for managing modals:
- Register dialogs in `src/components/Dialog/dialog-registry2.ts` (URL-routed ones in `routed-dialog-registry.ts`)
- Use `DialogProvider` for context-based modal management
- `RoutedDialogProvider` for URL-based modal state
- Access dialogs through the registry for consistent modal handling across the app

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
| Feed Impressions | [docs/features/feed-impressions.md](docs/features/feed-impressions.md) |
| Bitwise Flags | [docs/features/bitwise-flags.md](docs/features/bitwise-flags.md) |
| Civitai LLM Client | [docs/features/civitai-llm-client.md](docs/features/civitai-llm-client.md) |
| Challenge Platform | [docs/features/challenge-platform.md](docs/features/challenge-platform.md) |
| Civitai Link | [docs/features/civitai-link.md](docs/features/civitai-link.md) |

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
