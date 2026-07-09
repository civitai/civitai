# tRPC route dev-recompile bottleneck — findings & tRPC v11 upgrade notes

> Context for whoever picks up the **tRPC v10 → v11 upgrade**. This summarizes a
> session that investigated slow `next dev` recompiles and prototyped a fix.
> Self-contained — no prior context needed.

## TL;DR

- **Symptom:** editing *any* file under `src/server/services/*` triggers a recompile of
  the entire `/api/trpc/[trpc]` route — **~6,255 modules, ~21s cold / ~8.8s warm route
  rebuild** — because `pages/api/trpc/[trpc].ts` → `appRouter` (`src/server/routers/index.ts`)
  **statically imports all ~93 routers → all their services** into one compilation unit.
- **Root cause is architectural, not zod/schema init.** (85 schema files / ~1,110 zod
  constructors were measured as a non-factor — zod construction is cheap.)
- **The clean fix is tRPC v11 lazy routers** (`router.lazy(() => import('./x.router'))`), one
  line per router in `index.ts`. This defers each router + its service subgraph into its own
  chunk, so editing a service only rebuilds that chunk, not the whole route.
- **We proved the mechanism works** by manually lazy-loading one service in v10 (see below),
  then **reverted it** — manual per-service `await import()` is too invasive for full coverage
  and the real win is the v11 router-level version.

## What was verified (v10 manual prototype)

We converted every importer of `generation.service.ts` (router + controllers + services it's
reached through) from static imports to lazy `await import('...generation.service')` at call
sites. Result, confirmed in dev logs:

| Edited file | `Compiling /api/trpc/[trpc]` line? | Meaning |
|---|---|---|
| `generation.service.ts` (converted → lazy) | **absent** | detached from route's eager graph ✅ |
| `image.service.ts` (unconverted → eager) | **present** (`✓ in 8.8s`) | still wired into the route |

**Diagnostic signature** (use this to verify any detachment): edit the service on a *warm*
server. If **no `○ Compiling /api/trpc/[trpc]`** line appears, it's detached.

## Caveats — read these before the v11 upgrade

### 1. ⚠️ Lazy-loading reorders module evaluation → can EXPOSE latent circular deps
This is the biggest risk for the v11 upgrade. Switching routers to `lazy()` changes which
module first triggers a given dependency cluster's evaluation. A cluster with a **pre-existing
circular import** that only worked due to a lucky eval order will start throwing at runtime:

```
TypeError: Cannot read properties of undefined (reading 'optional' | 'union' | ...)
```
…at **module-top-level** schema / `DataGraph` construction.

We hit exactly this: detaching `generation.service` surfaced a latent cycle in the data-graph:
`src/shared/data-graph/generation/*-graph.ts → common.ts → config/index → config/workflows.ts → *-graph.ts`
(`config/workflows.ts` imported version-id constants *from* the graph files, while the graphs
import helpers *back* from it — a bidirectional edge).

**Because v11 lazy routers shift the eval order of *every* router, expect MORE of these to
surface across the whole codebase, not just the data-graph.** Plan for a cycle-fixing pass.

**Mitigations / fix patterns:**
- **Enable the circular-dependency plugin first.** `next.config.mjs` already contains a
  commented-out `circular-dependency-plugin` block; run with `CIRCULAR_DEPENDENCY_PLUGIN=true`
  to map cycles at build time *before* they bite at runtime. Do this up front.
- **Break bidirectional edges by extracting shared leaf values** (constants, schemas, enums)
  into zero-import leaf modules. Example fix from this session: moved `klingVersionIds` /
  `nanoBananaVersionIds` / `viduVersionIds` out of the `*-graph.ts` files into a new leaf
  `src/shared/data-graph/generation/version-ids.ts`; both the graphs and `config/workflows.ts`
  import the leaf → edge becomes one-directional. (Graph files re-export the consts so existing
  handler imports keep working.)
- **Import leaf schemas from their source, not via a big module's re-export.** `kling-graph`
  imported `imageValueSchema` through `common.ts`'s re-export (`common` is in the cycle); fixed
  by importing directly from the leaf `media-schemas.ts`.

### 2. The re-seal floor — lazy routers won't make dev recompiles instant
Next.js webpack dev **re-seals the entire server compilation on any server edit** (you'll see a
bare `Compiled in Xs (N modules)` with *no* route name). There's an irreducible floor
(~4.4s warm in this codebase) regardless of how few modules changed. Lazy-loading removes the
*extra route rebuild* on top of the floor (the 8.8s), not the floor itself. Set expectations:
v11 lazy routers reduce per-edit cost meaningfully but don't eliminate it. If the floor itself
becomes the bottleneck, that's the point to revisit Turbopack (different incremental engine, no
re-seal) — see §4.

### 3. The `(N modules)` count in dev logs is NOT a per-edit delta
It's the **total** module count of the current compilation, and it grows as you visit more
pages in a session. Two recompiles showing `6255` vs `11888` modules are **not comparable** if
you've loaded different pages in between. To compare, hold session state constant and use
**(a)** presence/absence of the `Compiling /api/trpc/[trpc]` line and **(b)** wall-clock time.

### 4. Turbopack was explored and parked (alternative path, not pursued)
`next dev --turbo` on this repo boots but hits a series of incompatibilities. If revisited,
the known blockers are:
- SharedWorker imported via **server-absolute path** (`new URL('/src/workers/...', import.meta.url)`)
  — Turbopack needs a **relative** path (`'../../workers/...'`). Works in webpack too.
- **CSS Modules `:global` nested inside native CSS nesting** in `*.module.css` — Turbopack's
  Lightning CSS parser rejects it (`css-loader` tolerates it). Fix: don't nest `:global {}`;
  reference global keyframes by plain name (they resolve if defined outside the module).
- **`@civitai/client` `ERR_UNSUPPORTED_DIR_IMPORT`** — needs `transpilePackages: ['@civitai/client']`.
  But that also makes the cold compile *slower* (Turbopack then transpiles the large generated client).
- Net: cold compile was not faster; warm was. Parked in favor of the v11 path.

### 5. Hot-path first-request latency
A lazily-loaded module pays a one-time chunk compile on the **first request** to its endpoint
after a server (re)start. Harmless in dev (one-time blip). If lazy routers are ever weighed for
**prod cold-start**, `image.service` (the feed hot path, ~7.9K lines) is the one to watch.

## tRPC v11 upgrade specifics

- Current versions (all need bumping together): `@trpc/server`, `@trpc/client`, `@trpc/next`,
  `@trpc/react-query` — all `^10.45.0`.
- The dev-speed payoff is **`router.lazy()`** — wire it in `src/server/routers/index.ts`,
  ideally heaviest routers first (image, model, post, generation, orchestrator).
- Follow the official v10→v11 migration guide for breaking changes (transformer config moved to
  the link, etc.) — the `superjson` transformer setup in `src/server/trpc.ts` and the client
  links will need updating.
- **Recommended sequence:** (1) enable circular-dependency plugin & fix all reported cycles;
  (2) do the v11 API migration with routers still eager and confirm green typecheck + app boot;
  (3) only then convert routers to `lazy()` incrementally, watching for the runtime `undefined`
  signature from §1 as each is converted.

## Quick reference — files touched in the (reverted) prototype
Server importers of `generation.service` that were converted: `generation.router.ts`,
`model.controller.ts`, `model-version.controller.ts`, `recommenders.controller.ts`,
`model.service.ts`, `post.service.ts`, `orchestrator/common.ts`, `orchestration-new.service.ts`,
`orchestrator/queue-limits.ts`, `models.search-index.ts`. Type-only client imports and
`pages/api/**` importers were left static (separate bundles; don't affect the tRPC route).
Watch for **relative-path** importers (`../services/...`) — a `~/server/...` grep misses them.
