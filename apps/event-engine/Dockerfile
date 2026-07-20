# event-engine (apps/event-engine) — long-running Kafka/Debezium CDC consumer, built from
# the pnpm monorepo. Modeled on apps/orchestrator-gateway/Dockerfile (multi-stage node:22-alpine, corepack
# pnpm, filtered frozen install, `pnpm deploy --prod` runtime) — BUT this app keeps its own `tsc && tsc-alias`
# build (CJS output) rather than tsup/ESM. Converting to tsup + @civitai/* packages is a documented follow-up
# (see MIGRATION.md); this Dockerfile is a DRAFT and needs a real build + Zach's DevOps review before use.
#
# Build with the REPO ROOT as context, pointing at this file:
#   docker build -f apps/event-engine/Dockerfile -t civitai-event-engine .
# (Tekton tag-webhook sets CONTEXT_PATH="." and DOCKERFILE_PATH="apps/event-engine/Dockerfile".)
#
# PREREQUISITE: run `pnpm install` at the repo root once so pnpm-lock.yaml includes this new app, or the
# --frozen-lockfile install below will fail.
#
# Runtime reads REAL env vars from the deploy secret (.env is dev-only) — DB/CLICKHOUSE/REDIS/MEILI/KAFKA/S3/etc.

##### deps — install only this app's deps (frozen) ##############################
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# Workspace manifests so the filtered frozen install resolves. This app depends on NO @civitai/* workspace
# packages yet (it vendors event-engine-common under src/common and ships its own clients), so it does not
# need `COPY packages`. patches/ is required because the root declares pnpm.patchedDependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY apps/event-engine/package.json ./apps/event-engine/package.json

# --ignore-scripts skips the root's `db:generate` (Prisma) — this consumer uses raw pg, not the Prisma client.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @civitai/event-engine... --ignore-scripts

##### build — tsc && tsc-alias → apps/event-engine/dist/index.js ##########
FROM deps AS build
WORKDIR /app
COPY apps/event-engine ./apps/event-engine
RUN pnpm --filter @civitai/event-engine build

##### prod-deps — pruned, flattened production node_modules #####################
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @civitai/event-engine deploy --prod --legacy --ignore-scripts /app/deploy

##### runtime ###################################################################
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodejs -g 1001 && adduser -S nodeapp -u 1001

COPY --from=prod-deps --chown=nodeapp:nodejs /app/deploy/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodejs /app/apps/event-engine/dist ./dist
COPY --from=build --chown=nodeapp:nodejs /app/apps/event-engine/package.json ./package.json

USER nodeapp
EXPOSE 3000
# tsc-alias rewrites the `@/` path aliases in dist to relative imports, so no tsconfig-paths at runtime
# (matches the original watcher image, which also ran `node dist/index.js`).
CMD ["node", "dist/index.js"]
