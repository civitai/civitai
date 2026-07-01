# orchestrator-api (apps/orchestrator-api) — Fastify + tRPC-over-HTTP Node service, built from the
# pnpm monorepo. Mirrors apps/auth/Dockerfile shape (multi-stage node:22-alpine, corepack pnpm,
# filtered frozen install, tsup build, `pnpm deploy --prod` runtime).
#
# IMPORTANT: build with the REPO ROOT as the context, pointing at this file:
#   docker build -f apps/orchestrator-api/Dockerfile -t civitai-orchestrator-api .
# (The Tekton tag-webhook build sets CONTEXT_PATH="." and DOCKERFILE_PATH="apps/orchestrator-api/Dockerfile".)
#
# Runtime needs REAL env vars (see apps/orchestrator-api/.env.example / the deploy secret) — the .env file
# is dev-only; the prod node server reads process.env.

##### deps — install only this app + its workspace deps (lean, frozen) ##########
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# Workspace manifests + the packages the app depends on, so the filtered frozen install resolves.
# patches/ is required because the root package.json declares pnpm.patchedDependencies — pnpm hashes
# the patch file during install (even with --ignore-scripts), so it must be in the build context.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY packages ./packages
COPY apps/orchestrator-api/package.json ./apps/orchestrator-api/package.json

# --ignore-scripts skips the root's `db:generate` (Prisma). @civitai/db's generated client is only pulled
# via a dynamic import behind a DATABASE_URL guard (getDb), and the P0 skeleton never invokes it, so the
# build needs no Prisma generation. (When the generation surface moves in and the DB path goes hot, add a
# `pnpm db:generate` step here — same as the main image.)
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @civitai/orchestrator-api... --ignore-scripts

##### build — tsup bundle → apps/orchestrator-api/dist/server.js ##################
FROM deps AS build
WORKDIR /app
COPY packages ./packages
COPY apps/orchestrator-api ./apps/orchestrator-api
RUN pnpm --filter @civitai/orchestrator-api build

##### prod-deps — pruned, flattened production node_modules for the runtime ######
# `pnpm deploy` produces a self-contained dir (no workspace symlinks). --legacy for the flat layout.
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @civitai/orchestrator-api deploy --prod --legacy --ignore-scripts /app/deploy

##### runtime ###################################################################
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodejs -g 1001 && adduser -S nodeapp -u 1001

COPY --from=prod-deps --chown=nodeapp:nodejs /app/deploy/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodejs /app/apps/orchestrator-api/dist ./dist
COPY --from=build --chown=nodeapp:nodejs /app/apps/orchestrator-api/package.json ./package.json

USER nodeapp
EXPOSE 3000
ENV PORT=3000
CMD ["node", "dist/server.js"]
