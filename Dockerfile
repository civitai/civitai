##### DEPENDENCIES

FROM node:20-alpine3.16 AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Enable corepack for pnpm
RUN corepack enable && corepack prepare pnpm@10.28.1 --activate

# Install Prisma Client - remove if not using Prisma

COPY prisma ./prisma

# Install dependencies

COPY package.json pnpm-lock.yaml ./

# copy ./scripts directory to /app/scripts to run prisma enum generator
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

##### BUILDER

FROM node:20-alpine3.16 AS builder
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

RUN SKIP_ENV_VALIDATION=1 IS_BUILD=true NODE_OPTIONS="--max_old_space_size=6144" pnpm run build

##### RUNNER

FROM node:20-alpine3.16 AS runner
WORKDIR /app

ENV NODE_ENV=production

# ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder /app/next.config.mjs ./
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV NEXT_TELEMETRY_DISABLED=1

CMD ["node", "--", "server.js", "--", "--expose-gc"]
