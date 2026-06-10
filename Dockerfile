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

# Node heap for the Next.js build. Default raised 6144 -> 8192: a cold build
# (no warm .next/cache) peaks higher than an incremental one and OOMs at 6 GB on
# newer commits. Build-arg so a builder with more memory can raise it further.
ARG NODE_BUILD_MEM=8192
RUN --mount=type=cache,target=/app/.next/cache \
    SKIP_ENV_VALIDATION=1 IS_BUILD=true NODE_OPTIONS="--max_old_space_size=${NODE_BUILD_MEM}" pnpm run build

# Server source maps (.next/server/**/*.js.map) are emitted by the build
# (productionBrowserSourceMaps -> turbopackSourceMaps) but @vercel/nft does NOT
# trace sibling .map files into .next/standalone, so they'd be missing at runtime.
# Collect ONLY the server-chunk maps into a structure-preserving staging dir so the
# runner can overlay them onto the standalone tree without dragging in untraced .js
# chunks. Maps are inert at runtime (loaded only by an inspector/stack resolver),
# so this adds image size but no request-path cost.
# Build-chunk map filenames are content hashes (no spaces/newlines), so the
# newline-delimited `tar -T -` files-from list is safe and works under both GNU tar
# and busybox tar (alpine). `tar | tar` preserves the dir structure
# (e.g. chunks/<hash>.js.map) so each map lands next to its .js in the runner.
# (Comments must stay OUTSIDE the RUN: Docker collapses the \-continuations into one
# line, where an inline `#` would swallow the rest of the command.)
RUN mkdir -p /app/server-maps && \
    cd /app/.next/server && \
    { find . -name '*.js.map' | tar -cf - -T - | tar -xf - -C /app/server-maps || true; } && \
    echo "Staged $(find /app/server-maps -name '*.js.map' | wc -l) server source maps ($(du -sh /app/server-maps | cut -f1))"

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
# Overlay server-chunk source maps that nft drops from the standalone trace.
# Structure mirrors .next/server, so this lands each <chunk>.js.map next to the
# <chunk>.js the standalone tree already shipped. Used offline by the cpuprofile
# resolver — never read on the request path.
COPY --from=builder --chown=nextjs:nodejs /app/server-maps/ ./.next/server/

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

CMD ["node", "--", "server.js", "--", "--expose-gc"]
