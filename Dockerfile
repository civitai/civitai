##### DEPENDENCIES

FROM node:20-alpine3.20 AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

# Install dependencies. Workspace manifests (root + pnpm-workspace.yaml + packages/*)
# and the lockfile go first; the store cache mount lets pnpm reuse downloads even when
# this layer is invalidated. `postinstall` runs db:generate, which needs the Prisma
# schema (now in packages/civitai-db-schema) and the scripts. Copying all of packages/
# also ensures --frozen-lockfile sees every workspace project.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY scripts ./scripts
COPY patches ./patches

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

##### BUILDER

FROM node:20-alpine3.20 AS builder
ARG NEXT_PUBLIC_IMAGE_LOCATION
ARG NEXT_PUBLIC_CONTENT_DECTECTION_LOCATION
ARG NEXT_PUBLIC_MAINTENANCE_MODE
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Restore generated slim schema.prisma from deps (it's gitignored, so COPY . . above
# brings the package dir without it)
COPY --from=deps /app/packages/civitai-db-schema/prisma/schema.prisma ./packages/civitai-db-schema/prisma/schema.prisma

ENV NEXT_TELEMETRY_DISABLED=1

# Node heap for the Next.js build. Default raised 6144 -> 8192: a cold build
# (no warm .next/cache) peaks higher than an incremental one and OOMs at 6 GB on
# newer commits. Build-arg so a builder with more memory can raise it further.
ARG NODE_BUILD_MEM=8192
RUN --mount=type=cache,target=/app/.next/cache \
    SKIP_ENV_VALIDATION=1 IS_BUILD=true NODE_OPTIONS="--max_old_space_size=${NODE_BUILD_MEM}" pnpm run build

##### RUNNER

FROM node:20-alpine3.20 AS runner
WORKDIR /app

ENV NODE_ENV=production

# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

CMD ["node", "--", "server.js", "--", "--expose-gc"]
