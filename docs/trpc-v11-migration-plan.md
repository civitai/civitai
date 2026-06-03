# tRPC v10 → v11 Migration Plan

> Companion to [trpc-router-dev-recompile-and-v11-notes.md](./trpc-router-dev-recompile-and-v11-notes.md).
> That doc explains *why* we want v11 (the `router.lazy()` dev-recompile payoff) and the
> circular-dependency landmines. This doc is the actual step-by-step migration plan, including
> the React Query v4→v5 upgrade that v11 forces.

## ⏱️ Execution log (worktree `trpc-v11-migration`, in progress)

Work is happening in worktree `C:/Work/model-share-trpc11`. Deps bumped to **tRPC 11.17.0 /
React Query 5.101.0** (incl. `react-query-devtools`). Main branch (v10) typechecks at **0 errors**,
so every error below is migration-caused.

**The decisive finding — almost all errors were one cascade.** A first typecheck showed **2,104
errors**, ~89% implicit-`any`. That was *not* 2,104 problems: three broken type annotations in
[src/utils/trpc.ts](../src/utils/trpc.ts) made the whole `trpc` proxy resolve to `any`, which
turned every callback parameter across 1,000+ call sites into an implicit-`any` error. Fixing
those three lines dropped the count to **476**:
- `CreateTRPCNext<AppRouter, NextPageContext, null>` → v11 takes **2** generics, not 3 (`TS2314`).
- type `CreateTRPCProxyClient` → renamed **`CreateTRPCClient`** (runtime `createTRPCProxyClient`
  → `createTRPCClient`) (`TS2724`).
- transformer (`superjson`) moved off the root config **onto each `httpLink`**.

**Other root/config fixes (small, high-leverage):**
- `createCallerFactory` is no longer a `@trpc/server` export — destructure it off `t`
  (`export const { router, middleware, createCallerFactory } = t`) and call `createCallerFactory(appRouter)`.
- middleware `options.rawInput` → `await options.getRawInput()` (now async) in `src/server/trpc.ts`.
- type `DefaultErrorShape` → **`TRPCDefaultErrorShape`** (6 files).
- Worktree gotcha: `event-engine-common/` is an untracked submodule-like dir; a fresh worktree
  starts empty and `image.service.ts` fails to resolve it. Copy it in from main.

**The official RQ v5 `remove-overloads` codemod was a no-op here** — it only rewrites raw
`@tanstack/react-query` multi-arg calls, and our hooks go through tRPC's own `(input, opts)`
signature. It only produced recast reprint noise (incl. comment scrambling in non-RQ files); reverted.

**Mechanical batch applied (476 → 86):**
- **380×** mutation `.isLoading` → `.isPending` (query `.isLoading` still exists in v5, so the
  flagged sites are exactly mutations — applied via a column-targeted script using the tsc report).
- **4×** `.isPreviousData` → `.isPlaceholderData`.

**Remaining: 86 errors.** The substantive ones:
- **`cacheTime` → `gcTime`** (~42) — rename (incl. project wrapper params that forward it).
- **`keepPreviousData: true` → `placeholderData: keepPreviousData`** (function import). ⚠️ The
  recurring idiom is wrappers that accept `options?: { keepPreviousData?: boolean }` and **spread
  it into the hook** (~50 files, e.g. [article.utils.ts](../src/components/Article/article.utils.ts#L65)).
  **Resolved (choice B):** a shared `withPlaceholderData()` helper in
  [trpcHelpers.ts](../src/hooks/trpcHelpers.ts) translates the boolean at the spread sites; direct
  literals use `placeholderData: keepPreviousData` from `@tanstack/react-query`.
- **query `onSuccess`/`onError`/`onSettled`** removed in v5 (10 sites) — rewritten to `useEffect`
  on `data`/`error` (or, for the manual-refetch case, awaiting `refetch()`).
- misc: `cacheTime`→`gcTime` (client only — server has its own `cacheTime` vars), `refetchInterval`
  callback now receives the Query (`query.state.data`), `useIsMutating(key)`→`useIsMutating({ mutationKey })`,
  `getNextPageParam` `: 0` sentinel → `: undefined`, `user`-possibly-undefined guard narrowing.

**Confirmed non-issues:** infinite queries (tRPC wraps `initialPageParam`; zero `getNextPageParam`
errors), `useContext`/utils API (unchanged).

### ✅ Status: typecheck-clean (0 errors)

`pnpm run typecheck` passes in the worktree (main baseline was also 0, so the diff is clean).
Total change: **250 src files + `package.json` + lockfile**. Notable v11/v5 specifics discovered:
- `createTRPCNext` needs `transformer` as a **top-level option** (its `WithTRPCOptions` intersects
  `TransformerOptions`); the link **also** needs it; `CreateTRPCClientOptions.transformer` is a
  *forbidden* sentinel (so the vanilla `createTRPCClient` takes it on the link only).
- **RQ 5.101 changed mutation callback arity** to `(error, variables, onMutateResult, context)` —
  only bites where a callback is *explicitly invoked* (e.g. forwarding a caller's `onError`).
- Worktree gotcha: `event-engine-common` is a **git submodule**; a fresh worktree starts empty.
  Populate it (`git submodule update --init`, or copy from main) or `image.service.ts` won't resolve.

**Still TODO before merge:** run `pnpm run lint` + `prettier:write` (unused imports from reverts,
the `eslint-disable` lines added on a few effects), then runtime smoke-test the behavioral changes
(the `onSuccess`→`useEffect` rewrites and the `applyDomainFeature` middleware `getRawInput()`).

## The headline

The v11 API change is the *small* part. **The dominant cost is the forced
`@tanstack/react-query` v4 → v5 upgrade** — tRPC v11's `@trpc/react-query` peer-depends on
React Query v5, and we're pinned to `^4.12.0`. You cannot ship one without the other.

The dev-speed win (`router.lazy()`) is a *separate, optional third phase* that comes after the
API migration is green.

## Measured blast radius (current tree)

| Surface | Count | Impact |
|---|---|---|
| `trpc.*.useQuery/useMutation/useInfiniteQuery` call sites | **~1,054** | Where v5 type changes land |
| `@trpc/*` packages on `^10.45.0` | 4 | `server`, `client`, `next`, `react-query` — bump together |
| Routers statically imported in `routers/index.ts` | 92 | Targets for Phase 3 `lazy()` |
| `onSuccess`/`onError` **inside `useQuery`/`useInfiniteQuery`** | **~66** | ⚠️ **Removed in v5** — manual rewrite, no codemod. *The* main manual job. |
| `onSuccess/onError/onSettled/keepPreviousData` (all) | ~532 | Mutation callbacks **stay**; query callbacks don't |
| `.isLoading` usages | ~230 | See semantics note below — query `isLoading` **stays** (redefined); only *mutation* `isLoading` → `isPending` |
| `useInfiniteQuery` call sites | ~41 | ✅ **~zero-touch** — tRPC wraps `initialPageParam`; we already pass `getNextPageParam` |
| `cacheTime` | ~42 | → `gcTime` (codemod) |
| `isInitialLoading` | ~66 | → `isLoading` (codemod) |
| `isPreviousData` | ~5 | → `isPlaceholderData` (codemod) |
| `keepPreviousData: true` | subset | → `placeholderData: keepPreviousData` (codemod) |
| `status === 'loading'` comparisons | ~22 | → `'pending'` (manual-ish; codemod covers most) |
| `Hydrate` / `dehydrate` | ~6 | `Hydrate`→`HydrationBoundary`; verify SSG/SSR usage |
| `.remove()` query method | ≤6 | removed → `queryClient.removeQueries` (verify which are queries) |
| `refetchInterval:` callbacks | ~8 | 2-arg `(data, query)` → `(query)`; verify which use callback form |
| server `rawInput` in middleware | 1 | → `getRawInput()` |
| `createTRPCProxyClient` | 2 | → `createTRPCClient` (aliased; cosmetic) |
| Direct `@tanstack/react-query` imports | ~20 | Review against v5 API |
| `useQueries` | 1 | New `{ queries: [...] }` object form |
| `useErrorBoundary` / `isDataEqual` / `inferHandlerInput` / `ProcedureArgs` | 0 | ✅ not used |
| `trpc.useContext()` | 0 | ✅ aliased forever anyway — non-issue |

**Environment is ready:** React 18.3.1 / Next 14.2 satisfy RQ v5's React-18 floor, and
TypeScript **5.9.2** satisfies tRPC v11's **≥5.7.2** requirement. No React or TS bump needed.

## Verified semantics (researched against official v5/v11 guides — read before editing)

1. **`isLoading` is NOT removed for queries.** v5 renames `status: 'loading'` → `'pending'`
   and adds `isPending` (= "no data yet"). `isLoading` still exists but is **redefined** as
   `isPending && isFetching`. So our ~230 query `.isLoading` reads mostly keep working — *except*
   for **disabled/paused queries** (`enabled: false`), where v4 `isLoading` was `true` but v5
   `isLoading` is `false` (it's now `isPending` that's `true`). Audit `enabled: false` + spinner
   logic specifically. For **mutations**, `isLoading` IS removed → must become `isPending`.
2. **Infinite queries are ~zero-touch.** tRPC's `useInfiniteQuery` wrapper injects
   `initialPageParam` for you; you only optionally pass `initialCursor`. Our existing
   `getNextPageParam: (lastPage) => lastPage.nextCursor` is unchanged. Do **not** hand-add
   `initialPageParam` to the ~41 sites.
3. **`useContext` / utils proxy unchanged.** `useContext` is aliased "for the foreseeable
   future"; `setInfiniteData`/`getInfiniteData`/`invalidate` etc. behave the same. No work.
4. **Transformer moves to the link.** Client: `transformer: superjson` comes off the root
   config and onto each `httpLink`/`httpBatchLink`. (`createTRPCNext` still accepts it
   top-level per the v11 guide, but the proxy/vanilla client needs it on the link.) Server keeps
   it on `initTRPC.create`.

## Risks, ranked

1. **Query-level `onSuccess`/`onError`/`onSettled` removal (~66 sites).** These are *silent*
   behavior changes — many won't surface as type errors. They must be hand-rewritten (move to
   `useEffect`, derive from `data`, or use the global `QueryCache` callback). **This is the
   single most error-prone item.** No codemod covers it.
2. **Circular-dependency exposure from `lazy()` (Phase 3 only).** Per the notes doc, switching
   routers to `lazy()` reorders module evaluation and surfaces latent cycles as runtime
   `TypeError: Cannot read properties of undefined (reading 'optional'|'union'|...)` at
   schema/DataGraph top-level. Mitigated by doing the cycle-fixing pass *first* (Phase 0).
3. **Type-check long tail.** 1,054 call sites means inference shifts; `pnpm run typecheck` is
   the real test harness and will produce a long tail on first pass.
4. **superjson transformer relocation.** Moves from root client config into the link; server
   keeps it on `initTRPC.create`. Localized but easy to get subtly wrong (our custom
   `withSpan`-wrapped serializer must move intact).

## Phased plan

### Phase 0 — De-risk cycles up front (do before touching versions)
Independent of the upgrade; pure win and required before Phase 3.
- Run dev/build with `CIRCULAR_DEPENDENCY_PLUGIN=true` (already wired in `next.config.mjs`).
- Catalog every reported cycle. Fix by extracting shared leaf values (constants/enums/schemas)
  into zero-import leaf modules and importing leaf schemas from source, not via big-module
  re-exports — the exact patterns in the notes doc §1.
- **Exit criterion:** plugin reports zero cycles (or a known, documented allowlist).

### Phase 1 — React Query v4 → v5 (the bulk of the work)
Do this *while still on tRPC v10* if possible — `@trpc/react-query@10` supports RQ v5? **No.**
tRPC v10 pins RQ v4, so RQ v5 and tRPC v11 must land in the **same** PR/bump. Sequence the
*edits* as RQ-v5-shaped first, then flip both deps together at the end of this phase.

1. Bump `@tanstack/react-query` to `^5`, all four `@trpc/*` to `^11` in one change.
2. Run the official RQ v5 codemods to clear the mechanical changes:
   - `cacheTime` → `gcTime` (~42)
   - mutation `isLoading` → `isPending` (subset of ~230 — codemod is type-aware; verify it
     doesn't touch query `isLoading`)
   - `keepPreviousData: true` → `placeholderData: keepPreviousData` (function import)
3. **Manual, no-codemod work:**
   - Rewrite the ~66 `onSuccess`/`onError`/`onSettled` on **queries** (removed in v5).
   - `useInfiniteQuery`: add required `initialPageParam` and typed `getNextPageParam`.
   - `useQueries`: convert the 1 call to the new `{ queries: [...] }` object form.
   - Review the ~20 direct `@tanstack/react-query` imports against v5's API.
4. **Exit criterion:** `pnpm run typecheck` green, app boots, smoke-test key feeds
   (image feed, generation, model pages).

### Phase 2 — tRPC v11 API migration (config-localized)
Mostly two files: [src/utils/trpc.ts](../src/utils/trpc.ts) and [src/server/trpc.ts](../src/server/trpc.ts).
- **Transformer moves to the link.** On the client, `transformer: superjson` comes off the root
  `createTRPCNext`/`createTRPCProxyClient` config and goes **into** `httpLink`/`httpBatchLink`.
  Server keeps it on `initTRPC.create`. Our custom `withSpan('trpc:serialize:superjson', ...)`
  serializer wrapper must move intact.
- Confirm survivors (these are link/fetch-level, untouched by v11): `largeFetch`,
  `authedCacheBypassLink`, the `queryClient` Proxy singleton + per-request server QueryClient,
  the `x-trpc-method-override` POST-conversion path.
- `createNextApiHandler` from `@trpc/server/adapters/next` still exists in v11 — the
  `[trpc].ts` handler is fine.
- Routers stay **eager** in this phase. Follow the official v10→v11 guide for any remaining
  breaking changes.
- **Exit criterion:** green typecheck + app boot with eager routers. This is the
  "v11 is live, no behavior change" checkpoint.

### Phase 3 — `router.lazy()` conversion (the dev-speed payoff, incremental)
Only after Phases 0–2 are green and merged.
- Convert routers in `src/server/routers/index.ts` to `router.lazy(() => import('./x.router'))`,
  **heaviest first**: image, model, post, generation, orchestrator.
- After *each* conversion, use the diagnostic from the notes doc: edit a service that router
  reaches and confirm **no `○ Compiling /api/trpc/[trpc]`** line appears on a warm server.
- Watch for the runtime `undefined`-signature cycle errors (risk #2). If one appears, it's a
  latent cycle Phase 0 missed — fix the edge, don't paper over it.
- **Set expectations:** lazy routers remove the *extra route rebuild* (~8.8s warm), not the
  webpack re-seal floor (~4.4s warm). See notes doc §2.
- This phase is safely incremental and can land router-by-router across multiple PRs.

## Suggested PR breakdown
- **PR A (Phase 0):** circular-dependency fixes only. Mergeable on its own, no version bump.
- **PR B (Phases 1+2):** RQ v5 + tRPC v11 together (they're coupled), routers eager. The big one.
- **PR C..n (Phase 3):** one PR per batch of `lazy()` conversions, heaviest routers first.

## Effort estimate
- Phase 0: 0.5–1.5 days (depends on how many cycles the plugin surfaces).
- Phase 1: **3–4 days** — dominated by the 66 query-callback rewrites + verifying 1,000+ sites.
- Phase 2: ~0.5 day (config-localized).
- Phase 3: ~0.5 day per batch, spread out; low risk per step.

**Critical-path total ≈ 4–6 focused days**, with Phase 3 trickling in afterward. The
type-checker carries Phases 1–2; the query-callback removals and Phase-3 cycle errors are the
parts that need human eyes, not the compiler.

## Phase 3 — `router.lazy()` (branch `trpc-v11-lazy-routers`)

Converted all **92 routers** in [src/server/routers/index.ts](../src/server/routers/index.ts) to
`lazy(() => import('<path>').then((m) => m.<router>))`. Single-file change — the router files keep
their named exports (the `lazy()` overload accepts `() => Promise<TRouter>`). **Typecheck stays
clean**: `lazy()` preserves the `AppRouter` type inference via `DecorateCreateRouterOptions`'
`Lazy<Router<…>>` branch, so the client types don't collapse.

### Cycle audit (the documented hazard)
Lazy loading reorders module evaluation and can surface latent circular deps as runtime
`TypeError: Cannot read properties of undefined`. The existing `circular-dependency-plugin` block
in `next.config.mjs` only scans the **client** bundle (`!options.isServer`), so it would miss the
**server** cycles that matter here. A static audit (12 agents, all 92 routers) found **11 unique
import cycles**; **86 routers are cycle-free**.

**All 11 are harmless under lazy loading** — verified by hand for the two the audit initially
flagged "high":
- `generation.schema ↔ generation.constants` — the back-edge is **`import type`** (erased at
  runtime) → no runtime cycle → `generationSamplers` is initialized before the schema spreads it.
- `image.service ↔ user.service` — a real runtime cycle, but **neither side reads the cross-import
  at module top-level** (`deleteImageById` is used in a function body; `getBasicDataForUsers` /
  `getCosmeticsForUsers` / `getProfilePicturesForUsers` likewise). Safe in both eval orders.

The other 9 (medium/low: `stripe↔buzz↔user`, `research.router↔research.webhooks`, and several
`image.service↔{post,report,collection,cosmetic,new-order,tagsOnImageNew}.service`) are all
function-body-only cycles — harmless now, but **latent hazards**: if any of those modules later
adds module-scope code that reads a cross-import, it will throw under lazy eval. The fix pattern is
the established one ([version-ids.ts](../src/shared/data-graph/generation/version-ids.ts)): extract
the shared value into a zero-import leaf module. **Not applied** — out of scope for the lazy
conversion and unnecessary for correctness.

**No cycle fixes were required.** Still recommended before merge: a runtime smoke-test (boot +
exercise the heavy routes — image feed, model, generation, comics, stripe) since static analysis
isn't a substitute for actually loading each lazy chunk once.
