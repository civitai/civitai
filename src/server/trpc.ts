import { initTRPC, TRPCError } from '@trpc/server';
import {
  clampRequestBrowsingLevels,
  requestDomainBrowsingLevelCap,
  type RequestBrowsingLevels,
} from '~/server/utils/browsing-level';
import { requiresEmailVerification } from '~/server/common/email-verification-gate';
import { couldAwaitTosReacceptance } from '~/server/common/tos-reacceptance';
import { shouldOfferTosReacceptance } from '~/server/services/tos-reacceptance.service';
import type { NextApiRequest } from 'next';
import { OnboardingSteps } from '~/server/common/enums';
import { withSpan } from '~/server/utils/otel-helpers';
import {
  acquireBulkheadSlot,
  BulkheadFullError,
  HEAVY_REQUEST_CONCURRENCY,
} from '~/server/utils/request-bulkhead';
import { trpcProcedureDuration, trpcClientReadCapabilityRequests } from '~/server/prom/client';
import { recordTrpcCall } from '~/server/prom/route-traffic.metrics';
import { canDecodeDevalueResponse, isWebClient } from '~/server/utils/client-version-saturation';
import { maybeLogTrpcSlow } from '~/server/logging/trpc-slow-log';
import { longTaskLabelsArmed, runWithLongTaskLabel } from '~/server/eventloop-longtask';
import { currentSerializeCtx, instrumentSerialize } from '~/server/logging/trpc-serialize-log';
import { buildTransformer, onDevalueWriteFallback } from '~/shared/utils/trpc-union-transformer';
import { responseWriteSerialize, responseWritesDevalue } from '~/server/trpc/response-write-format';
import { logToAxiom } from '~/server/logging/client';
import { createFallbackDedup, fallbackDedupKeys } from '~/server/logging/devalue-fallback-log';
import { clientNeedsUpdate, getClientConfigCached } from '~/server/utils/client-config';
import { logSysRedisFailOpen } from '~/server/redis/fail-open-log';
import type { FeatureAccess } from '~/server/services/feature-flags.service';
import { getFeatureFlags } from '~/server/services/feature-flags.service';
import { Flags } from '~/shared/utils/flags';
import {
  assertSessionOrFullUserKey,
  runEnforceTokenScope,
} from '~/server/services/oauth/enforce-token-scope';
import { errorFormatter } from '~/server/trpc/error-formatter';
import type { Context } from './createContext';

// Attribute + ship each devalue-write fallback (a non-POJO response payload that
// fell back to superjson — see writeSerializeWithFallback). Path comes from the
// serialize ALS ctx because tRPC doesn't thread the procedure into the
// transformer (and onError never fires — the response still succeeds).
//
// The ctx path is the RAW, client-controlled, comma-joined batch string
// (`req.query.trpc`), so we normalize it to the individual offending
// procedure(s) (fallbackDedupKeys) before deduping — otherwise a client could
// re-frame one offender across many batches to defeat the window — and dedup
// through a SIZE-BOUNDED windowed map so a long-lived module can't grow it
// unboundedly. Each distinct procedure logs at most once per window; a
// multi-procedure batch (~1% of traffic) over-attributes to its co-batched
// procedures, which is an acceptable, bounded cost for the offender list.
const fallbackDedup = createFallbackDedup({ windowMs: 30_000, maxSize: 1000 });
onDevalueWriteFallback((error) => {
  const rawPath = currentSerializeCtx()?.path ?? 'unknown';
  const now = Date.now();
  const message = error instanceof Error ? error.message : String(error);
  for (const path of fallbackDedupKeys(rawPath)) {
    if (!fallbackDedup.shouldLog(path, now)) continue;
    void logToAxiom({
      name: 'devalue-write-fallback',
      type: 'warning',
      path,
      message,
    }).catch(() => undefined);
  }
});

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
  /**
   * When true, a token-based request must be a full-scope personal API key
   * (`isFullScopeUserKey`); session auth is unaffected.
   */
  requireFullUserCredential?: boolean;
}

const t = initTRPC
  .context<Context>()
  .meta<TRPCMeta>()
  .create({
    // superjson → devalue transformer migration: the HTTP response WRITE format
    // is chosen PER REQUEST (`responseWriteSerialize`, see
    // `src/server/trpc/response-write-format.ts`): devalue only when the pool's
    // `TRPC_WRITE_DEVALUE` master switch is on AND the request comes from a web
    // bundle that can decode it AND the response is not edge-cacheable;
    // superjson otherwise. READ stays the format-sniffing UNION. With the switch
    // off the wire is byte-for-byte superjson. The shared `buildTransformer`
    // fills the request-read / response-read (union) and request-write
    // (superjson, never exercised server-side) slots.
    transformer: buildTransformer((data: any) => {
      // instrumentSerialize times the serialize (the exact frame that pegs the
      // loop on an oversized response — see trpc-serialize-log.ts) and, only
      // above a cheap duration floor, logs the offending procedure + byte size.
      // The span label is read from the same per-request decision the write
      // uses, so the freeze-instrumentation frame name matches what is ACTUALLY
      // written (superjson vs devalue). The wrappers are pass-through.
      const devalue = responseWritesDevalue();
      return instrumentSerialize(() =>
        withSpan(`trpc:serialize:${devalue ? 'devalue' : 'superjson'}`, () =>
          responseWriteSerialize(data)
        )
      );
    }),
    errorFormatter,
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

async function needsUpdate(req?: NextApiRequest) {
  if (!isWebClient(req?.headers)) return false;
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
  return clientNeedsUpdate(req?.headers, client);
}

const enforceClientVersion = t.middleware(async ({ next, ctx }) => {
  // Serializer-migration saturation instrument: for WEB clients only, bucket this
  // procedure by whether the reported bundle can decode the union serializer
  // (Phase-1-capable). Bounded label (true/false), memoized semver compare — a
  // Map lookup on the hot path after warmup. Non-web (API-key / server-to-server)
  // requests have no browser bundle and are excluded so the ratio stays purely
  // about the SPA population the Phase-2 write-flip gate cares about. Counted
  // before next() so it reflects attempts even if the resolver throws.
  if (isWebClient(ctx.req?.headers)) {
    trpcClientReadCapabilityRequests.inc({
      phase1_capable: canDecodeDevalueResponse(ctx.req?.headers) ? 'true' : 'false',
    });
  }
  // if (await needsUpdate(ctx.req)) {
  //   throw new TRPCError({
  //     code: 'PRECONDITION_FAILED',
  //     message: 'Update required',
  //     cause: 'Please refresh your browser to get the latest version of the app',
  //   });
  // }
  const result = await next();
  // The header itself is set in the route's responseMeta: on a streamed batch the response head
  // is already written by now, and setting it here throws.
  if (await needsUpdate(ctx.req)) ctx.cache.edgeTTL = 0;
  return result;
});

const applyDomainFeature = t.middleware(async (options) => {
  const { next, ctx } = options;
  // v11: `rawInput` became the async `getRawInput()`.
  const input = ((await options.getRawInput()) ?? {}) as RequestBrowsingLevels;

  const maxAllowed = requestDomainBrowsingLevelCap(ctx);

  if (maxAllowed !== undefined) clampRequestBrowsingLevels(input, maxAllowed);

  return next();
});

/**
 * Token scope enforcement middleware (fail-safe).
 * - Session auth (no apiKeyId) always passes.
 * - Procedures without `.meta({ requiredScope })` implicitly require `TokenScope.Full`.
 *   Scoped tokens are denied on un-annotated endpoints; session and full-access keys
 *   pass through (subject to the blockApiKeys gate below).
 * - blockApiKeys: when set, the procedure is forbidden for any API-key/OAuth-token
 *   request regardless of scope (session auth only).
 * - requireFullUserCredential: when set, a token-based request must be a full-scope
 *   personal API key; OAuth tokens and other key types are forbidden.
 */
// `enforceTokenScope`'s body lives in a light standalone module so the OAuth
// scope-verification + unified scope-usage audit wiring is unit-testable without
// booting this heavy module. tRPC just wraps it.
const enforceTokenScope = t.middleware(({ ctx, meta, path, next }) =>
  runEnforceTokenScope({ ctx, meta, path, next })
);

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
  recordTrpcCall(ctx.req?.headers, !!ctx.user);
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
// Shared by `isAuthed` and `isAuthedAllowRestricted`, so a check added to what "signed in" means
// reaches both.
function requireSignedIn<U extends { deletedAt?: Date | null }>(user: U | null | undefined): U {
  if (!user || user.deletedAt) throw new TRPCError({ code: 'UNAUTHORIZED' });
  return user;
}

const isAuthed = t.middleware(({ ctx: { user: maybeUser, acceptableOrigin, ...ctx }, next }) => {
  const user = requireSignedIn(maybeUser);
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
  if (user.muted) {
    // `.catch`: this decides whether to OFFER a way out, never whether to refuse. A replica blip
    // rejecting here would turn the refusal into a 500 carrying the driver's message.
    const offer = couldAwaitTosReacceptance(user)
      ? await shouldOfferTosReacceptance(user.id).catch(() => false)
      : false;
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'You cannot perform this action because your account has been restricted',
      ...(offer ? { cause: { tosReacceptRequired: true } } : {}),
    });
  }

  return next({
    ctx: { ...ctx, user },
  });
});

const isEmailVerified = middleware(({ ctx, next }) => {
  const { user } = ctx;
  if (!user) throw new TRPCError({ code: 'UNAUTHORIZED' });
  if (requiresEmailVerification(user))
    throw new TRPCError({
      code: 'FORBIDDEN',
      // No `cause` flag: `errorFormatter` forwards only `softBlock` and `tosReacceptRequired` onto
      // `shape.data`, so anything else set here reaches no client. The banner is the way out, and it
      // reads the session rather than the error.
      message: 'Verify your email address to do this',
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
  assertSessionOrFullUserKey(ctx);
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
 * Moderator procedure. A token-based request must be a full-scope personal API key, whatever
 * `requiredScope` the procedure declares.
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

// Hubs are dark until the `user-hubs` Flipt flag exists. Fail-CLOSED: `userHubs`
// carries no static availability, so an absent flag / Flipt-down leaves every hub
// procedure refusing, which is the pre-hubs behaviour.
export const userHubProcedure = protectedProcedure.use(isFlagProtected('userHubs'));
// Reading one hub, which a public hub allows to anyone holding the link — signed
// out included. Every other hub verb stays on `userHubProcedure`.
export const publicUserHubProcedure = publicProcedure.use(isFlagProtected('userHubs'));

/**
 * Verified procedure to prevent users from making actions
 * if they haven't completed the onboarding process
 */
export const verifiedProcedure = protectedProcedure.use(isOnboarded);

/**
 * Guarded procedure to prevent users from making actions
 * based on muted/banned properties
 */
export const guardedProcedure = verifiedProcedure.use(isMuted).use(isEmailVerified);

/**
 * `guardedProcedure` minus the email-verification requirement.
 *
 * The gate lives on `guardedProcedure` so every content mutation inherits it without a call site being
 * edited, which means anything overlooked fails CLOSED. This is the deliberate way out, for the handful
 * of procedures that would otherwise 403 something the refusal is not meant to reach: reporting abuse,
 * appealing your own restriction, a browsing preference, and three queries a page needs to render.
 *
 * Reach for it only when a blocked procedure would break the user's ability to browse, to be judged, or
 * to complain — not merely because blocking it seems harsh.
 */
export const guardedProcedureAllowUnverifiedEmail = verifiedProcedure.use(isMuted);

const isAuthedAllowRestricted = t.middleware(({ ctx: { user, acceptableOrigin, ...ctx }, next }) =>
  next({ ctx: { ...ctx, user: requireSignedIn(user), acceptableOrigin } })
);

/**
 * Signed in, and nothing else: a banned or muted account passes, and so does one that never
 * finished onboarding. Those are exactly the accounts the site appeal form exists for, and every
 * other procedure refuses them.
 *
 * 🔴 For the site appeal form's two procedures only (`report.submitSiteAppeal`,
 * `report.getSiteAppealState`). A guard test fails if anything else is built on it.
 */
export const restrictedAccountAppealProcedure = publicProcedure
  .use(isAuthedAllowRestricted)
  .use(isFlagProtected('siteAppealForm'));
