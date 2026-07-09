# Creator Studio (apps/creator-studio) — SvelteKit + adapter-node, built from the pnpm monorepo.
#
# IMPORTANT: build with the REPO ROOT as the context, pointing at this file:
#   docker build -f apps/creator-studio/Dockerfile -t civitai-creator-studio .
#
# Runtime needs REAL env vars (see apps/creator-studio/.env.example / the deploy checklist) — the .env file
# and Vite's loadEnv are dev-only; the prod node server reads process.env.

##### deps — install only the hub + its workspace deps (lean, frozen) ###########
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# Workspace manifests + the packages the hub depends on, so the filtered frozen install resolves.
# patches/ is required because the root package.json declares pnpm.patchedDependencies — pnpm hashes
# the patch file during install (even with --ignore-scripts), so it must be in the build context.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY packages ./packages
COPY apps/creator-studio/package.json ./apps/creator-studio/package.json

# --ignore-scripts skips the root's `db:generate` (Prisma) — the hub uses a hand-written Kysely
# type and never imports the Prisma client, so it doesn't need generation.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @civitai/creator-studio-app... --ignore-scripts

##### build — vite build → apps/creator-studio/build (adapter-node output) #################
FROM deps AS build
WORKDIR /app
# Build-only placeholders: db.ts (src/lib/server/db.ts) calls createKyselyClients with
# required('DATABASE_URL') AND required('DATABASE_REPLICA_URL') at module load, so once any
# server route imports dbRead/dbWrite, SvelteKit's `analyse` postbuild step — which imports the
# server modules — throws "DATABASE_REPLICA_URL is not configured" if either is unset. The pools
# never connect during build; these dummies only satisfy the required() guard. They live ONLY in
# this stage and are NOT carried into `runtime` (separate FROM), so the real values come from the
# k8s secret at run time. Both are set so the build stays green as the app wires up its DB reads.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV DATABASE_REPLICA_URL=postgres://build:build@localhost:5432/build
COPY packages ./packages
COPY apps/creator-studio ./apps/creator-studio
RUN pnpm --filter @civitai/creator-studio-app build

##### prod-deps — pruned, flattened production node_modules for the runtime ######
# `pnpm deploy` produces a self-contained dir (no workspace symlinks). If your pnpm needs it,
# add `inject-workspace-packages=true` to .npmrc or pass `--legacy`.
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @civitai/creator-studio-app deploy --prod --legacy --ignore-scripts /app/deploy

##### runtime ###################################################################
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodejs -g 1001 && adduser -S sveltekit -u 1001

COPY --from=prod-deps --chown=sveltekit:nodejs /app/deploy/node_modules ./node_modules
COPY --from=build --chown=sveltekit:nodejs /app/apps/creator-studio/build ./build
COPY --from=build --chown=sveltekit:nodejs /app/apps/creator-studio/package.json ./package.json

USER sveltekit
EXPOSE 3000
ENV PORT=3000
# adapter-node uses ORIGIN (+ PROTOCOL_HEADER/HOST_HEADER if behind a proxy) for correct url.origin.
CMD ["node", "build"]
