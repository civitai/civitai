# storage (apps/storage) — Fastify object-storage service, built from the pnpm monorepo. Multi-stage
# node:22-alpine, corepack pnpm, tsup build, `pnpm deploy --prod` runtime. Unlike the notifications
# image this app imports NO Prisma client (only @civitai/storage → zod, the aws-sdk, fastify), so the
# install can --ignore-scripts (no db:generate needed).
#
# IMPORTANT: build with the REPO ROOT as the context, pointing at this file:
#   docker build -f apps/storage/Dockerfile -t civitai-storage .
#
# Runtime needs REAL env vars (see apps/storage/.env.example / the deploy secret) — the .env file is
# dev-only; the prod node server reads process.env.

##### deps — filtered install (no postinstall scripts; this app never imports Prisma) #############
FROM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat && corepack enable && corepack prepare pnpm@10.28.1 --activate
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY patches ./patches
COPY packages ./packages
COPY apps/storage/package.json ./apps/storage/package.json

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

##### build — tsup bundle → apps/storage/dist/server.js ###########################################
FROM deps AS build
WORKDIR /app
COPY packages ./packages
COPY apps/storage ./apps/storage
RUN pnpm --filter @civitai/storage-app build

##### prod-deps — pruned, flattened production node_modules for the runtime #######################
FROM deps AS prod-deps
WORKDIR /app
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm --filter @civitai/storage-app deploy --prod --legacy --ignore-scripts /app/deploy

##### runtime ####################################################################################
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S nodejs -g 1001 && adduser -S nodeapp -u 1001

COPY --from=prod-deps --chown=nodeapp:nodejs /app/deploy/node_modules ./node_modules
COPY --from=build --chown=nodeapp:nodejs /app/apps/storage/dist ./dist
COPY --from=build --chown=nodeapp:nodejs /app/apps/storage/package.json ./package.json

USER nodeapp
EXPOSE 3000
ENV PORT=3000
CMD ["node", "dist/server.js"]
