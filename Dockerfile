##### DEPENDENCIES

FROM node:24.19.0-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS deps
RUN apk add --no-cache libc6-compat
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

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
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

FROM node:24.19.0-alpine3.24@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runner
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
COPY --from=builder /app/scripts/ci/assert-standalone-boot-graph.mjs /tmp/assert-standalone-boot-graph.mjs
RUN node /tmp/assert-standalone-boot-graph.mjs /app && rm -f /tmp/assert-standalone-boot-graph.mjs

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

CMD ["node", "--", "server.js", "--", "--expose-gc"]
