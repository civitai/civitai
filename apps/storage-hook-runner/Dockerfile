# storage-hook-runner (apps/storage-hook-runner) — Fastify + worker_threads + QuickJS (WASM).
# Node 24.22.1: the same release as the repo's .nvmrc, which CI's test runs use. The README's
# measurements were taken on Node 24 (24.21 locally, 24.22.1 in CI); stack and interrupt
# behaviour is engine-specific, so bump this and .nvmrc together.
# Mirrors apps/assistant-runner/Dockerfile (multi-stage node-alpine, corepack pnpm, filtered
# frozen install, tsup build, non-legacy `pnpm deploy --prod` runtime). `--ignore-scripts` skips
# the root's `db:generate`; safe because this app imports no Prisma client and has no workspace
# dependencies.
#
# Build with the REPO ROOT as the context, pointing at this file:
#   docker build -f apps/storage-hook-runner/Dockerfile -t civitai-storage-hook-runner .
#
# Runtime needs real env vars (see apps/storage-hook-runner/.env.example). The QuickJS .wasm is
# read from node_modules at startup; nothing is fetched at runtime, so the pod needs no egress.

##### deps — install only this app (lean, frozen) ##############################
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS deps
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# patches/ is required because the root package.json declares pnpm.patchedDependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY packages ./packages
COPY apps/storage-hook-runner/package.json ./apps/storage-hook-runner/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @civitai/storage-hook-runner-app... --ignore-scripts

##### build — tsup bundle → apps/storage-hook-runner/dist/{server,worker}.js ##########
FROM deps AS build
WORKDIR /app
COPY apps/storage-hook-runner ./apps/storage-hook-runner
RUN pnpm --filter @civitai/storage-hook-runner-app build

##### prod-deps — the runner's OWN production dependency closure ##############
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @civitai/storage-hook-runner-app deploy --prod --ignore-scripts \
    --config.inject-workspace-packages=true /app/deploy

##### runtime ###################################################################
FROM node:24.22.1-alpine3.24@sha256:06d7adf3e0ef61a13f1d28682726366f97a15aa1888c934d3ecec86c33918b53 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodejs -g 1001 && adduser -S nodeapp -u 1001

COPY --from=prod-deps --chown=nodeapp:nodejs /app/deploy/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodejs /app/apps/storage-hook-runner/dist ./dist
COPY --from=build --chown=nodeapp:nodejs /app/apps/storage-hook-runner/package.json ./package.json

USER nodeapp
# 8080: POST /v1/check, /healthz, /readyz. 9091: /metrics.
EXPOSE 8080 9091
ENV PORT=8080 METRICS_PORT=9091
# SIGTERM reaches node directly (no shell), so the runner drains and exits on a pod stop.
CMD ["node", "dist/server.js"]
