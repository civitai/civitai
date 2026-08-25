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

### Additional Libraries
- React Query (Tanstack Query) for data fetching
- React Hook Form with Zod validation
- Tiptap for rich text editing
- Chart.js for data visualization
- Stripe/Paddle/PayPal for payments

## Build Commands

### Development
**Always use the `/dev-server` skill** to manage dev servers. Never use `pnpm run dev` directly.
That covers `moderator` and `creator-studio` too — `cli.mjs start --app <name>` runs them from the
worktree you are in, on a port the daemon reserves, with the auth hub started for you. The other
`apps/*` have no dev-server integration; use their own `pnpm dev:<name>`.

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

#### SvelteKit apps have their own standard

`apps/moderator`, `apps/auth` and `apps/creator-studio` are SvelteKit 5 + Kysely + shadcn-svelte +
Tailwind v4 — none of the Mantine/tRPC/Prisma guidance above applies to them. Their shared conventions
live in **[`docs/svelte-app-standard.md`](docs/svelte-app-standard.md)**, and each app's `CLAUDE.md`
records only its deltas. Review a segment there with `svelte-correctness-review`,
`svelte-idiom-review` and `svelte-abstraction-review`.

#### In SvelteKit apps (`apps/moderator`, `apps/auth`, `apps/creator-studio`): use `typecheck`, never `check`

They are **not** synonyms. `typecheck` is `svelte-check` alone and writes nothing. `check` prefixes it
with `svelte-kit sync`, which regenerates ~690 files under `.svelte-kit/` — a directory the Vite dev
server watches — so running it in an edit→verify loop has Vite re-optimising the module graph while
`svelte-check` loads ~9,000 files. That collision froze an entire day's work before it was diagnosed
(2026-08-07), and it does not reproduce in the main app because `tsc --noEmit` emits nothing.

Reach for `check` **only** after changing the route tree — adding, removing or renaming a
`+page`/`+server`/`+layout` file — which is the only time the generated `$types` go stale. Symptom of
needing it: `Cannot find module './$types'`, or component props resolving to `never`. `prepare` runs
`sync` on install, so a fresh checkout is already covered.

**`build` runs `svelte-kit sync` too** (`svelte-kit sync && vite build`), so it carries the same cost —
and it is **not** a check: it catches nothing `svelte-check` doesn't.

**Read `svelte-check`'s WARNING lines, not just ERROR.** It reports Svelte compiler warnings, and
`state_referenced_locally` — `let x = $state(data.foo)` capturing only the first value, so the UI
silently shows stale data after a navigation — is a real bug that appears there and nowhere else in
the loop. Filtering output to `ERROR` hides it.

#### Never run `npx prettier --plugin=prettier-plugin-svelte` on `.svelte` files

It **empties every file it touches to zero bytes**, and reports success on each one. It took out 28
components in one command (2026-08-07); they were only recoverable because they were committed. The
first symptom is `svelte-check` reporting props as `never`, which reads like stale `$types` and sends
you diagnosing the wrong thing.

Note what `pnpm run prettier:write` does **not** cover: the root Prettier is 2.8.8 and globs
`.ts`/`.tsx` only, so **no root command formats `.svelte` at all**. `apps/creator-studio` formats
itself with its own Prettier 3 + plugin (`.prettierignore` explains why ownership must be exclusive);
the other SvelteKit apps' `.svelte` files are hand-formatted.

#### Prettier runs on UNCOMMITTED files only — never the whole repo

`prettier:write`/`prettier:check` are `scripts/prettier-changed.mjs`, which formats what git reports as
dirty (modified-vs-HEAD plus untracked) and nothing else. Do not "fix" them back into a `**/*` glob,
and do not reach for a repo-wide `npx prettier --write` instead.

**The repo is not Prettier-clean and will not be until the 2→3 upgrade reformats it deliberately.**
`.github/workflows/lint.yml` puts the number at 789 of 4,116 `src` files; across the whole workspace it
is ~1,000. So a repo-wide `--write` is not a formatting pass, it is a ~1,000-file commit that buries the
actual change — and it rewrites **other people's uncommitted work in place**, which is how it was found
(2026-08-08: one `pnpm run prettier:write` produced 1,085 modified files, and telling the reformatting
apart from real edits afterwards needed a per-file diff against `prettier(HEAD)`).

CI already scopes itself this way and gates only on **added** files for exactly this reason.

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
already failed on `main`. On Windows several do — see the portability notes below.

#### Worker count: uncapped by default, `VITEST_MAX_WORKERS` / `--max-workers` to size it
A suite uses Vitest's own worker count (`cpus - 1` in run mode, `floor(cpus / 2)` in watch; the browser pool `min(12, cpus - 1)`).

```bash
VITEST_MAX_WORKERS=8 pnpm exec vitest run --project 'unit*'   # direct run (BOTH unit projects)
pnpm run test:unit:run --max-workers=8                     # through the dev-server queue
```

🔴 **The env var does not reach a queued run.** With `CIVITAI_TEST_QUEUE` set, `test:unit:run` hands the run to the dev-server daemon, which spawns it with **its own** environment — so `VITEST_MAX_WORKERS=8 pnpm run test:unit:run` silently runs at the full pool while you believe you capped it. The CLI flag is forwarded and does work (verified: 3 distinct `VITEST_POOL_ID`s from a 40-file probe run through the queue with `--max-workers=3`).

⚠️ Either knob sets the count for **every** project, browser included, and it is **not clamped** to the browser pool's 12 — `getThreadsCount` returns it unchanged, so `--max-workers=16` launches 16 Chromium instances, past what upstream calls safe. It sizes the pool; it does not only shrink it.

**Why uncapped is the default.** A flat cap of 8 lived in `vitest.config.mts` (#3900) because several agents each running a full suite at once saturated the box. The dev-server test queue now serialises `test:unit:run` at concurrency 1 (#3947). Measured on a 32-core Windows box, alternating runs through that queue: **8 workers 507.3s / 526.9s, uncapped (31 workers) 281.4s / 295.8s** — 1.79x on the means. Nothing changes on GitHub CI, which runs on 4-vCPU `ubuntu-latest`, where the old cap's `cpus > 9` guard already made it inert.

⚠️ Only `test:unit:run` is queued. `test:component`, `test:packages:run`, `test:apps:run` and `test:lint-rules` call `vitest` directly, so a queued unit run and an unqueued component run still overlap — 31 workers plus 12 Chromium instances, where the old config bounded the pair at 8 + 6. Cap one of them by hand if you are sharing the box.

⚠️ More workers is not monotonically better once other pool settings move: with `--no-isolate` the same box measured 119s at 8 workers and 1025s at 31. Measure both ends before changing one.

⚠️ In a container limited by a **CPU quota** rather than a cpuset, `os.availableParallelism()` reports the host's cores, so an uncapped run resolves to host-cores-1 workers under a much smaller budget. Nothing in this repo invokes Vitest that way — the only CI that does is `ubuntu-latest` — but a pipeline defined outside it should set `VITEST_MAX_WORKERS` explicitly.

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
Several repo conventions are enforced by tests, not by eslint. 18 live in
`src/server/services/__tests__/no-*.test.ts` — `no-agent-ground-truth-write`, `no-coerce-boolean-in-api`,
`no-direct-shared-module-mock` (the shared-mock ratchet, see `docs/testing/shared-module-mocks.md`),
`no-doubled-free-slot-noun`, `no-hand-typed-redis-key-constants` (the Redis key-constant
ratchet — hand-typed `REDIS_KEYS` in an allowlisted mock had drifted 15 times), `no-io-in-transaction`,
`no-lint-rules-script-drift`,
`no-module-scope-cache`, `no-pk-addressed-engagement-write`, `no-server-infra-in-app-graph`,
`no-sharp-outside-native-project`, `no-stale-moderator-route-probe`, `no-static-html2canvas-import`,
`no-unbounded-paging-fake`, `no-unloadable-image-fixture`, `no-unverified-provenance-write`,
`no-unwrapped-knob-rotation`, `no-wholesale-module-mock` (the `importOriginal` rule above) — plus
`hub-filter-parity` beside them, `src/server/schema/__tests__/track.addView.schema.test.ts`,
`src/server/notifications/__tests__/notification-settings-polarity.test.ts` and
`src/server/services/__tests__/video-leaderboard-badge-staging.test.ts`. If one fails, fix the code —
don't add an exemption without saying why.

🔴 **`pnpm run test:lint-rules` is a hand-maintained file list, not a glob**, so a guard missing from it fails
only in a full-suite run — hours later, in a file you weren't looking at. Five were missing at once when this
was last audited, on 2026-08-24, and were wired in then. **Add a new guard to the script in the same commit
you write it**, and don't read a green `test:lint-rules` as "all guards passed" without checking the directory
against the script.

`test:lint-rules` names 23 files today.

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
pnpm run db:moderator:pull   # Re-introspect the moderator DB into apps/moderator/prisma/schema.prisma
```

**`schema.full.prisma` is the only schema you edit.** `packages/civitai-db-schema/prisma/schema.full.prisma` is the single tracked schema. `pnpm run db:generate` runs `scripts/generate-slim-schema.js`, which strips `@no-type` models/enums to produce `packages/civitai-db-schema/prisma/schema.prisma` (what `package.json`'s `prisma.schema` points at), then runs `prisma generate`. Both of the *main app’s* `schema.prisma` files — that one **and** the leftover `prisma/schema.prisma` at the repo root — are gitignored build artifacts; editing either is silently overwritten on the next generate. `apps/moderator/prisma/schema.prisma` is a separate, **tracked** schema for the moderator database: introspected, never authored, refreshed with `pnpm run db:moderator:pull` then `pnpm run db:moderator:generate` (see `apps/moderator/CLAUDE.md`). It is not produced by `db:generate`. `pnpm run db:check-generated` regenerates and diffs `packages/civitai-db-schema/src`, so a forgotten regen fails there.

#### Adding an enum value: DEPLOY FIRST, then migrate, then write

`ALTER TYPE ... ADD VALUE` is harmless on its own. **Writing rows that use the new label is not.**
Prisma deserializes enum columns strictly, so a row carrying a label the running client doesn't
know throws on **read** — not on the write that created it. Every page selecting that column 500s,
and for a Prisma-mapped view the blast radius is every consumer of the view.

Normally this is invisible because the code that writes a new value ships in the same deploy that
teaches the client about it. A **backfill breaks that coupling**: it writes rows the moment you run
it, regardless of what is deployed.

So treat an additive enum as expand/contract:

1. **Deploy** the regenerated client (knows the value, writes none) — every reader can now decode it
2. Apply `ALTER TYPE ... ADD VALUE` — value exists, still unused
3. Backfill / enable the writes — first rows appear, safely

Applying the migration before the deploy is only safe while **nothing writes the value**. If a
backfill runs in that window, pods on the previous build break on read until the deploy lands.

(Bit us 2026-08-19 adding `ModelHashType.SHA256_12`: the migration and a 1.5M-row backfill both ran
ahead of the deploy, and every model detail page reading the `ModelHash` view — which has no type
filter, so it surfaces every hash type to every reader — started 500ing.)

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

#### 5. A `Popover` inside anything that clips needs `withinPortal`

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

**Nothing in the toolchain checks any of this** — comments aren't type-checked, so typecheck, lint, prettier and every test suite pass over a comment that is actively false. The `comment-review` agent is the only gate: it applies the keep test above, flags comments whose claims no longer resolve, trims the survivors to the fewest words that carry the fact, and calls out the ones whose real fix is a better name rather than a better comment.

## Environment Setup

### Required Environment Variables
- Database connection strings
- Authentication providers
- S3/CloudFlare credentials
- Payment provider keys
- Search service endpoints

### Local Development

**Toolchain: node `24.19.0` and pnpm 10.x.** `.nvmrc` is the authority (CI reads it
via `node-version-file:`, and the Dockerfile base image tracks it); `package.json`
declares `engines.node: ">=24.0.0 <25"`. On NixOS the flake owns both — it derives
its node major from `.nvmrc` instead of naming one, and `nix flake check` fails if
they disagree.

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

**Always `-b <branch> --no-track origin/main`. Never the shorthand.** All three parts are
load-bearing and none is optional:

- **`-b <branch>`** creates a new branch and **refuses if the name already exists**, which is the
  property that makes this safe to run without checking first. Without `-b`,
  `git worktree add <path> <existing-branch>` checks out a branch someone else may be building on.
- **`origin/main`** is the base. Without it the new branch forks from *this* worktree's `HEAD` — the
  local `main` you last pulled, not the real one.
- **`--no-track`** stops that base from also becoming the branch's *upstream*. `branch.autoSetupMerge`
  defaults to `true`, so `-b <branch> origin/main` sets `branch.<branch>.merge = refs/heads/main`
  behind your back — a base and an upstream are different things and git conflates them here.

🔴 **Without `--no-track` your feature branch tracks `main` forever.** `git status` then reports it as
"diverged from 'origin/main' … ahead N, behind M" and offers to reconcile — which is confusing but
harmless — while `git pull` on the branch is the actual hazard: it **merges `origin/main` into your
feature branch**, and since this repo squash-merges PRs, that merge commit is pure noise in the diff.
Tell with `git status -sb`: a healthy feature branch prints `## <branch>` alone, or `## <branch>...origin/<branch>`
once pushed. `## <branch>...origin/main` is the broken state. Fix an existing one with
`git branch --unset-upstream`, then `git push -u origin <branch>` when you first push, which sets the
upstream that should have been there.

🔴 **Do not create worktrees with the `EnterWorktree` tool.** It puts the tree in `.claude/worktrees/`
— outside the Defender-excluded repos root, so it silently runs slow — and under the default
`worktree.baseRef: fresh` it branches from `origin/<default-branch>` the shorthand way, so the new
branch comes out tracking `origin/main` instead of clean for a new PR. Use the `git worktree add`
recipe above. Entering an existing worktree with `EnterWorktree` `path:` is fine — that only switches
the session's directory and creates nothing.

🔴 **`git worktree add <path>` with no branch and no base is the other trap**, because it looks like it worked: git
silently invents a branch named after the directory's basename and forks it from local `HEAD`. You
get a new branch, so nothing errors, and the staleness only surfaces later as conflicts against a
`main` that moved. Tell from the outside: **branch name identical to the directory name** is the
signature. That is how `worktrees/moderator-feedback` was created (2026-08-20) — branch `moderator-feedback`
based at `74bd61e6d8`, which was the primary worktree's `main`, while `origin/main` was already three
commits further on at `e21fc62eea`.

`git fetch origin main` on the first line is what keeps `origin/main` honest — the trap is not
avoided by remembering the flags if the ref they name is itself stale.

**Remove one when its PR merges** — don't hand-roll this, and don't reach for `git worktree remove`
(it refuses whenever `event-engine-common` is checked out):

```bash
node .claude/skills/dev-server/cli.mjs wt stale        # what's finished, and what's blocking each keeper
node .claude/skills/dev-server/cli.mjs wt rm <path>    # stops the server, unlinks links, deletes, prunes
```

`wt rm` refuses the primary worktree, a tree with uncommitted changes (`--force`), and a tree with a
running dev server (`--stop-server`). It deletes the branch only when `gh` reports a **merged** PR, keeps
it when commits exist on no remote, and prints the SHA when it does delete. Left alone, worktrees
accumulate: 22 stale ones were removed in one sweep on 2026-08-12, 15 with already-merged PRs.

**Two checks that fail *clean* if you verify merge state yourself.** Both return success-shaped output
while telling you nothing:
- `git merge-base --is-ancestor <branch> origin/main` — this repo squash-merges, so a merged branch's tip
  is never an ancestor. It reported "not merged" for 24 of 26 branches, including ones demonstrably in
  `main`. Use `gh pr list --state all --head <branch>`.
- `git log --not --remotes` with **no positive rev** prints nothing, which reads as "no unpushed commits."
  It has nothing to list commits *from*. Use `git rev-list --count <branch> --not --remotes` — run
  correctly, six branches turned out to hold commits that existed on no remote at all.

When you create a new worktree, **always initialize the `event-engine-common` submodule
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
get system Node instead of the flake's pinned version. Measured (when the flake still shipped node 22): system
Node **26.5.0** against the flake's **22.22.2** produced 7 spurious `window.localStorage is undefined` failures
under happy-dom plus 8 Prisma `linux-nixos` engine errors — every one a false red that got attributed to the code
under test. The flake now ships **24.19.0**, matching `.nvmrc`, so the version gap is smaller — but the *Prisma*
half is unchanged and does not care about the gap: without the flake's env there are no `PRISMA_*_ENGINE_*` paths
at all, and prisma goes looking for a `linux-nixos` engine that has never been published.
`cp .envrc.example <worktree>/.envrc && direnv allow`, or run commands through `nix develop`.
**Then confirm your cwd is actually the worktree**: one run
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
| Feed Impressions | [docs/features/feed-impressions.md](docs/features/feed-impressions.md) |
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
