##### LIBC VARIANT
#
# Which C library the image is built on and runs on. `musl` (the default) is the production
# image: Alpine, exactly as before this build-arg existed. `glibc` builds the SAME source on
# Debian bookworm-slim instead, for a measurement of the allocator/memcpy share of the Prisma
# query engine's CPU (the engine is a native library loaded into the Node process, so it uses
# whichever libc the image has). Nothing deploys a `glibc` image by default; it has to be built
# on purpose with `--build-arg LIBC=glibc` (or `--opt build-arg:LIBC=glibc`) and tagged apart.
#
# Only the stage selected below is built: BuildKit skips stages nothing references, so a
# default (musl) build never pulls the Debian base. Its layers are the same instructions on the
# same base as before, except the deps stage's pnpm store cache, which is now per LIBC (see
# there).
#
# Both variants pin the SAME Node patch (src/__tests__/node-version-consistency.test.ts), but
# libc is NOT the only difference between them. The Node binary itself is a different build:
# the Alpine image ships a separate musl build of Node (from Node's unofficial-builds, or
# compiled from source), the Debian image ships the official glibc release build. Both bases
# are pinned by digest, but the glibc runtime adds packages from an unpinned `apt-get install`
# (the musl runtime adds none). And the userland (busybox vs coreutils, the OpenSSL build)
# differs. So whole-process CPU is not a libc comparison; only the CPU of the Prisma engine's
# own threads is.
#
# Prisma's generator uses its default `native` binary target, and `prisma generate` runs in
# the deps stage on the selected base, so each variant generates (and ships) the engine for its
# own libc: linux-musl-openssl-3.0.x or debian-openssl-3.0.x. No `binaryTargets` change is
# needed, and the musl image does not carry a second engine. Native npm packages with per-libc
# builds (sharp's @img/sharp-*, Next's swc, esbuild) resolve to the variant for the libc they are
# installed and traced on, for the same reason: the deps, builder and runner stages always share
# one libc. Their install-script output is kept apart too (the pnpm store is per LIBC, below).
ARG LIBC=musl

FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base-musl
RUN apk add --no-cache libc6-compat

# openssl: Prisma detects the OpenSSL version to pick its engine and loads libssl at runtime;
# the slim image ships neither (no libssl3 package). adduser is already in the slim image; it
# is listed so the runner stage's `addgroup`/`adduser` lines, shared with Alpine, do not rely
# on that.
FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS base-glibc
RUN apt-get update && \
    apt-get install -y --no-install-recommends openssl ca-certificates adduser && \
    rm -rf /var/lib/apt/lists/*

##### DEPENDENCIES

FROM base-${LIBC} AS deps
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

# Install dependencies. Workspace manifests (root + pnpm-workspace.yaml + packages/*)
# and the lockfile go first; the store cache mount lets pnpm reuse downloads even when
# this layer is invalidated. `postinstall` runs db:generate, which needs the Prisma
# schema (now in packages/civitai-db-schema) and the scripts. Copying all of packages/
# also ensures --frozen-lockfile sees every workspace project.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY patches ./patches

# The store cache is per LIBC. pnpm keeps the post-install state of every package whose build
# script ran (its side-effects cache) in the store, keyed by platform, arch, Node major and the
# dependency graph, but NOT by libc. With one store for both variants, a variant that misses
# the cache runs e.g. @prisma/engines' postinstall (which downloads the engine for the libc it
# runs on) and stores the result, and the other variant then imports that package as already
# built and skips its script. Separate stores make that impossible. `ARG LIBC` must be declared
# in this stage: a global ARG is not visible inside a stage, and without it `${LIBC}` expands
# to "" and both variants would share one id again. (It is also in the install's environment,
# where node-gyp-build reads `LIBC` to pick a prebuild; the value is the base's real libc.)
# The musl id is `pnpm-store-musl`, not the old `pnpm-store`: there is no conditional in a
# Dockerfile that keeps one variant's literal while changing the other's, and a fresh musl id
# also guarantees production never reuses anything written to the shared store. The cost is
# one cold store (re-download, re-run of the allowed build scripts) per build root.
ARG LIBC
RUN --mount=type=cache,id=pnpm-store-${LIBC},target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

##### BUILDER

# FROM deps (NOT a fresh node image) so the builder INHERITS the complete node_modules from the install stage
# — including the nested packages/*/node_modules pnpm creates for each workspace package's OWN deps (e.g.
# @civitai/db-schema's `kysely`). The old approach copied only the ROOT node_modules, which dropped those
# nested trees; since the workspace packages are consumed as SOURCE, `next build`'s TypeScript pass then
# couldn't resolve their deps and failed with "Cannot find module 'kysely'". Mirrors apps/auth/Dockerfile,
# whose build stage is also `FROM deps`. corepack/pnpm and the postinstall-generated Prisma client are
# inherited too, so they don't need re-running here.
FROM deps AS builder
ARG NEXT_PUBLIC_IMAGE_LOCATION
WORKDIR /app

# Overlay the full source. node_modules is dockerignored, so this never clobbers the node_modules inherited
# from deps (root OR nested).
COPY . .
# schema.prisma is generated (gitignored) so `COPY . .` doesn't carry it. It's inherited via FROM deps, but
# re-copy explicitly so the build never depends on that inheritance subtlety.
COPY --from=deps /app/packages/civitai-db-schema/prisma/schema.prisma ./packages/civitai-db-schema/prisma/schema.prisma

ENV NEXT_TELEMETRY_DISABLED=1

# Node heap for the Next.js build. Default raised 6144 -> 8192: a cold build
# (no warm .next/cache) peaks higher than an incremental one and OOMs at 6 GB on
# newer commits. Build-arg so a builder with more memory can raise it further.
ARG NODE_BUILD_MEM=8192
# Commit SHA of the source being built. Passed by the Tekton build (the shared
# buildkit script forwards COMMIT_SHA → this build-arg); read by
# scripts/bundle-budget.mjs --json so the served snapshot is commit-attributable.
# Defaults empty (commit:null) when built outside CI.
ARG SOURCE_COMMIT=""
ENV SOURCE_COMMIT=$SOURCE_COMMIT
# "1" skips `next build`'s own TypeScript pass (read in next.config.mjs). Empty by default, so
# every build that does not pass it type-checks. Only the PR-preview build passes it, because
# that pipeline runs the full `tsc` in a parallel task already. A build ARG is visible to the RUN
# below as an environment variable; it is deliberately NOT an ENV, so it never reaches the image.
ARG CIVITAI_SKIP_BUILD_TYPECHECK=""
# This cache is deliberately shared by both LIBC variants (its id is its target path): it holds
# Next's JS-level build caches, not native artifacts, and the Turbopack filesystem cache for
# builds (`turbopackFileSystemCacheForBuild`) is not enabled. If that changes, give it a
# per-LIBC id like the pnpm store above. The test pins the list of cache mounts and which are
# per-LIBC, so a new one has to make the same choice.
RUN --mount=type=cache,target=/app/.next/cache \
    SKIP_ENV_VALIDATION=1 IS_BUILD=true NODE_OPTIONS="--max_old_space_size=${NODE_BUILD_MEM}" pnpm run build

# Server-graph module identity — a HARD gate, deliberately unlike the report-only
# bundle budget below.
#
# A module's top-level state is per RUNTIME module, and the bundler decides how many
# runtime modules a source file becomes: Turbopack inlines `src/server/logging/client.ts`
# into 14 of them in this build. Anything that must be a process-wide singleton therefore
# has to be reached through `globalThis`. Nothing else we run can see a violation — `tsc`
# checks one source file, eslint reads source, and Vitest loads a module once, so a
# module-scope singleton looks like a singleton everywhere except in the emitted output.
# That is how the OTel logs bridge shipped delivering 1.3% of its records with a green
# typecheck, a green lint and a green suite.
#
# Runs here for the same reason the budget does: `.next` exists in this stage, so there is
# no second build. It reads the emitted `.js.map` `sources` to attribute code to source
# modules, and exits 2 (not 0) if it finds no maps — a scan that can see nothing must not
# report health. Cheap: a few seconds of file reads.
RUN node scripts/check-server-graph-singletons.mjs

# Compiled-branch gate — the second HARD build-output gate, and for the same reason as the
# one above: nothing that reads SOURCE can see this class of defect.
#
# Release 5.1.18 shipped `resolveStoreVisibilityScopeUninstrumented` as
# `async function S(e){if(await p(e))return"full"}` — two of its three returns were absent
# from the emitted chunk, so it returned `undefined` for every non-privileged caller. One
# read path defaulted that to `'full'` and served the whole App-store catalog to anonymous
# callers; the other defaulted it to `'none'` and showed the intended cohort an empty
# store. The TypeScript was correct throughout, so a 75-test unit suite, an integration
# suite driving the real feature-flag client, and four rounds of review were all
# structurally incapable of catching it (civitai#3983).
#
# This reads the emitted `.js.map` `mappings` and asserts that each watched fail-closed
# branch still has a representation in the output. Same placement rationale as the gate
# above: `.next` exists in this stage, so there is no second build; and it exits 2 (not 0)
# when it cannot observe its input. Adding a gate is one entry in
# `scripts/compiled-branch-watchlist.mjs`.
#
# HARD as of the Next 16.3.1 bump. It shipped `--warn-only` for exactly one build, because
# 16.3.0's Turbopack value analyzer modelled a bare `return someAsyncFn()` tail call as
# `Promise<Promise<T>>` — always truthy — so an awaiting caller was analysed as always-true
# and every statement after the resulting conditional was eliminated as dead code
# (vercel/next.js#96601, backported as #96675, shipped in 16.3.1). With 16.3.0 pinned the
# gate genuinely failed every production build, and a permanently-red gate is worse than no
# gate. With 16.3.1 pinned the build satisfies it, so the downgrade is removed in the same
# commit as the bump: the gate's strictness now tracks the toolchain, and a revert of the
# bump turns this red instead of silently passing.
RUN node scripts/assert-compiled-branches.mjs

# Bundle-size budget (report-only during the soak). Next 16 (Turbopack) emits
# opaque hashed chunks and removed per-route build stats, so scripts/bundle-budget.mjs
# parses .next/build-manifest.json to reconstruct per-page First Load JS (brotli)
# + a shared-by-all-pages figure. Runs here because .next exists in this stage
# and the build already happened — no duplicate build. `|| true` keeps it
# report-only (numbers print to the build log); to GATE, add `--gate` to the
# node invocation and replace `|| true; cat ...` with `; rc=$?; cat ...; exit $rc`
# so a budget breach fails the image build.
# The report is also written to /app/bundle-budget.txt and COPYied into the
# runner image so the Tekton bundle-comment task can surface it on the PR
# (kubectl exec ... cat) without a duplicate build.
# `--json` additionally writes /app/bundle-budget.json (machine-readable per-route
# First Load JS) — served at /api/internal/bundle-budget for the perf-trend
# baseline job + the future PR bundle-regression gate.
# Invoke node directly (not `pnpm run size`) so pnpm's lifecycle preamble
# (`> model-share@… size /app`) stays out of the report/comment.
RUN node scripts/bundle-budget.mjs --json > /app/bundle-budget.txt 2>&1 || true; cat /app/bundle-budget.txt

# Server source maps (.next/server/**/*.js.map) are emitted by the build
# (productionBrowserSourceMaps -> turbopackSourceMaps) but @vercel/nft does NOT
# trace sibling .map files into .next/standalone, so they never reach runtime.
# Collect ONLY the server-chunk maps into a structure-preserving staging dir.
# These are NOT shipped in the runtime image (they added ~761 MB to every prod
# pod — too much for a debug aid). Instead they are published as a separate,
# fetched-on-demand `maps` artifact image (see the `maps` target below + the
# Tekton maps-publish step), keyed by the same tag as the runtime image, so a
# `.cpuprofile` captured from image X can be de-minified offline against X's maps.
# Build-chunk map filenames are content hashes (no spaces/newlines), so the
# newline-delimited `tar -T -` files-from list is safe and works under both GNU tar
# and busybox tar (alpine). `tar | tar` preserves the dir structure
# (e.g. chunks/<hash>.js.map) so each map keeps its .next/server-relative path.
# (Comments must stay OUTSIDE the RUN: Docker collapses the \-continuations into one
# line, where an inline `#` would swallow the rest of the command.)
RUN mkdir -p /app/server-maps && \
    cd /app/.next/server && \
    { find . -name '*.js.map' | tar -cf - -T - | tar -xf - -C /app/server-maps || true; } && \
    echo "Staged $(find /app/server-maps -name '*.js.map' | wc -l) server source maps ($(du -sh /app/server-maps | cut -f1))"

# Duplicate server chunks -> one-line re-export stubs, in the SHIPPED tree only.
#
# Turbopack emits the same server chunk under many file names (the copies differ only in their
# trailing sourceMappingURL comment), and its Node runtime loads chunks with `require(<path>)`.
# Node caches by path, so every copy is compiled and its source kept on the heap. The script
# replaces each duplicate with `module.exports=require("./<canonical>.js")`: every existing
# reference still names a real file, and the runtime receives the canonical's own module array
# (it registers factories by module id, so module identity is unchanged). See the script header.
#
# Runs after the gates and the map staging above, which read `.next/server`; this touches only
# `.next/standalone/.next/server`. Exits 1 if a stub does not resolve to a real chunk, 2 if it
# finds no chunks — both fail the build.
RUN node scripts/dedupe-server-chunks.mjs /app/.next/standalone/.next/server

##### MAPS ARTIFACT (fetched on-demand; NOT part of the runtime image)
#
# A minimal `FROM scratch` image holding ONLY the staged server source maps,
# under /server-maps mirroring the .next/server tree. Published to a sibling
# registry repo (ghcr.io/civitai/civitai-web-maps:<same-tag>) by the Tekton
# maps-publish step using the SAME ghcr credentials as the runtime push — no new
# secrets. It shares every builder layer with the runtime build, so building this
# target is a buildkit cache hit plus one small layer; it is never pulled by a
# running pod. The cpuprofile resolver fetches it on demand keyed by image tag
# (scripts/resolve-cpuprofile.mjs --image ...).
FROM scratch AS maps
COPY --from=builder /app/server-maps/ /server-maps/

##### RUNNER

# The runtime bases, one per LIBC (see the top of this file). The musl one is the bare Alpine
# image, exactly what the runner stage used before (no libc6-compat: only the deps stage has it).
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime-musl
FROM base-glibc AS runtime-glibc

FROM runtime-${LIBC} AS runner
WORKDIR /app

ENV NODE_ENV=production

# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
# Bundle-budget report (report-only) — surfaced on the PR by the Tekton
# bundle-comment task via `kubectl exec ... cat /app/bundle-budget.txt`.
COPY --from=builder /app/bundle-budget.txt ./bundle-budget.txt
# Machine-readable per-route First Load JS — served at /api/internal/bundle-budget
# (main is read by the perf-trend baseline job + the future PR regression gate).
COPY --from=builder /app/bundle-budget.json ./bundle-budget.json

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# The standalone tRPC server (`node -- trpc-server/server.cjs`): plain CommonJS that serves the
# tRPC, probe and metrics routes from the compiled route modules above, without the Next router.
# Only the three runtime files; its tests and parity harness stay out of the image. The default
# CMD below is unchanged — this is only used where something runs that command instead.
# `served-pages.cjs` is required by server.cjs at module scope, so the boot-graph gate below
# fails the build if it is missing here.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/trpc-server/server.cjs /app/scripts/trpc-server/next-compat.cjs /app/scripts/trpc-server/served-pages.cjs ./trpc-server/
# NOTE: server source maps are intentionally NOT copied into the runtime image.
# They are published as the separate `maps` target above (fetched on-demand by
# the cpuprofile resolver), keeping the prod pod lean (~761 MB smaller).

# Boot-graph gate — the first gate in this file that runs against the RUNTIME filesystem
# rather than the build tree, and the only one that can see this class of defect.
#
# `output: 'standalone'` ships the subset @vercel/nft traced, not node_modules. nft resolves a
# bare specifier under `require`/`default`; Node (>= 22.10) additionally honours `module-sync`
# for a CJS `require`. When a package's `exports` map points those at different files the build
# traces one and the process asks for the other: the build is green, the source is correct,
# every gate above passes, and the container crash-loops before the first line of application
# code. That is exactly what the Next 16.3.1 bump did via @swc/helpers 0.5.15 -> 0.5.23
# (civitai#4075) — a green PR whose only red signal was the preview deploy.
#
# It MUST run here and not in the builder: `/app` in this stage is byte-for-byte what ships,
# whereas the builder's complete `/app/node_modules` sits above `.next/standalone` on the
# resolution path and can satisfy a require the image cannot. Cheap (~2s) and needs no env: it
# reads the GENERATED server.js for the specifiers that process requires at module scope and
# loads them in a child rooted at `/app`. Nothing is hardcoded — no package, version,
# virtual-store path or patch hash — so it keeps covering this after the next bump.
#
# Exits 2 (not 0) when it cannot observe its input, same rule as the build-output gates above.
# The script is removed in the same layer chain so it is not part of the served image.
#
# The standalone tRPC server's files are checked the same way: they require Next internals by
# deep path (`next/dist/server/...`), which nothing else here loads at build time, so a trace
# that dropped one would otherwise surface as a crash-looping container. `served-pages.cjs` is
# loaded through server.cjs's own require of it.
COPY --from=builder /app/scripts/ci/assert-standalone-boot-graph.mjs /tmp/assert-standalone-boot-graph.mjs
RUN node /tmp/assert-standalone-boot-graph.mjs /app server.js trpc-server/server.cjs trpc-server/next-compat.cjs && rm -f /tmp/assert-standalone-boot-graph.mjs

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

CMD ["node", "--", "server.js", "--", "--expose-gc"]
