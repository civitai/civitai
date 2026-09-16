# Training Studio (apps/training-studio) — SvelteKit + adapter-node, built from the pnpm monorepo.
#
# IMPORTANT: build with the REPO ROOT as the context, pointing at this file:
#   docker build -f apps/training-studio/Dockerfile -t civitai-training-studio .
#
# In production this is built in-cluster by the Tekton `tag-webhook` receiver on a
# `training-studio-vX.Y.Z` tag push (context ".", this dockerfile) → ghcr.io/civitai/civitai-training-studio.
#
# Runtime needs REAL env vars (see apps/training-studio/.env.example / the deploy checklist) — the .env
# file and Vite's loadEnv are dev-only; the prod node server reads process.env.

##### deps — install only the spoke + its workspace deps (lean, frozen) #########
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS deps
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# Workspace manifests + the packages the spoke depends on, so the filtered frozen install resolves.
# patches/ is required because the root package.json declares pnpm.patchedDependencies — pnpm hashes
# the patch file during install (even with --ignore-scripts), so it must be in the build context.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY packages ./packages
COPY apps/training-studio/package.json ./apps/training-studio/package.json

# --ignore-scripts skips the root's `db:generate` (Prisma) — the spoke reads the DB through Kysely
# (@civitai/db/kysely + the hand-written @civitai/db-schema types) and never imports the Prisma
# client, so it doesn't need generation.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @civitai/training-studio-app... --ignore-scripts

##### build — vite build → apps/training-studio/build (adapter-node output) #####
FROM deps AS build
WORKDIR /app
# Build-only placeholder: src/lib/server/db.ts calls createKyselyClients with required('DATABASE_URL')
# at module load, so SvelteKit's `analyse` postbuild step — which imports the server modules — throws
# "DATABASE_URL is not configured" if it is unset. The pool never connects during build; this dummy
# only satisfies the required() guard. It lives ONLY in this stage and is NOT carried into `runtime`
# (separate FROM), so the real value comes from the k8s secret at run time.
#
# Unlike the moderator/creator-studio spokes this app builds a SINGLE Kysely client (singleClient:true,
# no replica — its only DB use is minting the user's orchestrator ApiKey), so there is deliberately no
# DATABASE_REPLICA_URL placeholder here. Redis (getSysRedis), buzz (getBuzz) and the orchestrator client
# are all lazily constructed inside functions, so they need no build-time placeholder either.
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
COPY packages ./packages
COPY apps/training-studio ./apps/training-studio
RUN pnpm --filter @civitai/training-studio-app build

##### prod-deps — pruned, flattened production node_modules for the runtime #####
# `pnpm deploy` produces a self-contained dir (no workspace symlinks). If your pnpm needs it,
# add `inject-workspace-packages=true` to .npmrc or pass `--legacy`.
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @civitai/training-studio-app deploy --prod --legacy --ignore-scripts /app/deploy

##### runtime ###################################################################
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodejs -g 1001 && adduser -S sveltekit -u 1001

COPY --from=prod-deps --chown=sveltekit:nodejs /app/deploy/node_modules ./node_modules
COPY --from=build --chown=sveltekit:nodejs /app/apps/training-studio/build ./build
COPY --from=build --chown=sveltekit:nodejs /app/apps/training-studio/package.json ./package.json

USER sveltekit
EXPOSE 3000
ENV PORT=3000
# adapter-node uses ORIGIN (+ PROTOCOL_HEADER/HOST_HEADER if behind a proxy) for correct url.origin.
CMD ["node", "build"]
