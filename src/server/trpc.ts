import { initTRPC, TRPCError } from '@trpc/server';
import type { NextApiRequest } from 'next';
import semver from 'semver';
import superjson from 'superjson';
import { OnboardingSteps } from '~/server/common/enums';
import { withSpan } from '~/server/utils/otel-helpers';
import {
  acquireBulkheadSlot,
  BulkheadFullError,
  HEAVY_REQUEST_CONCURRENCY,
} from '~/server/utils/request-bulkhead';
import { trpcProcedureDuration } from '~/server/prom/client';
import { maybeLogTrpcSlow } from '~/server/logging/trpc-slow-log';
import { longTaskLabelsArmed, runWithLongTaskLabel } from '~/server/eventloop-longtask';
import { instrumentSerialize } from '~/server/logging/trpc-serialize-log';
import { unionDeserialize } from '~/shared/utils/trpc-union-transformer';
import { REDIS_SYS_KEYS, sysRedis, withSysReadDeadline } from '~/server/redis/client';
import { decodeRedisString } from '~/server/redis/buffer-decode';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import {
  publicBrowsingLevelsFlag,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import { parseVerifiedBotHeader, VERIFIED_BOT_HEADER } from '~/server/utils/bot-detection/header';
import type { Context } from './createContext';

export interface TRPCMeta {
  /** Bitwise token scope required for this procedure. Checked against ctx.tokenScope. */
  requiredScope?: number;
  /**
   * When true, this procedure cannot be invoked via API key or OAuth token,
   * regardless of scope — only session auth (browser cookie) is allowed.
   * Used for Civitai-side buzz-spending operations (tips, bounty creation,
   * cosmetic purchases, etc.). Buzz spend through tokens is delegated entirely
   * to the orchestrator.
   */
  blockApiKeys?: boolean;
}

const t = initTRPC
  .context<Context>()
  .meta<TRPCMeta>()
  .create({
    // Phase 1 of the superjson → devalue transformer migration (additive, wire
    // unchanged). Split into a CombinedDataTransformer so READ and WRITE flip
    // independently in later phases. WRITE (serialize) stays 100% superjson;
    // READ (deserialize) becomes the format-sniffing UNION so the server can
    // decode either format before any writer ever emits devalue. `input` is the
    // request-read path (the only one exercised server-side); `output` is filled
    // for a complete transformer.
    transformer: {
      input: {
        serialize: (data: any) => superjson.serialize(data),
        deserialize: unionDeserialize,
      },
      output: {
        // instrumentSerialize times the serialize (the exact frame that pegs the
        // loop on an oversized response — see trpc-serialize-log.ts) and, only
        // above a cheap duration floor, logs the offending procedure + byte size.
        // Disarmed by default: a single boolean branch, then the original
        // withSpan+superjson. Kept EXACTLY as before — the write stays superjson.
        serialize: (data: any) =>
          instrumentSerialize(() =>
            withSpan('trpc:serialize:superjson', () => superjson.serialize(data))
          ),
        deserialize: unionDeserialize,
      },
    },
    errorFormatter({ shape }) {
      return shape;
    },
  });

export const { router, middleware, createCallerFactory } = t;
/**
 * Unprotected procedure
 **/
const isAcceptableOrigin = t.middleware(({ ctx: { user, acceptableOrigin }, next }) => {
  if (!acceptableOrigin)
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'Please use the public API instead: https://developer.civitai.com/',
    });
  return next({ ctx: { user, acceptableOrigin } });
});

// The CLIENT hash is a single global key (forced-client-update version/date
// gating), identical for every user and procedure. needsUpdate runs on EVERY
// web-client tRPC procedure, and tRPC batches multiple procedures per HTTP
// request, so an uncached hGetAll here is ~1 sysRedis round-trip PER PROCEDURE
// across all web traffic. Cache it in-process with a short TTL: gating a
// "refresh your browser" banner tolerates a few seconds of staleness trivially,
// and this collapses thousands of reads/s into ~1 read / TTL / pod. Only
// successful reads are cached, so the fail-open behavior below is preserved.
const CLIENT_CONFIG_TTL_MS = 5_000;
let clientConfigCache: { value: Record<string, string>; expiresAt: number } | null = null;
async function getClientConfigCached(): Promise<Record<string, string>> {
  const now = Date.now();
  if (clientConfigCache && clientConfigCache.expiresAt > now) return clientConfigCache.value;
  // Wall-clock deadline so a stalled/half-open sysRedis can't park this hGetAll for
  // OS-keepalive minutes (the sys client has no socketTimeout, and a per-command
  // timeout can't abort a written command). This read runs on EVERY web tRPC procedure
  // (behind the 5s cache above); a timeout here is caught by needsUpdate's try/catch
  // below and fails open (skips the update banner), never a 500.
  const client = await withSysReadDeadline(sysRedis.hGetAll(REDIS_SYS_KEYS.CLIENT));
  clientConfigCache = { value: client, expiresAt: now + CLIENT_CONFIG_TTL_MS };
  return client;
}

// TODO - figure out a better way to do this
async function needsUpdate(req?: NextApiRequest) {
  const type = req?.headers['x-client'] as string;
  const version = req?.headers['x-client-version'] as string;
  const date = req?.headers['x-client-date'] as string;

  if (type !== 'web') return false;
  // Fail open: if sysRedis is unreachable, don't force a client update —
  // every tRPC call runs through enforceClientVersion, so a throw here
  // would 500 every authenticated request during a sysRedis incident.
  let client: Record<string, string>;
  try {
    client = await getClientConfigCached();
  } catch (err) {
    logSysRedisFailOpen('read-degraded', 'needsUpdate', err);
    return false;
  }
  const clientVersion = decodeRedisString(client.version);
  if (clientVersion) {
    if (!version || version === 'unknown') return true;
    return semver.lt(version, clientVersion);
  }
  if (client.date) {
    if (!date) return true;
    return new Date(Number(date)) < new Date(client.date);
  }
  return false;
}

const enforceClientVersion = t.middleware(async ({ next, ctx }) => {
  // if (await needsUpdate(ctx.req)) {
  //   throw new TRPCError({
  //     code: 'PRECONDITION_FAILED',
  //     message: 'Update required',
  //     cause: 'Please refresh your browser to get the latest version of the app',
  //   });
  // }
  const result = await next();
  if (await needsUpdate(ctx.req)) {
    ctx.res?.setHeader('x-update-required', 'true');
    ctx.cache.edgeTTL = 0;
  }
  return result;
});

const applyDomainFeature = t.middleware(async (options) => {
  const { next, ctx } = options;
  // v11: `rawInput` became the async `getRawInput()`.
  const input = ((await options.getRawInput()) ?? {}) as { browsingLevel?: number };

  // Verified search-engine crawlers (set by botDetectionMiddleware) are
  // treated as authorized only on mature-allowed domains. On the SFW site
  // they're a regular public user — no level expansion. This enables the
  // bot bypass on civitai.red while keeping civitai.com strictly SFW for
  // crawlers and humans alike.
  const verifiedBot = parseVerifiedBotHeader(ctx.req?.headers[VERIFIED_BOT_HEADER]);
  const isAuthorized = !!ctx.user || (verifiedBot !== null && ctx.features.canViewNsfw);

  // Cap rules:
  //   anonymous (any domain), or bot on green → publicBrowsingLevelsFlag (PG)
  //   logged-in on green domain               → sfwBrowsingLevelsFlag    (PG, PG-13)
  //   logged-in or bot on blue/red            → no cap, respect caller
  const maxAllowed = !isAuthorized
    ? publicBrowsingLevelsFlag
    : !ctx.features.canViewNsfw
    ? sfwBrowsingLevelsFlag
    : undefined;

  if (maxAllowed !== undefined) {
    if (!input.browsingLevel) {
      input.browsingLevel = maxAllowed;
    } else {
      const intersection = input.browsingLevel & maxAllowed;
      input.browsingLevel = intersection || maxAllowed;
    }
  }

  return next();
});

/**
 * Token scope enforcement middleware (fail-safe).
 * - Session auth (no apiKeyId) is always allowed through unless blockApiKeys is set.
 * - Procedures without `.meta({ requiredScope })` implicitly require `TokenScope.Full`.
 *   Scoped tokens are denied on un-annotated endpoints; session and full-access keys
 *   pass through (subject to the blockApiKeys gate below).
 * - blockApiKeys: when set, the procedure is forbidden for any API-key/OAuth-token
 *   request regardless of scope. Used for buzz-spending operations that the
 *   orchestrator owns; tokens have no business spending buzz on Civitai's side.
 */
const enforceTokenScope = t.middleware(({ ctx, meta, next }) => {
  // blockApiKeys: deny any token-based request, regardless of scope. Session
  // auth (apiKeyId === null) is unaffected.
  if (meta?.blockApiKeys && ctx.apiKeyId != null) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'This action cannot be performed via API key or OAuth token.',
    });
  }

  // Session auth (cookies) and full-access API keys pass through scope check
  if (ctx.tokenScope === TokenScope.Full) {
    return next();
  }

  // Default unannotated endpoints to requiring Full scope
  const requiredScope = meta?.requiredScope ?? TokenScope.Full;

  if (!Flags.hasFlag(ctx.tokenScope, requiredScope)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your API key does not have the required scope for this action',
    });
  }

  return next();
});

// Time every procedure by path (full chain + resolver) so heavy-pool isolation
// candidates can be ranked by P99 x rate — the criterion behind the image-feed
// cutover. Placed first in the chain so it spans all downstream middleware + the
// resolver. All exported procedures derive from publicProcedure, so this covers
// every tRPC call. `path` is the fixed dotted procedure name.
//
// OPT-IN via TRPC_PROCEDURE_METRICS=true. This is a HIGH-cardinality metric:
// ~870 procedures x (buckets + sum + count) PER POD. Enabling it everywhere
// (api-primary 90-100 + heavy + SSR via createCaller + jobs ≈ 200 pods) would
// add hundreds of thousands of Prometheus active series. Enable it only on the
// pools whose isolation we're deciding (api-primary, api-heavy) and leave it off
// on SSR/jobs/canary to bound the series count and keep an instant off-switch.
const TRPC_PROCEDURE_METRICS = process.env.TRPC_PROCEDURE_METRICS === 'true';

// The actual procedure-timing logic. Generic over `next`'s return type so it
// stays transparent to tRPC's MiddlewareResult typing. Kept standalone so the
// ALS label wrapper can be applied ONLY when the long-task labels tier is armed.
//
// Always times the procedure (one `performance.now()` delta) so the always-on,
// threshold-gated slow-procedure log (`maybeLogTrpcSlow`) can NAME the offender on
// the next latency-tail spike — the gap that the OPT-IN `trpcProcedureDuration`
// metric leaves open by default. The metric histogram stays opt-in
// (`TRPC_PROCEDURE_METRICS`, high-cardinality); the slow log is free below
// threshold (a numeric compare) and emits at most one log line per slow procedure.
// A `.then()` on the existing promise (not an async IIFE) keeps the added overhead
// to a single callback + timestamp per procedure.
function runRecordProcedureDuration<T>(
  path: string,
  type: string,
  userId: number | undefined,
  next: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now();
  return next().then(
    (result) => {
      // tRPC MiddlewareResult: { ok: true; ... } | { ok: false; error: TRPCError }.
      // Read defensively so T stays transparent and a shape change can't throw.
      const r = result as unknown as { ok?: boolean; error?: { code?: string } };
      const ok = r?.ok !== false;
      const errorCode = r?.ok === false ? r.error?.code : undefined;
      const durationMs = performance.now() - startedAt;
      // Reuse the single performance.now() delta for BOTH the opt-in histogram and
      // the always-on slow-log — avoids startTimer's separate hrtime capture +
      // Object.assign per procedure. Same histogram semantics (wall-clock seconds).
      if (TRPC_PROCEDURE_METRICS) trpcProcedureDuration.observe({ path }, durationMs / 1000);
      maybeLogTrpcSlow({ path, type, durationMs, ok, errorCode, userId });
      return result;
    },
    (err) => {
      const durationMs = performance.now() - startedAt;
      if (TRPC_PROCEDURE_METRICS) trpcProcedureDuration.observe({ path }, durationMs / 1000);
      maybeLogTrpcSlow({
        path,
        type,
        durationMs,
        ok: false,
        errorCode: err instanceof TRPCError ? err.code : undefined,
        userId,
      });
      throw err;
    }
  );
}

const recordProcedureDuration = t.middleware(({ path, type, ctx, next }) => {
  const userId = ctx.user?.id;
  // When the long-task LABELS tier is armed, wrap the procedure in an ALS store
  // tagged with its path so a detected synchronous block can be attributed to the
  // running procedure. This costs one AsyncLocalStorage.run() per request — the
  // async_hooks context-propagation cost — so it is OFF by default. When it is not
  // armed (the disarmed default), the procedure-timing path is a single `.then()`
  // on the existing promise. Independent of TRPC_PROCEDURE_METRICS.
  if (longTaskLabelsArmed) {
    return runWithLongTaskLabel(`trpc:${path}`, () =>
      runRecordProcedureDuration(path, type, userId, next)
    );
  }
  return runRecordProcedureDuration(path, type, userId, next);
});

export const publicProcedure = t.procedure
  .use(recordProcedureDuration)
  .use(isAcceptableOrigin)
  .use(enforceClientVersion)
  .use(applyDomainFeature)
  .use(enforceTokenScope);

// Per-pod concurrency cap for CPU-heavy procedures (see request-bulkhead.ts).
// Fast-fails with 429 when a pod already has HEAVY_REQUEST_CONCURRENCY heavy
// requests in flight, so a backlog can't pin the single JS thread → probe
// timeout → Error/137. Keyed so the tRPC feed procedures and the REST
// /api/v1/images handler share one per-pod budget (they hit the same heavy path).
const withBulkhead = (key: string) =>
  t.middleware(async ({ next }) => {
    let release: () => void;
    try {
      release = acquireBulkheadSlot(key, HEAVY_REQUEST_CONCURRENCY);
    } catch (e) {
      if (e instanceof BulkheadFullError)
        throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'Server busy — please retry.' });
      throw e;
    }
    try {
      return await next();
    } finally {
      release();
    }
  });

/**
 * Public procedure for CPU-heavy endpoints (e.g. the image feed). Adds a per-pod
 * concurrency cap that fast-fails (429) under overload so a request backlog can't
 * pin the single JS thread and take the pod down.
 */
export const heavyProcedure = publicProcedure.use(withBulkhead('heavy-image'));

/**
 * Reusable middleware to ensure
 * users are logged in
 */
const isAuthed = t.middleware(({ ctx: { user, acceptableOrigin, ...ctx }, next }) => {
  if (!user || user.deletedAt) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (user.bannedAt)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You cannot perform this action because your account has been banned',
    });
  return next({
    ctx: { ...ctx, user, acceptableOrigin },
  });
});

const isMuted = middleware(async ({ ctx, next }) => {
  const { user } = ctx;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (user.muted)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You cannot perform this action because your account has been restricted',
    });

  return next({
    ctx: { ...ctx, user },
  });
});

const isMod = t.middleware(({ ctx: { user, acceptableOrigin, ...ctx }, next }) => {
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (!user.isModerator)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have permission to perform this action',
    });
  return next({
    ctx: { ...ctx, user, acceptableOrigin },
  });
});

export const isFlagProtected = (flag: keyof FeatureAccess) =>
  middleware(({ ctx, next }) => {
    const features = getFeatureFlags(ctx);
    if (!features[flag]) throw new TRPCError({ code: 'FORBIDDEN' });

    return next();
  });

const isOnboarded = t.middleware(({ ctx, next }) => {
  const { user } = ctx;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (!Flags.hasFlag(user.onboarding, OnboardingSteps.Buzz)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You must complete the onboarding process before performing this action',
    });
  }
  return next({
    ctx: { ...ctx, user },
  });
});

/**
 * Protected procedure
 **/
export const protectedProcedure = publicProcedure.use(isAuthed);

/**
 * Moderator procedure
 **/
export const moderatorProcedure = protectedProcedure.use(isMod);

/**
 * App developer procedure — authenticated + the `appBlocksAuthor` capability
 * (Flipt `app-blocks-author`, static fallback mod-only). Gates the App Blocks
 * AUTHOR surfaces (own submissions / revenue / analytics, withdraw, dev:live)
 * for a curated non-mod cohort WITHOUT granting the mod REVIEW/curation powers
 * (those stay on `moderatorProcedure`).
 *
 * Fail-CLOSED: `getFeatureFlags` resolves `appBlocksAuthor` from Flipt when the
 * flag exists, else falls back to the static `availability: ['mod']` — so an
 * absent flag / Flipt-down yields mods only, never open-to-all.
 */
const hasAppBlocksAuthor = t.middleware(({ ctx, next }) => {
  const features = getFeatureFlags(ctx);
  if (!features.appBlocksAuthor)
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You do not have access to Apps authoring',
    });
  return next();
});
export const appDeveloperProcedure = protectedProcedure.use(hasAppBlocksAuthor);

/**
 * Verified procedure to prevent users from making actions
 * if they haven't completed the onboarding process
 */
export const verifiedProcedure = protectedProcedure.use(isOnboarded);

/**
 * Guarded procedure to prevent users from making actions
 * based on muted/banned properties
 */
export const guardedProcedure = verifiedProcedure.use(isMuted);
