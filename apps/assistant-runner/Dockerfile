# assistant-runner (apps/assistant-runner) — Fastify + DBOS Node service, built from the pnpm monorepo.
# Mirrors apps/orchestrator-gateway/Dockerfile (multi-stage node:22-alpine, corepack pnpm, filtered
# frozen install, tsup build, `pnpm deploy --prod` runtime). `--ignore-scripts` skips the root's
# `db:generate`; safe because this app imports no Prisma client.
#
# Build with the REPO ROOT as the context, pointing at this file:
#   docker build -f apps/assistant-runner/Dockerfile -t civitai-assistant-runner .
#
# Runtime needs real env vars (see apps/assistant-runner/.env.example).

##### deps — install only this app + its workspace deps (lean, frozen) ##########
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS deps
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# patches/ is required because the root package.json declares pnpm.patchedDependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY packages ./packages
COPY apps/assistant-runner/package.json ./apps/assistant-runner/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @civitai/assistant-runner-app... --ignore-scripts

##### build — tsup bundle → apps/assistant-runner/dist/server.js ######################
FROM deps AS build
WORKDIR /app
COPY apps/assistant-runner ./apps/assistant-runner
RUN pnpm --filter @civitai/assistant-runner-app build

##### prod-deps — pruned, flattened production node_modules for the runtime ######
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @civitai/assistant-runner-app deploy --prod --legacy --ignore-scripts /app/deploy

##### runtime ###################################################################
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodejs -g 1001 && adduser -S nodeapp -u 1001

COPY --from=prod-deps --chown=nodeapp:nodejs /app/deploy/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodejs /app/apps/assistant-runner/dist ./dist
COPY --from=build --chown=nodeapp:nodejs /app/apps/assistant-runner/package.json ./package.json

USER nodeapp
EXPOSE 3000
ENV PORT=3000
# SIGTERM reaches node directly (no shell), so the runner shuts down cleanly on a pod stop.
CMD ["node", "dist/server.js"]
