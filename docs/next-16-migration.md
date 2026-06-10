# Next.js 16 + Turbopack Migration — Working Notes / Handoff

**Branch:** `next-16-migration` (worktree: `C:/Work/model-share-next-16-migration`, branched off `next-15-migration`)
**Status:** ✅ Build-verified in the prod Docker pipeline · ⚠️ Not yet runtime-verified · 🔧 A couple of decisions open
**React:** stays on **18.3.1** (Next 16 peer-deps accept React 18, so the React 19 migration is intentionally decoupled)
**Nothing is committed** — all changes are in the working tree for review.

---

## Why we did this

The Next.js **15** production build OOMs in the Docker pipeline unless the Node heap is raised to **16 GB** (the Dockerfile default is 8192; it OOMs at 8 GB and 12 GB). Root cause is the webpack build (the "Creating an optimized production build" phase) plus ~1 GB of source maps.

Next.js **16** makes **Turbopack the default build bundler**, which is much lighter. The goal of this branch was to find out whether Next 16 + Turbopack builds within the prod-default memory budget. **It does.**

## Headline result (measured)

| | Next 15 (webpack) | Next 16 (Turbopack) |
|---|---|---|
| Docker build heap needed | **16384** (OOMs at 8192 & 12288) | **8192** ✅ (prod default) |
| Compile time (in Docker) | ~18 min | **~2.6 min** |
| TypeScript check | passes | passes (~3.4–5.4 min) |
| Final image size | **1.97 GB** | **1.15 GB**¹ |
| `output: 'standalone'` | ✅ | ✅ |

Both produced runnable images: `civitai:next15-migration-test`, `civitai:next16-migration-test` (on the local Docker daemon).

¹ The 1.15 GB figure was measured with **browser source maps OFF**. They are currently **ON** in this branch (for the error-reporting fix below), which re-inflates the image — see the source-maps decision below.

---

## Environment setup for a fresh worktree (do this first!)

`git worktree add` does **not** bring along gitignored or submodule content. After checking out this worktree you must:

```bash
# 1. Initialize the event-engine-common git submodule (imported as ../../../event-engine-common/*).
#    Without it the build fails type-check: "Cannot find module '.../event-engine-common/feeds'".
git submodule update --init --recursive

# 2. Provide the gitignored .env (needed for NEXT_PUBLIC_* build-time inlining / page-data collection).
cp ../model-share-next-15-migration/.env .env

# 3. Install deps (Next 16 etc.).
pnpm install
```

## How to build / verify

```bash
# Local Turbopack build (fast iteration). Fits 8 GB heap.
SKIP_ENV_VALIDATION=1 IS_BUILD=true NODE_OPTIONS="--max_old_space_size=8192" pnpm build

# Typecheck
pnpm typecheck            # passes clean

# Full prod-parity build (the real pipeline test). Note: prod default heap.
DOCKER_BUILDKIT=1 docker build --build-arg NODE_BUILD_MEM=8192 -t civitai:next16-migration-test .
```

`next build` in v16 = Turbopack by default (no flag). `next build --webpack` is the opt-out.

---

## Changes made (manifest)

Dependency / config:
- `package.json` — `next`, `eslint-config-next`, `@next/bundle-analyzer` → `^16.2.7`; `lint` script `next lint` → `eslint ...` (Next 16 removed `next lint`).
- `next.config.mjs` —
  - Added `turbopack: {}` (Next 16 **errors** on a `webpack` config with no `turbopack` config). The OTel `webpack.ignoreWarnings` block is kept for the `--webpack` fallback; Turbopack ignores it, and those warnings don't appear because the OTel packages are in `serverExternalPackages`.
  - Removed the `eslint: { ignoreDuringBuilds }` key (unsupported in 16).
  - `productionBrowserSourceMaps: true` (currently on — see decision below).
- `tsconfig.json`, `next-env.d.ts` — auto-reconfigured by Next 16 (`jsx: react-jsx`).
- `pnpm-lock.yaml` — updated.

Code fixes for Turbopack compatibility:
- `src/pages/api/trpc/[trpc].ts` — typed the `withAxiom` handler params explicitly (`async (req: NextApiRequest, res: NextApiResponse)`) so Next 16's stricter route types resolve the API-handler overload.
- `src/components/CivitaiLink/CivitaiLinkProvider.tsx` — `SharedWorker` URL `'/src/workers/...'` → relative `'../../workers/...'` (Turbopack doesn't support server-relative worker imports).
- CSS modules — Turbopack rejects bare `:global .x` / `:global { ... }`. Converted switch-form to function form `:global(.x)` (wrapping nested global classes like tiptap's `.is-editor-empty`) and hoisted global-keyframes `animation` declarations out of `& :global { }` blocks. Files: `CommentForm.module.scss`, `EditResourceReview.module.scss`, `RichTextEditorComponent.module.scss`, `Training/Form/TrainingImagesCaptionViewer.module.scss`, `Cards/Cards.module.css`, `Games/LevelProgress/LevelProgress.module.scss`, `HomeContentToggle/HomeContentToggle.module.css`, `pages/comics/project/[id]/ProjectWorkspace.module.scss`.
- `src/styles/globals.css` — added `@keyframes pulse-outline` (moved out of ProjectWorkspace's `:global { @keyframes }` block; it's referenced by an inline JS style in `PanelCard.tsx`, so it must be a global keyframes).

typed-scss-modules removal (the biggest change):
- Turbopack's TS-aware resolver bundles the committed adjacent `*.module.scss.d.ts` files as runtime modules and panics parsing their `declare const` (`Expected ';', '}' or <eof>`). Verified: **0 of 3528** chunks had a same-name `.map` sibling pattern; this affected every CSS-module import with a `.d.ts` sibling.
- Fix: **`git rm`'d all 151 `*.module.scss.d.ts`** and added ambient `declare module '*.module.scss' / '*.module.css'` in **`src/types/css-modules.d.ts`**. Safe because every CSS-module import in the repo is a **default import** (0 named imports).
- **Do NOT run `pnpm generate-types`** (typed-scss-modules) on this branch — it would regenerate the `.d.ts` files and reintroduce the breakage. It is *not* wired into husky/CI, so it won't happen automatically.

Client error reporting (`applySourceMaps`):
- `src/server/utils/errorHandling.ts` — the client-error → Axiom source-mapping utility (`/api/application-error` → `applySourceMaps`) assumed the webpack convention that a chunk `X.js`'s map is `X.js.map`. Turbopack names the map with a **different hash**, linked only via the in-file `//# sourceMappingURL=` comment, so the utility silently produced un-resolved stacks.
- Fix: added `loadSourceMapContent()` (reads the chunk, follows its `sourceMappingURL`, with a `<chunk>.map` webpack fallback) and `normalizeSourcePath()` (strips `webpack://_N_E/` and `turbopack:///[project]/` prefixes → clean `src/...`). Bundler-agnostic.
- Verified end-to-end against real Turbopack output: a simulated browser frame `…/_next/static/chunks/0--qyq2uw0ftr.js:1:561` resolves to `src/components/InfoPopover/InfoPopover.tsx:2:0`. Requires `productionBrowserSourceMaps: true` so the maps exist.

Dev-only hydration mismatch (`ReactQueryDevtools`):
- **Symptom:** every page (dev only) threw `Did not expect server HTML to contain a <div> in <div>` → "the entire root will switch to client rendering". Component stack named `ReactQueryDevtools` at [_app.tsx](../src/pages/_app.tsx) (`{isDev && <ReactQueryDevtools />}`).
- **Root cause:** `@tanstack/react-query-devtools@5.101.0`'s `ReactQueryDevtools` unconditionally returns `<div class="tsqd-parent-container">` and mounts its UI imperatively in a `useEffect` — it is not SSR-safe. The server emits that container div; under Turbopack the client doesn't reproduce it during hydration, so React flags it as an unhydrated tail node and bails the whole root to client rendering. Production is unaffected (gated by `isDev`); it was a webpack-vs-Turbopack dev-SSR difference.
- **Fix:** load it via `next/dynamic(..., { ssr: false })` so it never participates in SSR/hydration. Verified `/` and `/models` hydrate with **0** errors after the change (Playwright console capture against the dev server).

Double-mounted layout (`CAConsentManager`) — **the big one**:
- **Symptom:** on **every** page the entire app layout rendered **twice, stacked** — one frozen copy (orphaned server DOM, no content) above a live copy that actually loaded data. Every tRPC query fired **twice**. Region-dependent: only reproduced when the visitor's region requires a consent prompt (e.g. localhost resolving to **US:CA**).
- **Root cause:** [`ThirdPartyConsentProvider`](../src/components/Consent/ThirdPartyConsentProvider.tsx) loaded `CAConsentManager` via `next/dynamic` (ssr left at default `true`) **and that component wraps the whole app as `children`**. Server renders `CAConsentManager(children)` into the SSR HTML; on the client the `CAConsentManager` chunk is fetched **async** (Turbopack dev) and isn't ready at hydration, so its children are momentarily absent → whole-subtree hydration mismatch → React re-mounts the app fresh and **orphans the server DOM** (the duplicate). Non-CA visitors hit `return <>{children}</>` (no dynamic) → clean. Worked on next-15/webpack because webpack had the chunk available synchronously at hydration; Turbopack dev loads it truly async.
- **Fix:** **static-import** `CAConsentManager` (it's a context provider; `ConsentBanner` is currently commented out). Keeps `ssr: true` correctness while guaranteeing the code is present synchronously at hydration. Verified: `/models` went from `headers=2` → `headers=1`, queries no longer doubled.
- **General rule (Turbopack dev):** a `next/dynamic` component that **wraps the whole app as `children`** will async-load its chunk and re-mount everything below it. **Leaf** dynamics are fine; **wrapper** dynamics are the trap. Two instances existed — `ReactQueryDevtools` and `CAConsentManager` — both now fixed. If adding a region-/flag-gated wrapper provider, import it statically (lazy-load only leaf UI inside it).

SharedWorker TypeScript scripts not compiled (Turbopack) — **FIXED via prebuilt bundles**:
- **Symptom:** console shows `Failed to fetch a worker script` (×3). Both SharedWorkers are affected: signals ([`useSignalsWorker.ts`](../src/utils/signals/useSignalsWorker.ts) `new SharedWorker(new URL('./worker.ts', import.meta.url), { type: 'module' })`) and Civitai Link ([`CivitaiLinkProvider.tsx`](../src/components/CivitaiLink/CivitaiLinkProvider.tsx) `civitai-link.worker.ts`). Both use the `@okikio/sharedworker` wrapper.
- **Root cause:** known Turbopack bug — [vercel/next.js#74842 "[Turbopack] SharedWorker TypeScript scripts not compiled"](https://github.com/vercel/next.js/issues/74842). Turbopack does not compile `.ts` **SharedWorker** entry scripts (`.js` works); the URL resolves to an uncompiled script, so the browser can't fetch it. webpack compiled them fine, so this is a Turbopack regression for live signals + Civitai Link.
- **Impact: CONFIRMED broken in the prod build too** (verified by inspecting `next build` output, 2026-06-05). The prod client chunks contain `new SharedWorker("/_next/static/media/worker.<hash>.ts")` / `civitai-link.worker.<hash>.ts` — a **`.ts` URL** — but `.next/static/media/` is **not emitted at all** (the files exist only under `.next/dev/` as raw `.ts`). So in production those URLs 404 → `Failed to fetch a worker script`. Breaks **live signals** (metrics, generation updates, notifications) and **Civitai Link**. The build exits 0 — success does NOT mean the workers run. This is a **release blocker**, not a dev-only issue.
- **Fix (implemented):** pre-bundle each worker with esbuild to `public/workers/*.js` and instantiate via a **static path** instead of `new URL(import.meta.url)`, bypassing Turbopack's worker handling entirely.
  - [`scripts/build-workers.mjs`](../scripts/build-workers.mjs) — esbuild bundles `src/utils/signals/worker.ts` → `public/workers/signals.worker.js` and `src/workers/civitai-link.worker.ts` → `public/workers/civitai-link.worker.js`. Classic/IIFE format; bundles all deps (signalr/socket.io/uuid/idb-keyval); resolves the `~/` alias via tsconfig; injects `NEXT_PUBLIC_*` env + `SKIP_ENV_VALIDATION` via `define: { 'process.env': … }` so the standalone bundle doesn't choke on `~/env/client` (which validates all public env on import).
  - `package.json` — `build:workers` script + `predev`/`prebuild` hooks (and `dev-debug`/`build:dev`) so bundles regenerate before `pnpm dev` / `pnpm build`. **Caveat:** these are npm lifecycle hooks — if the server is launched outside `pnpm dev` (e.g. the dev-server skill spawning `next dev` directly), run `pnpm build:workers` once first.
  - Instantiation: [`useSignalsWorker.ts`](../src/utils/signals/useSignalsWorker.ts) → `new SharedWorker('/workers/signals.worker.js')`; [`CivitaiLinkProvider.tsx`](../src/components/CivitaiLink/CivitaiLinkProvider.tsx) → `new SharedWorker('/workers/civitai-link.worker.js')`. `type: 'module'` dropped (classic worker).
  - `/public/workers/` is gitignored (build output).
  - **Verified:** after a dev-server restart, both worker scripts serve and the `Failed to fetch a worker script` errors are gone (signals + Civitai Link working). `prebuild` means the prod Turbopack build emits them too.

---

## Status scorecard

✅ **Verified**
- Builds in the prod Docker pipeline at the 8 GB default; `pnpm typecheck` clean; standalone output valid.
- Turbopack config, the trpc/withAxiom type fix, the `.d.ts`/ambient-types fix, and the `applySourceMaps` fix.

⚠️ **Partially runtime-verified (dev)**
- **Dev smoke-test done for `/` and `/models`:** after the `ReactQueryDevtools` and `CAConsentManager` fixes, both render a **single** layout and hydrate with **0** errors (incl. the US:CA consent path). Other routes / full click-through still pending.
- **The 8 CSS files are not visually verified** — `:global` rewrites + keyframes moves can have subtle styling regressions. Check: Buzz purchase, comment/rich-text editors, training captions, level progress, cards, home toggle, comics workspace.
- **Playwright tests** not run.

✅ **Fixed & dev-verified**
- **SharedWorkers (signals + civitai-link)** — were broken under Turbopack ([next.js#74842](https://github.com/vercel/next.js/issues/74842)); now pre-bundled to `public/workers/*.js` and instantiated by static path. Worker-fetch errors gone after restart. See the SharedWorker note above. Still **TODO: confirm on the prod/standalone image** (prebuild emits the bundles, but runtime on the built image not yet checked).

🔧 **Open decisions (team's call)**
- **typed-scss-modules → loose ambient types** — lose per-class CSS typing across the codebase. Ratify or find an alternative (e.g. a Turbopack-compatible typing approach).
- **Source maps vs. image size** — the small 1.15 GB image was with browser source maps OFF; they're ON now for error reporting (re-inflates the image via `.next/static` maps). Pick one: small image *or* source-map-backed error logging.
- **`middleware` → `proxy`** rename (Next 16 deprecation; still works, just warns).
- **React 18 → 19** (deferred; known follow-up).

---

## Suggested next steps (in order)

1. Run the built app (dev server or the standalone build) and click through it — especially the components with CSS changes and Civitai Link.
2. Visually verify the 8 CSS files (e.g. via the `component-preview` skill, dark + light).
3. Run the Playwright suite.
4. Decide the source-maps-vs-image-size and typed-scss-modules questions.
5. Do the `middleware` → `proxy` rename to clear the deprecation.
6. Commit + open PR.

## Reference

`serverSourceMaps` note: `experimental.serverSourceMaps` is **webpack-only** — Turbopack ignores it (no napi `ProjectOptions` field; zero refs in `next/dist/build/turbopack-build/`). Under Turbopack, `productionBrowserSourceMaps` is the single lever and it drives **both** client and server map emission (valid v3 with `sourcesContent`, ~563 MB client + ~758 MB server, at no measurable build-time/memory cost).
