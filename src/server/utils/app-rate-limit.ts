import { TRPCError } from '@trpc/server';
import type { NextApiResponse } from 'next';
import type { AppBlockRateLimitBucket } from '~/server/metrics/app-block-runtime.metrics';
import { rateLimitMetaFor, throwRateLimited } from '~/server/utils/rate-limit-error';
import { REST_ERROR_CODE, restErrorBody } from '~/server/utils/rest-error-envelope';
import {
  usageLimitDefsById,
  usageLimitReportsCounts,
  type UsageLimitId,
} from '~/shared/constants/usage-limits';
import {
  parseRateLimitMeta,
  type RateLimitKind,
  type RateLimitMeta,
} from '~/shared/utils/rate-limit-meta';

/**
 * The App Platform's rate limits, by the stable id a refusal names in its `rateLimit` meta.
 *
 * Every App Platform 429 (a tRPC TOO_MANY_REQUESTS, a REST 429, the bridge reply the host forwards)
 * is built from one of these ids by the helpers below, so it carries the house meta
 * (`RateLimitMeta`: `retryAfterSeconds`, `retryAt`, `id`, `kind`, and the counts for a product
 * limit only). `app-platform-rate-limit-meta.test.ts` fails on an App Platform path that spells a
 * 429 any other way.
 *
 * `kind`:
 *   - `product`: an allowance a user plans around (how many forks a day). Its refusal carries
 *     `limit`, `used`, `remaining` and, for a windowed limit, `windowSeconds` and `resetAt`.
 *   - `abuse`: an anti-flood bound, or a cap guarding money or safety. Its numbers are not sent
 *     (`rateLimitMetaOf` strips them again on the way out, whoever built the meta), unless the
 *     registry marks it `reportsCounts` (the tip and goods daily caps).
 *
 * A PER-USER cap is a `usage-limits` registry entry (`app-usage-limits.ts`), tunable from the
 * KeyValue row, and its kind is read from there (`appRateLimitClass`). This table holds only the
 * limits that are not per user — per app instance, per app, per listing or per moderator — which
 * keep their own counters and code constants. The two sets are disjoint (pinned by the tests).
 */
export const APP_RATE_LIMITS = {
  // ── Block tokens
  'apps.block-token-mint': { kind: 'abuse' },
  'apps.block-token-mint-ip': { kind: 'abuse' },
  'apps.review-token-run-for-real': { kind: 'abuse' },
  // ── The bridge and the block REST routes (per app instance, app or viewer)
  'apps.catalog': { kind: 'abuse' },
  'apps.publish': { kind: 'abuse' },
  'apps.post': { kind: 'abuse' },
  'apps.post-app': { kind: 'abuse' },
  'apps.poll': { kind: 'abuse' },
  'apps.upload-app': { kind: 'abuse' },
  'apps.estimate-cells': { kind: 'abuse' },
  'apps.llm': { kind: 'abuse' },
  'apps.submit': { kind: 'abuse' },
  'apps.in-flight': { kind: 'abuse' },
  'apps.standing-consent': { kind: 'abuse' },
  'apps.standing-submit': { kind: 'abuse' },
  'apps.tip-rate': { kind: 'abuse' },
  'apps.goods-rate': { kind: 'abuse' },
  'apps.goods-read': { kind: 'abuse' },
  // ── Storage
  'apps.doc-store': { kind: 'abuse' },
  'apps.shared-storage': { kind: 'abuse' },
  // ── Authoring, publishing and review
  'apps.store-items': { kind: 'product' },
  'apps.store-item-writes': { kind: 'abuse' },
  'apps.store-item-sync': { kind: 'abuse' },
  'apps.directory': { kind: 'abuse' },
  // ── Moderator tools
  'apps.build-retrigger': { kind: 'abuse' },
  'apps.moderator-messages': { kind: 'abuse' },
} as const satisfies Record<string, { kind: RateLimitKind }>;

/** An App Platform limit: a registry entry (`apps.*` in `usage-limits.ts`), or one of the above. */
export type AppRateLimitId = keyof typeof APP_RATE_LIMITS | Extract<UsageLimitId, `apps.${string}`>;

/**
 * A limit's kind, and whether its refusal reports counts: from the registry for a registry entry
 * (the one place those are decided), from `APP_RATE_LIMITS` for the rest.
 */
export function appRateLimitClass(id: AppRateLimitId): {
  kind: RateLimitKind;
  reportsCounts: boolean;
} {
  const def = usageLimitDefsById.get(id);
  if (def) return { kind: def.kind, reportsCounts: usageLimitReportsCounts(def) };
  const { kind } = APP_RATE_LIMITS[id as keyof typeof APP_RATE_LIMITS];
  return { kind, reportsCounts: kind === 'product' };
}

/** The id each bridge bucket's refusal names (its counter label stays the bucket). */
export const BRIDGE_BUCKET_RATE_LIMIT_ID: Readonly<
  Record<AppBlockRateLimitBucket, AppRateLimitId>
> = {
  catalog: 'apps.catalog',
  publish: 'apps.publish',
  post: 'apps.post',
  'post-app': 'apps.post-app',
  poll: 'apps.poll',
  'estimate-cells': 'apps.estimate-cells',
  submit: 'apps.submit',
  'submit-user': 'apps.submit-user',
  'upload-app': 'apps.upload-app',
  'gen-source-user': 'apps.generation-source',
  'uploaded-gen-source-user': 'apps.generation-source',
  'in-flight': 'apps.in-flight',
};

/** What a product refusal reports. `used` may exceed `limit`. */
export type AppRateLimitCounts = {
  limit: number;
  used: number;
  /** The window's length, for a windowed limit; omitted for a standing one. */
  windowSeconds?: number;
  /** When the whole window is clear, for a windowed limit. */
  resetAt?: Date;
};

/** A retry delay the meta can carry: a whole number of seconds, at least 1. */
export function retryAfterSecondsOf(raw: unknown, fallbackSeconds: number): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallbackSeconds;
  return Math.max(1, Math.ceil(value));
}

/** Seconds from `now` to the next UTC midnight (at least 1), and that instant. */
export function utcDayReset(now = Date.now()): { retryAfterSeconds: number; resetAt: Date } {
  const d = new Date(now);
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
  return { retryAfterSeconds: Math.max(1, Math.ceil((end.getTime() - now) / 1000)), resetAt: end };
}

/**
 * A standing allowance (pending submissions, store items held) frees up only when the user's own
 * usage drops, so no instant clears it. Its refusal still names a retry delay, because the meta
 * requires one: this re-check interval, with no `resetAt`.
 */
export const STANDING_LIMIT_RETRY_SECONDS = 60 * 60;

/** A count the meta can carry: a whole number, at least 0 (`parseRateLimitMeta` drops others). */
const wholeCount = (value: number) => (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);

/** The `rateLimit` meta of a refusal by `id`; the counts are kept only for a limit that reports them. */
export function appRateLimitMeta(
  id: AppRateLimitId,
  retryAfterSeconds: number,
  counts?: AppRateLimitCounts
): RateLimitMeta {
  const { kind, reportsCounts } = appRateLimitClass(id);
  const meta: RateLimitMeta = {
    ...rateLimitMetaFor(retryAfterSecondsOf(retryAfterSeconds, 1)),
    id,
    kind,
  };
  if (reportsCounts && counts) {
    meta.limit = wholeCount(counts.limit);
    meta.used = wholeCount(counts.used);
    meta.remaining = Math.max(0, meta.limit - meta.used);
    if (counts.windowSeconds !== undefined) meta.windowSeconds = wholeCount(counts.windowSeconds);
    if (counts.resetAt && !Number.isNaN(counts.resetAt.getTime()))
      meta.resetAt = counts.resetAt.toISOString();
  }
  return meta;
}

/**
 * The meta a service error carries on its `rateLimit` field, for a router mapper that turns a
 * service's rate-limited error into the TOO_MANY_REQUESTS refusal (`throwRateLimited`).
 */
export function rateLimitMetaOfServiceError(err: unknown): RateLimitMeta | undefined {
  if (!err || typeof err !== 'object') return undefined;
  return parseRateLimitMeta((err as { rateLimit?: unknown }).rateLimit);
}

/**
 * The TOO_MANY_REQUESTS error carrying `meta` (`cause.rateLimit`, where the formatter lifts it),
 * for a mapper that returns the error rather than throwing it.
 */
export function rateLimitedTrpcError(meta: RateLimitMeta, message: string): TRPCError {
  return new TRPCError({ code: 'TOO_MANY_REQUESTS', message, cause: { rateLimit: meta } });
}

/** Throws the TOO_MANY_REQUESTS refusal by `id`, carrying its meta (`throwRateLimited`). */
export function throwAppRateLimited(
  id: AppRateLimitId,
  retryAfterSeconds: number,
  message = 'Rate limit exceeded, please retry shortly.',
  counts?: AppRateLimitCounts
): never {
  throwRateLimited(appRateLimitMeta(id, retryAfterSeconds, counts), message);
}

/**
 * The body of a REST 429: the house error envelope (`{ error, message, code }`) plus `rateLimit`.
 * `legacy` keeps fields a route already sent beside its error (its top-level `retryAfterSeconds`,
 * say), so no shipped consumer loses one; the envelope's own keys win over them.
 */
export function appRateLimitBody(
  meta: RateLimitMeta,
  message: string,
  legacy?: Record<string, unknown>
) {
  return {
    ...legacy,
    ...restErrorBody(REST_ERROR_CODE.TOO_MANY_REQUESTS, message),
    rateLimit: meta,
  };
}

/** Answers a REST 429 with `Retry-After`, `no-store` and `appRateLimitBody`. */
export function sendAppRateLimited(
  res: NextApiResponse,
  meta: RateLimitMeta,
  message: string,
  legacy?: Record<string, unknown>
): void {
  res.setHeader('Retry-After', String(meta.retryAfterSeconds));
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.status(429).json(appRateLimitBody(meta, message, legacy));
}
