# notifications (apps/notifications) — Fastify producer API + fan-out poll worker, built from the pnpm
# monorepo. Mirrors apps/orchestrator-gateway/Dockerfile (multi-stage node:22-alpine, corepack pnpm,
# tsup build, `pnpm deploy --prod` runtime) with ONE difference: this app statically consumes
# @civitai/db's Prisma-backed helper, so the build needs the generated Prisma client.
#
# IMPORTANT: build with the REPO ROOT as the context, pointing at this file:
#   docker build -f apps/notifications/Dockerfile -t civitai-notifications .
# (The Tekton tag-webhook build sets CONTEXT_PATH="." and DOCKERFILE_PATH="apps/notifications/Dockerfile".)
#
# Runtime needs REAL env vars (see apps/notifications/.env.example / the deploy secret) — the .env file
# is dev-only; the prod node server reads process.env.

##### deps — full frozen install so the root postinstall runs `db:generate` ######
# Unlike the auth/gateway images (which `--ignore-scripts` because they never import the Prisma client),
# this app imports @civitai/db's db-helpers → @civitai/db-schema → @prisma/client, so the generated
# client MUST exist. A filtered install would drop the root `prisma` devDep, so we do a full frozen
# install (matching the main image) and let its postinstall generate the client. scripts/ + the prisma
# schema are required by db:generate.
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY packages ./packages
COPY scripts ./scripts
COPY apps/notifications/package.json ./apps/notifications/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

##### build — tsup bundle → apps/notifications/dist/server.js #####################
FROM deps AS build
WORKDIR /app
COPY packages ./packages
COPY apps/notifications ./apps/notifications
RUN pnpm --filter @civitai/notifications-app build

##### prod-deps — pruned, flattened production node_modules for the runtime ######
# `pnpm deploy` produces a self-contained dir (no workspace symlinks). --legacy for the flat layout.
# NOT --ignore-scripts: the deploy must carry the generated Prisma client that @civitai/db resolves at
# runtime (the bundle keeps @prisma/client external).
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @civitai/notifications-app deploy --prod --legacy /app/deploy

##### runtime ###################################################################
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodejs -g 1001 && adduser -S nodeapp -u 1001

COPY --from=prod-deps --chown=nodeapp:nodejs /app/deploy/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodejs /app/apps/notifications/dist ./dist
COPY --from=build --chown=nodeapp:nodejs /app/apps/notifications/package.json ./package.json

USER nodeapp
EXPOSE 3000
ENV PORT=3000
CMD ["node", "dist/server.js"]
