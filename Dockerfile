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

COPY apps/training-studio/package.json ./apps/training-studio/package.json
RUN --mount=type=cache,id=pnpm-store-${LIBC},target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @civitai/training-studio-app... --ignore-scripts

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

# PR previews load this commit's Studio element instead of the production Studio deployment.
RUN pnpm --filter @civitai/training-studio-app exec svelte-kit sync && \
    pnpm --filter @civitai/training-studio-app build:element && \
    mkdir -p public/training-studio && \
    cp -a apps/training-studio/static/element public/training-studio/

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

# Server output size, so a jump in emitted server code shows up in the PR's build log.
# `[root-of-the-server]__*.js` are Turbopack's per-entry loader chunks for server dynamic imports.
RUN node -e 'const fs=require("fs"),p=require("path");const t={js:[0,0],root:[0,0]};(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())w(f);else if(e.name.endsWith(".js")){const n=fs.statSync(f).size;t.js[0]++;t.js[1]+=n;if(e.name.startsWith("[root-of-the-server]__")){t.root[0]++;t.root[1]+=n}}}})("/app/.next/server");console.log(`server-output: js_files=${t.js[0]} js_bytes=${t.js[1]} root_files=${t.root[0]} root_bytes=${t.root[1]}`)'

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

# Duplicate server chunks -> one-line re-export stubs, in the SHIPPED tree only.
#
# Turbopack emits the same server chunk under many file names, and its Node runtime loads
# chunks with `require(<path>)`.
# Node caches by path, so every copy is compiled and its source kept on the heap. The script
# replaces each duplicate with `module.exports=require("./<canonical>.js")`: every existing
# reference still names a real file, and the runtime receives the canonical's own module array
# (it registers factories by module id, so module identity is unchanged). See the script header.
#
# Touches only `.next/standalone/.next/server`. Exits 1 if a stub does not resolve to a real chunk, 2 if it
# finds no chunks — both fail the build.
RUN node scripts/dedupe-server-chunks.mjs /app/.next/standalone/.next/server

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
# The image feed benchmark (scripts/feed-bench/README.md): its standalone Node arm
# (`node -- feed-bench/server.cjs`, which requires ../trpc-server/next-compat.cjs) and its replay
# harness (`node feed-bench/bench.cjs`). Nothing runs them unless a deployment names the command;
# deliberately NOT in the boot-graph gate below: a broken benchmark script must not block a release.
COPY --from=builder --chown=nextjs:nodejs /app/scripts/feed-bench/server.cjs /app/scripts/feed-bench/bench.cjs /app/scripts/feed-bench/lib.cjs ./feed-bench/
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
