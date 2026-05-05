##### DEPENDENCIES

FROM node:20-alpine3.20 AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

# Copy Prisma schema for client generation (postinstall generates schema.prisma from this)
COPY prisma/schema.full.prisma ./prisma/

# Install dependencies — lockfile and scripts rarely change, so they go first.
# package.json changes on every version bump but pnpm only needs it for the
# workspace root name; the store cache mount lets pnpm reuse downloaded packages
# even when this layer is invalidated.
COPY pnpm-lock.yaml package.json ./
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
# Restore generated schema.prisma from deps (COPY . . overwrites it with source which doesn't have it)
COPY --from=deps /app/prisma/schema.prisma ./prisma/schema.prisma

ENV NEXT_TELEMETRY_DISABLED=1

RUN --mount=type=cache,target=/app/.next/cache \
    SKIP_ENV_VALIDATION=1 IS_BUILD=true NODE_OPTIONS="--max_old_space_size=6144" pnpm run build

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
