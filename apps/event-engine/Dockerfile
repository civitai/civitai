# event-engine (apps/event-engine) — long-running Kafka/Debezium CDC consumer, built from
# the pnpm monorepo. Modeled on apps/orchestrator-gateway/Dockerfile (multi-stage node:22-alpine, corepack
# pnpm, filtered frozen install, `pnpm deploy --prod` runtime) — BUT this app keeps its own `tsc && tsc-alias`
# build (CJS output) rather than tsup/ESM. Converting to tsup + @civitai/* packages is a documented follow-up
# (see MIGRATION.md).
#
# Build with the REPO ROOT as context, pointing at this file:
#   docker build -f apps/event-engine/Dockerfile -t civitai-event-engine .
# (Tekton tag-webhook sets CONTEXT_PATH="." and DOCKERFILE_PATH="apps/event-engine/Dockerfile".)
#
# Runtime reads REAL env vars from the deploy secret (.env is dev-only) — DB/CLICKHOUSE/REDIS/MEILI/KAFKA/S3/etc.

##### deps — install only this app's deps (frozen) ##############################
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

# Workspace manifests so the filtered frozen install resolves. This app ITSELF depends on
# NO @civitai/* workspace packages (it vendors event-engine-common under src/common and ships its own
# clients) — but the repo-root package.json (a workspace member via `.` in pnpm-workspace.yaml) declares
# @civitai/{auth,buzz,shared}: workspace:*, so the filtered frozen install below must see the workspace.
# Without packages/ present it fails ERR_PNPM_WORKSPACE_PKG_NOT_FOUND @civitai/auth (mirrors
# apps/orchestrator-gateway/Dockerfile). patches/ is required because the root declares pnpm.patchedDependencies.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY packages ./packages
COPY apps/event-engine/package.json ./apps/event-engine/package.json

# --ignore-scripts skips the root's `db:generate` (Prisma) — this consumer uses raw pg, not the Prisma client.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter @civitai/event-engine... --ignore-scripts

##### build — tsc && tsc-alias → apps/event-engine/dist/index.js ##########
FROM deps AS build
WORKDIR /app
COPY apps/event-engine ./apps/event-engine
RUN pnpm --filter @civitai/event-engine build

##### prod-deps — pruned, isolated production node_modules ######################
# Deploy event-engine's OWN dependency closure (non-legacy). We must NOT use `--legacy`
# here: legacy `pnpm deploy` builds a flat/hoisted tree from the WHOLE workspace graph and
# hoists a single version of each package to the top level. The repo root (a workspace
# member) declares `@clickhouse/client@^0.2.2`; event-engine declares `@clickhouse/client@^1.12.1`
# (a major API break). Under `--legacy`, the root's 0.2.x won the hoist, so the built image
# shipped `@clickhouse/client@0.2.x` at the top level even though event-engine's own manifest
# pins ^1.12.1 — every ClickHouse insert then failed at runtime. Non-legacy deploy resolves
# ONLY event-engine's closure and preserves per-package version isolation, so it links 1.12.x.
# pnpm 10 gates non-legacy deploy behind `inject-workspace-packages` — event-engine depends on
# NO @civitai/* workspace package, so injection is a no-op here; we just need the gate open.
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @civitai/event-engine deploy --prod --ignore-scripts \
    --config.inject-workspace-packages=true /app/deploy

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
