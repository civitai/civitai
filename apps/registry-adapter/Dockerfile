# registry adapter (src/server/registry-adapter/, entry main.ts): the App Blocks registry source,
# one Node process serving HTTP/SSE and gRPC. Unlike the other apps/* images, its code is not in
# this directory: it is part of the root app (it imports the site's own server modules and env),
# so this image is built from the ROOT package. apps/registry-adapter holds only this file and a
# version-only package.json that scripts/release-app.mjs bumps (the same arrangement as
# apps/feed-go).
#
# IMPORTANT: build with the REPO ROOT as the context, pointing at this file, with the
# event-engine-common submodule checked out (the adapter's import graph may reach it, as the web
# app's does):
#   docker build -f apps/registry-adapter/Dockerfile -t civitai-registry-adapter .
#
# What ships: dist/registry-adapter.js (the esbuild bundle from `pnpm run build:registry-adapter`,
# which bundles first-party code and the workspace packages and keeps every root npm dependency
# external), and the part of the root package's PRODUCTION node_modules that the bundle's
# externals reach, with the generated Prisma client (scripts/registry-adapter-runtime-deps.mjs).
#
# Runtime needs the web server's REAL env (src/env/server.ts validates the whole server schema at
# startup), plus the REGISTRY_ADAPTER_* variables documented in main.ts. Nothing is baked in.
#
# The Node pin and base image are the root Dockerfile's production (musl) ones, same tag and
# digest, so the adapter runs the Node the web image and CI (.nvmrc) run.

##### base — the root Dockerfile's `base-musl` stage, plus pnpm ###################################
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS base
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

##### deps — the root Dockerfile's install: full, frozen, with the root postinstall ###############
# The postinstall (`db:generate`) generates the Prisma client, which needs the `prisma` devDep
# and scripts/. Copying all of packages/ lets --frozen-lockfile see every workspace project the
# root depends on.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY patches ./patches
# The root Dockerfile's musl store id: same base, same Node, so the stores are interchangeable.
RUN --mount=type=cache,id=pnpm-store-musl,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
# Stage the generated client for prod-deps. It is written into the pnpm virtual store next to
# @prisma/client (node_modules/.pnpm/@prisma+client@<key>/node_modules/.prisma), which is not a
# lockfile package, so no install other than this one produces it. `client-dir` records that
# store directory's name, which prod-deps must match.
RUN set -eu; \
    dir="$(node -p "require('path').dirname(require('path').dirname(require('fs').realpathSync('node_modules/@prisma/client')))")"; \
    test -d "$dir/.prisma/client"; \
    mkdir -p /generated-prisma; \
    cp -R "$dir/.prisma" /generated-prisma/.prisma; \
    basename "$(dirname "$dir")" > /generated-prisma/client-dir

##### build — the bundle, and its load check against the full install ##############################
# FROM deps, so the nested packages/*/node_modules the workspace packages resolve from are
# inherited (same reason as the root Dockerfile's builder). The full source overlays it;
# node_modules is dockerignored. `build:registry-adapter` refuses test and fixture inputs and
# fails if any external does not load (scripts/build-registry-adapter.mjs).
FROM deps AS build
COPY . .
RUN pnpm run build:registry-adapter

##### prod-deps — the root package's production node_modules #######################################
# A separate install with --prod, so no devDependency is in the tree that ships. --ignore-scripts
# because the root postinstall (`db:generate`) needs the `prisma` devDep, which a production
# install leaves out; the generated client is copied in from deps instead. packages/ is copied so
# the root's `workspace:` dependencies link; it is not shipped (the bundle carries that code, and
# the runtime load check below fails if anything still requires it).
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-store-musl,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=deps /generated-prisma /tmp/generated-prisma
# Into the store directory @prisma/client resolves to HERE; refuses a directory whose name differs
# from the one the client was generated beside (another @prisma/client version or peer set).
RUN set -eu; \
    dir="$(node -p "require('path').dirname(require('path').dirname(require('fs').realpathSync('node_modules/@prisma/client')))")"; \
    test "$(basename "$(dirname "$dir")")" = "$(cat /tmp/generated-prisma/client-dir)"; \
    cp -R /tmp/generated-prisma/.prisma "$dir/.prisma"; \
    rm -rf /tmp/generated-prisma
# Only what the bundle can load: the externals named in the build's manifest and their
# dependencies, in pnpm's layout, into /runtime/node_modules. The full production tree carries the
# whole web app; this keeps the image to what the adapter uses. Fails if a link in the copy points
# outside it (see the script).
RUN --mount=type=bind,from=build,source=/app/scripts/registry-adapter-runtime-deps.mjs,target=/tmp/registry-adapter-runtime-deps.mjs \
    --mount=type=bind,from=build,source=/app/dist/registry-adapter.externals.json,target=/tmp/registry-adapter.externals.json \
    node /tmp/registry-adapter-runtime-deps.mjs /tmp/registry-adapter.externals.json /runtime

##### runtime ######################################################################################
# The root Dockerfile's `runtime-musl` base: bare Alpine, same tag and digest.
FROM node:24.22.3-alpine3.24@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS runtime
ENV NODE_ENV=production
WORKDIR /app
# uid/gid 1001, as the web image's runner and the other apps/* images. The files below stay
# root-owned: the process only reads them.
RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nodeapp

COPY --from=prod-deps /runtime/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist/registry-adapter.js /app/dist/registry-adapter.js.map /app/dist/registry-adapter.externals.json ./dist/

# Load check, second run: every external the bundle loads must load from THIS /app, which is
# byte-for-byte what ships. The build stage's run cannot see a package only the full install
# provides, nor a generated Prisma client the production install dropped, because there the full
# node_modules is on the resolution path. Same placement rule as the root Dockerfile's boot-graph
# gate. The script is bind-mounted from the build stage, so it is in no layer of the image.
RUN --mount=type=bind,from=build,source=/app/scripts/registry-adapter-load-check.mjs,target=/tmp/registry-adapter-load-check.mjs \
    node /tmp/registry-adapter-load-check.mjs /app/dist/registry-adapter.externals.json

# Prisma's query engine, loaded. `require('@prisma/client')` above does not load it (the client
# opens it on first connect), and the boot smoke in CI stops at env validation, so a wrong engine
# target or a missing libssl would otherwise pass every gate here and fail at the first query.
# Fails if no engine is found under the generated client, or if one does not load.
RUN set -eu; \
    find /app/node_modules/.pnpm -path '*/node_modules/.prisma/client/libquery_engine*.node' > /tmp/engines; \
    test -s /tmp/engines; \
    while read -r f; do \
      node -e 'require(process.argv[1])' "$f"; \
      echo "loaded $f"; \
    done < /tmp/engines; \
    rm -f /tmp/engines

USER 1001:1001
# 7130: HTTP/SSE (REGISTRY_ADAPTER_PORT), 7131: gRPC (REGISTRY_ADAPTER_GRPC_PORT); main.ts defaults.
EXPOSE 7130 7131
# `start:registry-adapter`. The source map ships beside the bundle; set
# NODE_OPTIONS=--enable-source-maps to use it.
CMD ["node", "dist/registry-adapter.js"]
