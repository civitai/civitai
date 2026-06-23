import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  KNOWN_SLOT_IDS as SLOT_KNOWN_SLOT_IDS,
  isLaunchSlot,
  PAGE_SLOT_ID,
} from '~/shared/constants/slot-registry';
import { env } from '~/env/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { FORGEJO_ORG } from '~/server/services/blocks/forgejo.service';
import { logToAxiom } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { parseSubjectUserId, verifyBlockToken } from '~/server/middleware/block-scope.middleware';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { dailyBoostReward } from '~/server/rewards/active/dailyBoost.reward';
import { getUserBuzzAccounts } from '~/server/services/buzz.service';
import { manifestSettingsSchema } from '~/server/schema/blocks/manifest-settings.meta.schema';
import { validateBlockSettings } from '~/server/services/blocks/settings-validator.service';
import {
  getAppDetailSchema,
  getFeaturedBlocksSchema,
  getMarketplaceMetaSchema,
  listAppBlockReviewsSchema,
  listAvailableSchema,
  setAppReviewExcludedSchema,
  setMarketplaceMetaSchema,
  subscriptionScopeSchema,
  upsertAppBlockReviewSchema,
} from '~/server/schema/blocks/subscription.schema';
import {
  getMyAppBlockReview,
  listAppBlockReviews,
  setAppReviewExcluded,
  upsertAppBlockReview,
} from '~/server/services/appBlockReview.service';
import { appBlockReviewReward } from '~/server/rewards/active/appBlockReview.reward';
import {
  approveRequestSchema,
  backfillPublishRequestSchema,
  getMyPendingForSlugSchema,
  getPublishRequestScreenshotsSchema,
  listApprovedRequestsSchema,
  listPendingRequestsSchema,
  listRejectedRequestsSchema,
  rejectRequestSchema,
  withdrawRequestSchema,
} from '~/server/schema/blocks/publish-request.schema';
import { blockWorkflowBodySchema } from '~/server/schema/blocks/workflow.schema';
import {
  allowMatureContentForCeiling,
  domainBrowsingCeiling,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { rateLimit } from '~/server/middleware.trpc';
import { BlockRegistry } from '~/server/services/block-registry.service';
import {
  emptyRevenue,
  getRecentAttributionsForOwner,
  getRevenueForOwner,
} from '~/server/services/blocks/buzz-attribution.service';
import {
  emptyAnalytics,
  getMyAppAnalytics,
  resolveRange,
} from '~/server/services/blocks/app-analytics.service';
import {
  getRepresentativeBaseModel,
  resolveBlockCheckpoint,
  validateBlockCheckpoint,
} from '~/server/services/blocks/checkpoint.service';
import { getModelShowcaseImages } from '~/server/services/blocks/showcase.service';
import { getRequestDomainColor } from '~/server/utils/server-domain';
// Type-only: the runtime `resolveCanGenerateForVersions` is loaded via a
// dynamic import() inside assertViewerCanGeneratePageResources so the heavy
// generation-service import graph (image.service → event-engine-common, etc.)
// stays OUT of this router's static import graph — mirroring the existing
// lazy import of recordScopeInvocation below.
import type { ResolveCanGenerateVersion } from '~/server/services/generation/generation.service';
import {
  buildTextToImageInput,
  isPageLoraResource,
  resolveBlockVersionContext,
  resolvePageResourceContext,
  snapshotFromWorkflow,
} from '~/server/services/blocks/workflow.service';
import { getResourceGenerationSupport } from '~/shared/constants/basemodel.constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { BuzzTypes } from '~/shared/constants/buzz.constants';
import { getBaseModelSetType, WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { cancelWorkflow, getWorkflow, submitWorkflow } from '~/server/services/orchestrator/workflows';
import {
  buildGenerationContext,
  createWorkflowStepsFromGraphInput,
} from '~/server/services/orchestrator/orchestration-new.service';
import { getUserById } from '~/server/services/user.service';
import {
  guardedProcedure,
  moderatorProcedure,
  protectedProcedure,
  middleware,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import type { SessionUser } from 'next-auth';

/**
 * H-2: every blocks router procedure gates on the Flipt flag. When the
 * substrate is dark:
 *   - listForModel returns an empty array (existing public callers see
 *     "no blocks installed" rather than a confusing error)
 *   - mutations throw UNAUTHORIZED
 *
 * The check runs first thing so a flag flip can shut the substrate down
 * without redeploying.
 *
 * H2: evaluated with the request user's context (`ctx.user`) so the live
 * `moderators`-segmented Flipt flag resolves ON for a moderator and OFF for a
 * non-mod / anon caller — same eval the client gate uses. `ctx.user` is the
 * server-side session user, so `isModerator` can't be spoofed by the client.
 */
const enforceAppBlocksFlag = middleware(async ({ ctx, next, type }) => {
  if (await isAppBlocksEnabled({ user: ctx.user })) return next();
  if (type === 'query') {
    // listForModel and friends — return empty rather than throw, so callers
    // that always render the slot don't surface an error.
    return next({ ctx: { _appBlocksDisabled: true } });
  }
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'App Blocks not enabled' });
});

/**
 * Phase 2 (internal-only graduation gate): App Blocks is moderator-only until
 * GA. The management procedures use `moderatorProcedure` so the tRPC session
 * user is checked at the procedure layer. But the runtime/read procedures are
 * `publicProcedure` — they authenticate a block JWT that resolves to a viewer
 * userId rather than `ctx.user`. For those, we re-assert that the RESOLVED
 * viewer is a moderator (don't trust "only mods get block tokens" — block-token
 * minting is also gated, but defense-in-depth means each call re-checks).
 *
 * Factored into one helper so the check can't drift across the ~14 call sites.
 * Throws FORBIDDEN for a non-mod (or vanished) user.
 *
 * (Internal-only graduation gate — remove/relax at GA alongside the feature
 * flag's `availability` widening.)
 */
async function assertViewerIsModerator(userId: number): Promise<void> {
  const row = await getUserById({ id: userId, select: { id: true, isModerator: true } });
  if (!row?.isModerator) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'App Blocks is restricted to the civitai team',
    });
  }
}

/**
 * App-Blocks flag gate for the BLOCK-TOKEN-authed runtime procs
 * (estimate/submit/poll/cancelWorkflow, updateUserSettings).
 *
 * WHY THIS EXISTS — `enforceAppBlocksFlag` (the middleware) evaluates the flag
 * against `ctx.user` (the request's SESSION user). These procs are
 * `publicProcedure` authenticated by a BLOCK JWT, NOT a civitai.com session: a
 * page-host call carries a session, but a `dev:live` (localhost) call is
 * block-token-only and has NO session cookie → `ctx.user` is `undefined`. The
 * live `app-blocks-enabled` flag is base-`false` with a `moderators` segment, so
 * a no-user (global) eval can never match the segment → resolves `false` →
 * UNAUTHORIZED "App Blocks not enabled", even when the token's subject IS a
 * moderator. The flag must therefore be evaluated against the TOKEN's subject
 * user, not `ctx.user`.
 *
 * The flag stays a real kill-switch (a flip still shuts these procs down) — we
 * only fix the IDENTITY it's evaluated against. This does NOT widen access: the
 * mod-segmented flag resolves `true` only for a moderator subject; a non-mod or
 * anon (`sub:'anon'` → no resolvable user) subject still resolves `false` →
 * blocked. `verifyBlockToken` (caller) already rejected invalid/expired/revoked
 * tokens before this runs, and `assertViewerIsModerator` + every other belt
 * (budget cap, daily Buzz cap, reserveBlockBuzzSpend, getOrchestratorToken,
 * forced-SFW) are unchanged — this only swaps which identity the FLAG sees.
 *
 * Reads `isModerator` from the DB (the server-side user row), never a
 * client-supplied value, so the segment match can't be spoofed.
 */
async function assertAppBlocksEnabledForTokenUser(userId: number): Promise<void> {
  const row = await getUserById({ id: userId, select: { id: true, isModerator: true } });
  // A vanished user → no SessionUser → global eval → flag false → blocked
  // (fail-closed; the subsequent assertViewerIsModerator would also reject).
  const user = row ? (row as unknown as SessionUser) : undefined;
  if (!(await isAppBlocksEnabled({ user }))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'App Blocks not enabled' });
  }
}

// ---- W10 page generation spend --------------------------------------------
//
// A model-slot token's ctx is `{ modelId, slotId }` (the install binds the
// generator to ONE model). A page-slot token's ctx is `{ slotId, entityType:
// 'none' }` — a page is stateless, has NO model binding, and lets the viewer
// pick ANY model they're entitled to generate against. `entityType === 'none'`
// is the discriminator the mint stamps (see the page path in
// block-tokens/index.ts); model tokens never carry `entityType`.
function isPageToken(claims: { ctx?: unknown }): boolean {
  return (claims.ctx as { entityType?: unknown } | undefined)?.entityType === 'none';
}

// ---- Maturity enforcement (GA gate) ---------------------------------------
//
// AUTHORITATIVE server-side belt. The maturity ceiling comes from the TOKEN's
// `maxBrowsingLevel` claim (server-minted from the request host at issuance —
// see block-tokens/index.ts), NEVER from a client-supplied body field, so a
// block on a SFW domain (green/blue) cannot generate mature output even if its
// own code is wrong or malicious.
//
// FAIL CLOSED: a token minted before this feature (or any token missing the
// numeric claim) is treated as the most restrictive SFW ceiling, never as
// "unrestricted". `verifyBlockToken` already rejects a present-but-non-numeric
// claim, so by here the value is either a finite number or undefined.
//
// Returns:
//   - maxBrowsingLevel:   the effective ceiling (claim value, or SFW fallback)
//   - allowMatureContent: the orchestrator flag derived from it
//                         (`false` on SFW, `undefined`/no-clamp only on red)
//   - isGreen:            the prompt-audit's "SFW prompt audit" toggle — true
//                         whenever the ceiling is SFW (i.e. NOT mature-allowed)
function resolveBlockMaturity(claims: { maxBrowsingLevel?: number }): {
  maxBrowsingLevel: number;
  allowMatureContent: boolean | undefined;
  isGreen: boolean;
} {
  const maxBrowsingLevel =
    typeof claims.maxBrowsingLevel === 'number' && Number.isFinite(claims.maxBrowsingLevel)
      ? claims.maxBrowsingLevel
      : sfwBrowsingLevelsFlag; // fail closed
  const allowMatureContent = allowMatureContentForCeiling(maxBrowsingLevel);
  return {
    maxBrowsingLevel,
    allowMatureContent,
    // `auditPromptServer`'s `isGreen` flag selects the SFW prompt audit. Tie it
    // to the maturity ceiling rather than the literal green domain: a blue
    // (SFW, per the App-Blocks product decision) block gets the SFW audit too.
    isGreen: allowMatureContent === false,
  };
}

// SECURITY-CRITICAL (W10). A page token has no model binding, so the model-
// binding check (`ctxModelId === body.modelId`) that bounds a model slot does
// NOT apply. The replacement bound is a PRE-SPEND slice of the platform's
// generation-entitlement gate (`resolveCanGenerateForVersions` →
// `getResourceCanGenerate`): the REAL viewer must clear availability,
// generationCoverage, status, members-only usageControl, the hidden-gates set,
// and base-model-supported. Without this, "any public model" would silently
// bypass those per-model gates before we ever cost/reserve.
//
// SCOPE — what this gate does NOT cover: early-access `hasAccess` and the
// availability=Private subscription requirement are NOT checked here.
// `resolveCanGenerateForVersions` deliberately omits both. They are enforced
// downstream by the orchestrator resource belt in `getGenerationResourceData`
// (server/services/orchestrator/common.ts): `getResourceData` folds
// `canGenerate = hasAccess && canGenerate` and the Private-resource path
// throws without an active subscription — and BOTH the whatIf (estimate) and
// the real (submit) steps run through that belt BEFORE any Buzz reservation.
// DO NOT remove that belt assuming this pre-spend gate already covers
// early-access / Private — it does not.
//
// Pass the REAL viewer context (their id + real isModerator + the request's
// sfwOnly/wildcards flags) — never an elevated context. Today the viewer is
// always a mod (assertViewerIsModerator), so they see mod-level access, which
// is correct platform behaviour; when GA opens to non-mods the same gate bounds
// them properly. Fail-closed: a version missing from the result Map → FORBIDDEN.
//
// Page-LoRA (Increment 1): generalized from 1→N versions. The checkpoint AND
// every picked LoRA are gated in ONE `resolveCanGenerateForVersions` call (it
// already takes an array and returns a Map keyed by version id). FAIL CLOSED if
// ANY gate's canGenerate is false OR the version is missing from the result Map
// — a missed entry must deny, never default-allow.
async function assertViewerCanGeneratePageResources(opts: {
  gates: ReturnType<typeof buildGateVersion>[];
  viewer: { id: number; isModerator: boolean };
  sfwOnly: boolean;
  wildcardsEnabled: boolean;
}): Promise<void> {
  const { gates, viewer, sfwOnly, wildcardsEnabled } = opts;
  const { resolveCanGenerateForVersions } = await import(
    '~/server/services/generation/generation.service'
  );
  const states = await resolveCanGenerateForVersions(gates, {
    user: { id: viewer.id, isModerator: viewer.isModerator },
    sfwOnly,
    wildcardsEnabled,
  });
  for (const gate of gates) {
    const canGenerate = states.get(gate.id)?.canGenerate ?? false;
    if (!canGenerate) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'a selected resource is not available for generation',
      });
    }
  }
}

// Narrow the `gate` bag `resolveBlockVersionContext` returns into the exact
// `ResolveCanGenerateVersion` shape (the DB column types are wider than the
// gate's string enums). Centralised so estimate + submit can't drift.
function buildGateVersion(gate: {
  id: number;
  status: string;
  availability: string;
  usageControl: string;
  baseModel: string;
  covered: boolean | null | undefined;
  modelUserId: number;
  modelType: string;
  modelVersionAlias: unknown;
}): ResolveCanGenerateVersion {
  return gate as unknown as ResolveCanGenerateVersion;
}

// Page-LoRA (Increment 1; GA): resolve + validate the page's additional-
// resource (LoRA) stack from `body.additionalResources`. For each entry it:
//   1. resolves the version statelessly (NO modelId binding — pages have none),
//   2. enforces LoRA-only v1 (rejects any non-LoRA additional resource), and
//   3. enforces the platform's REAL generation-compatibility check against the
//      checkpoint.
// The compatibility check is the correctness boundary: the orchestrator belt
// filters by resource TYPE (common.ts keeps a LoRA-typed resource), NOT by
// generation compatibility — so an incompatible LoRA of type LORA is PASSED
// downstream and billed for, producing a gen the viewer paid for that quietly
// ignored (or degraded) their LoRA. This explicit check is what prevents such a
// LoRA from being sent (and charged) at all.
//
// GA change: this previously collapsed both sides to a coarse base-model FAMILY
// (getBaseModelSetType, e.g. all SDXL variants → 'SDXL') and required exact
// equality — which rejected platform-VALID cross-ecosystem LoRAs (e.g. a Pony
// LoRA on an SDXL checkpoint). It now defers to the platform's own
// generation-compatibility model via `getResourceGenerationSupport`, the SAME
// function the generation form / orchestrator pipeline uses
// (getResourceEcosystemCompatibility, areResourcesCompatible). A non-null
// SupportLevel ('full' | 'partial') = the platform considers this LoRA
// generatable against this checkpoint (same-ecosystem OR an explicit
// cross-ecosystem rule); `null` = NOT compatible → reject. This widens what's
// accepted to exactly the platform's definition while staying FAIL-CLOSED.
//
// FAIL-CLOSED on unknown: `getResourceGenerationSupport` does
// `baseModelByName.get(...)` for BOTH the checkpoint and the LoRA baseModel and
// returns `null` when either is unrecognized (an UNKNOWN baseModel STRING) — so
// an unknown checkpoint baseModel OR an unknown LoRA baseModel → null → reject.
//
// BUT the null check ALONE does NOT cover one case the old family collapse did:
// the platform's RECOGNIZED baseModel record literally named 'Other'
// (basemodel.constants.ts BM.Other → ecosystemId ECO.Other). For that record
// `baseModelByName.get('Other')` SUCCEEDS, so a ('Other' checkpoint, 'Other'
// LoRA) pair resolves both sides to the SAME ECO.Other ecosystem and
// getGenerationSupport returns 'full' at its same-ecosystem short-circuit
// (BEFORE the disabled/coverage checks) → non-null → ACCEPT. That is a
// fail-OPEN on a billing boundary against the platform's "unclassified" bucket.
// The old `getBaseModelSetType(...) === 'Other'` guard caught it because that
// helper maps BOTH unknown strings AND the literal-'Other' record to the
// 'Other' ecosystem key. We therefore RE-ADD an explicit 'Other'-group reject
// (below, before/independent of the support call) so BOTH the literal-'Other'
// and unrecognized-string cases stay FAIL-CLOSED — fail-closed is mandatory on
// this gate.
//
// `checkpointBaseModel` MUST be the baseModel of the ACTUAL checkpoint
// resolveBlockCheckpoint resolves (the anchor buildTextToImageInput uses), NOT
// the page body model — for a non-Checkpoint page body those differ.
//
// Returns the per-LoRA gate bags so the caller can pass checkpoint + every LoRA
// through the entitlement gate in ONE call. Throws BAD_REQUEST (non-LoRA /
// not platform-compatible incl. unknown baseModel), NOT_FOUND
// (missing/unpublished version) — all BEFORE any cost/spend.
async function resolvePageLoraGates(opts: {
  additionalResources: { modelVersionId: number; strength: number }[] | undefined;
  checkpointBaseModel: string;
}): Promise<ReturnType<typeof buildGateVersion>[]> {
  const { additionalResources, checkpointBaseModel } = opts;
  if (!additionalResources?.length) return [];
  // FAIL-CLOSED on the 'Other' ecosystem group. getResourceGenerationSupport's
  // null check does NOT catch the platform's recognized 'Other' baseModel
  // record (it resolves to a real ECO.Other ecosystem and short-circuits to
  // 'full' same-ecosystem), so a ('Other', 'Other') pair would fail OPEN. If
  // the resolved CHECKPOINT baseModel is in the 'Other' group we can't
  // establish compatibility for ANY LoRA — reject up front, before/independent
  // of the support call. getBaseModelSetType maps BOTH unknown strings and the
  // literal-'Other' record to 'Other', closing both holes.
  if (getBaseModelSetType(checkpointBaseModel) === 'Other') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'a selected LoRA is not compatible with the checkpoint base model',
    });
  }
  const gates: ReturnType<typeof buildGateVersion>[] = [];
  for (const r of additionalResources) {
    const lora = await resolvePageResourceContext(r.modelVersionId);
    // LoRA-only v1. A non-LoRA additional resource (Checkpoint, VAE, embedding,
    // etc.) is rejected at the boundary rather than silently passed downstream.
    if (!isPageLoraResource(lora.modelType)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'additional resources must be LoRA models',
      });
    }
    // Platform generation-compatibility check (correctness boundary; the belt
    // filters by type, not compatibility, so it would PASS an incompatible LoRA
    // and bill for it). `null` = NOT generatable against this checkpoint per the
    // platform's own model — including when EITHER baseModel is unrecognized
    // (fail-closed on unknown). A non-null SupportLevel ('full'|'partial') means
    // the platform permits it, which now allows same-ecosystem AND platform-
    // defined cross-ecosystem LoRAs (e.g. a Pony LoRA on an SDXL checkpoint).
    // FAIL-CLOSED on the 'Other' ecosystem group for the LoRA side too — same
    // reasoning as the checkpoint guard above: the support call would return
    // 'full' for a literal-'Other' LoRA against an 'Other' checkpoint, so reject
    // an 'Other'-group LoRA before/independent of the support call.
    if (getBaseModelSetType(lora.baseModel) === 'Other') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'a selected LoRA is not compatible with the checkpoint base model',
      });
    }
    const support = getResourceGenerationSupport(
      checkpointBaseModel,
      lora.baseModel,
      lora.modelType as ModelType
    );
    if (support === null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'a selected LoRA is not compatible with the checkpoint base model',
      });
    }
    gates.push(buildGateVersion(lora.gate));
  }
  return gates;
}

// ---- Cumulative Buzz-spend cap (audit A7 / design-gaps H1) -----------------
//
// `claims.buzzBudget` is a PER-CALL ceiling only. Without an aggregate cap, a
// block holding a valid token (15-min lifetime, freely re-minted) can issue
// unlimited sequential `submitWorkflow` calls each ≤ budget and drain the
// viewer's entire Buzz balance. This adds a per-(USER, UTC-day) cumulative
// ceiling enforced server-side in submitWorkflow, backed by a Redis counter
// that self-expires at the end of its window.
//
// PER-USER aggregate (NOT per-(user, app_block)): the key intentionally omits
// appBlockId so EVERY block a user has installed spends against ONE shared
// daily ceiling. A per-block key let a publisher multiply the effective cap by
// spinning up N blocks (N × 50,000/day). One key per user closes that.
//
// Enforcement is an atomic RESERVE-AND-REFUND rather than read→check→record:
//   - reserveBlockBuzzSpend INCRBYs the cost FIRST and returns the new running
//     total. INCRBY is atomic, so two concurrent submits can't both read a
//     stale total and both pass — the TOCTOU in the old read+record shape.
//   - if the reservation pushes the total over the cap we REFUND (DECRBY) and
//     reject; otherwise the reservation stands as the spend record (no separate
//     fire-and-forget incr that could silently drop and under-count).
//   - on a throw anywhere between reserve and a resolved submitWorkflow we
//     refund, matching the old semantics (which only recorded after a resolved
//     submit). A resolved submit KEEPS the reservation regardless of snapshot
//     status (the old code recorded after submitWorkflow resolved, including a
//     returned `failed` snapshot).
// A failed refund slightly OVER-counts (the reservation lingers), which makes
// the cap STRICTER, not looser — the safe direction for an abuse cap. A Redis
// error on the reserve throws and fails the submit CLOSED, identical to the old
// read path's fail-closed posture.
//
// The aggregate ceiling is a fixed platform default today. When the W5 consent
// layer lands (app_user_scope_grants), the per-install/consent aggregate limit
// should override this default — surfaced to the user at install/consent time.
const BLOCK_BUZZ_CAP_PER_DAY = 50_000;
// 25h TTL: comfortably covers a UTC-day window plus clock skew; the key is
// re-derived per day so a stale counter never bleeds into the next window.
const BLOCK_BUZZ_CAP_TTL_SECONDS = 25 * 60 * 60;

function buzzCapWindowKey(): string {
  // UTC calendar day, e.g. '2026-06-02'.
  return new Date().toISOString().slice(0, 10);
}

function buzzCapRedisKey(userId: number): `${typeof REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:${string}` {
  // PER-USER aggregate: appBlockId is intentionally NOT part of the key so all
  // of a user's installed blocks share ONE daily ceiling (see comment above).
  return `${REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:${userId}:${buzzCapWindowKey()}`;
}

/**
 * Atomically reserves `cost` against this user's cumulative UTC-day counter and
 * returns the new running total. INCRBY is atomic, so concurrent submits
 * accumulate correctly with no read→check→record TOCTOU. Sets the TTL on the
 * (effectively) first write so the per-window key self-expires (the ttl<0 guard
 * also re-arms a key that somehow lost its TTL). No try/catch: a Redis error
 * throws and fails the submit CLOSED, identical to the old read path.
 */
async function reserveBlockBuzzSpend(
  userId: number,
  cost: number
): Promise<{ total: number; key: ReturnType<typeof buzzCapRedisKey> }> {
  const key = buzzCapRedisKey(userId);
  const total = await sysRedis.incrBy(key, Math.ceil(cost));
  if (total <= Math.ceil(cost)) {
    await sysRedis.expire(key, BLOCK_BUZZ_CAP_TTL_SECONDS);
  } else {
    const ttl = await sysRedis.ttl(key);
    if (ttl < 0) await sysRedis.expire(key, BLOCK_BUZZ_CAP_TTL_SECONDS);
  }
  // Return the resolved key so the caller refunds against the EXACT same key it
  // reserved — see refundBlockBuzzSpend for why re-deriving is unsafe.
  return { total, key };
}

/**
 * Refunds a previously-reserved `cost` (best-effort DECRBY) against the EXACT
 * key returned by reserveBlockBuzzSpend. Used when the reservation pushed the
 * total over the cap, or when the submit path throws before a resolved
 * submitWorkflow. Best-effort: a failed refund leaves the reservation in place,
 * which OVER-counts and so only makes the cap STRICTER — the safe direction for
 * an abuse cap. Never throws into the caller.
 *
 * Takes the reserved key rather than re-deriving it from userId: the key embeds
 * the UTC-day window, and the throw-path refund runs AFTER the (multi-second)
 * submitWorkflow, so re-deriving could land on the NEXT day's key if the request
 * straddled midnight UTC — decrementing an empty key to a negative, TTL-less
 * value and handing the user a window of extra cap headroom. Pinning the key
 * eliminates that race.
 */
async function refundBlockBuzzSpend(
  key: ReturnType<typeof buzzCapRedisKey>,
  cost: number
): Promise<void> {
  await sysRedis.decrBy(key, Math.ceil(cost)).catch(() => {
    /* best-effort — see note above; a lost refund over-counts (stricter cap) */
  });
}

// Free-form slot strings are a cache-busting surface for anon callers. Bound
// to the explicit model-slot set; the canonical source is now the slot registry
// (src/shared/constants/slot-registry.ts) — re-exported under the SAME name so
// the reuse sites below (listForModel/installOnModel/getEffectiveCheckpoint
// inputs) are untouched and the model contract stays byte-identical. The page
// slot is intentionally NOT in this enum: page tokens never flow through the
// model slotContext / install procs.
const KNOWN_SLOT_IDS = SLOT_KNOWN_SLOT_IDS;

// JSON settings get echoed back to every BlockSlot consumer and stamped on the
// JWT issuance side. Cap size to keep both budgets bounded.
//
// H5: cap is in BYTES, not UTF-16 code units. The previous `.length` count
// let a settings blob double its real byte size via 4-byte UTF-8 sequences
// (emoji, certain CJK ranges). Buffer.byteLength is the right unit.
const settingsSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 4096, {
    message: 'settings exceeds 4KB',
  });

/**
 * Asserts that the current user owns the model or is a moderator. Throws
 * UNAUTHORIZED otherwise. Used by every mutating block procedure.
 */
async function assertCanManageBlocks(
  ctx: { user?: { id: number; isModerator?: boolean } },
  modelId: number
) {
  if (!ctx.user) throw throwAuthorizationError('Not authenticated');
  if (ctx.user.isModerator) return;
  // B2: read from the primary, not the replica. Former-owner-during-
  // replication-lag and just-transferred-model windows otherwise leave the
  // attacker with a small TOCTOU window between the auth check (replica)
  // and the mutation (primary).
  const row = await dbWrite.model.findUnique({
    where: { id: modelId },
    select: { userId: true },
  });
  if (!row) throw throwNotFoundError('Model not found');
  if (row.userId !== ctx.user.id) throw throwAuthorizationError('Not the model owner');
}

/**
 * PAGE-ONLY LAUNCH GATE (install path). Rejects a non-launch slot for the
 * public (non-moderator) audience; moderators are grandfathered (the live
 * mod-only model-slot apps keep installing). Mod status is the server-stamped
 * session flag (`ctx.user?.isModerator`), the same source every other belt in
 * this router uses. `isLaunchSlot` is the single source of truth for "in the
 * launch surface" — no hardcoded slot id here.
 */
function assertLaunchSlotForCaller(
  ctx: { user?: { id: number; isModerator?: boolean } },
  slotId: string
) {
  if (ctx.user?.isModerator) return; // grandfather mods
  if (isLaunchSlot(slotId)) return; // launch (page) slots are public-OK
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'This app type isn’t available yet.',
  });
}

/**
 * Manifest-level variant of {@link assertLaunchSlotForCaller} for the
 * subscription path, where the slot isn't an input — it's implied by the app's
 * manifest targets. A model-slot app (the only kind that takes a subscription;
 * page apps are stateless and never subscribed) is non-launch, so a non-mod is
 * rejected. A moderator is grandfathered. An app is launch-eligible iff it
 * declares a page AND `app.page` is a launch slot (mirrors the service's
 * isAppLaunchEligible / the public-read filter, keeping the allowlist the single
 * source of truth).
 */
function assertLaunchAppForCaller(
  ctx: { user?: { id: number; isModerator?: boolean } },
  manifest: unknown
) {
  if (ctx.user?.isModerator) return; // grandfather mods
  const declaresPage =
    !!manifest &&
    typeof (manifest as { page?: unknown }).page === 'object' &&
    (manifest as { page?: unknown }).page !== null &&
    typeof (manifest as { page?: { path?: unknown } }).page?.path === 'string' &&
    ((manifest as { page: { path: string } }).page.path?.length ?? 0) > 0;
  if (isLaunchSlot(PAGE_SLOT_ID) && declaresPage) return; // a launch page app
  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'This app type isn’t available yet.',
  });
}

async function resolveModelIdFromBlockInstance(blockInstanceId: string): Promise<number> {
  // B2 (same posture as above): dbWrite for the ownership-relevant lookup.
  // updateSettings is publisher-only and only ever operates on pinned
  // subscription rows (the per-model-install shape, post kill_per_model
  // _installs). Synthetic ids (pdb_*, bus_pub_*, bus_view_*) don't have
  // settings writable via this route — blanket subscription settings use
  // blocks.upsertSubscription, platform defaults aren't settings-writable.
  // A synthetic id reaching this path is a client bug; the findUnique
  // below returns null and we 404.
  const row = await dbWrite.blockUserSubscription.findUnique({
    where: { blockInstanceId },
    select: { targetModelIds: true },
  });
  if (!row) throw throwNotFoundError('Block install not found');
  // Pinned subscriptions always have exactly one modelId in target_model
  // _ids; defensive .at(0) so a bad data shape doesn't NaN downstream.
  const modelId = row.targetModelIds?.[0];
  if (!modelId) throw throwNotFoundError('Block install not found');
  return modelId;
}

// Replacement for the deleted legacy `createTextToImageStep`. Builds the single
// txt2img workflow step from the block's generation-graph `input` (produced by
// `buildTextToImageInput`) via the new generation-graph pipeline, WITHOUT
// submitting — the router keeps driving its own `submitWorkflow` calls so the
// App-Blocks belts (per-call buzz budget, cumulative daily Buzz cap, token-
// derived maturity clamp, daily-boost autoclaim) wrap submit unchanged.
//
// Flags are intentionally NOT threaded into `buildGenerationContext` (passed
// `undefined`): the legacy step never applied flag-driven adjustments (e.g. the
// SDCPP 2-for-1 quantity bonus) either, so omitting them keeps the block's cost
// profile identical to before. The resource entitlement belt still runs.
async function createBlockTextToImageStep(opts: {
  input: Record<string, unknown>;
  user: SessionUser;
  whatIf?: boolean;
  isGreen?: boolean;
}) {
  const { externalCtx } = await buildGenerationContext(opts.user.tier ?? 'free', undefined, {
    id: opts.user.id,
    isModerator: opts.user.isModerator,
  });
  const steps = await createWorkflowStepsFromGraphInput({
    input: opts.input,
    externalCtx,
    user: { id: opts.user.id, isModerator: opts.user.isModerator },
    isWhatIf: opts.whatIf,
    isGreen: opts.isGreen,
  });
  // The block path is plain txt2img with no snippet fan-out, so the graph
  // always yields exactly one step. Fail closed if that invariant breaks rather
  // than silently submitting a partial / multi-step workflow.
  const step = steps[0];
  if (!step || steps.length !== 1) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'expected a single generation step',
    });
  }
  return step;
}

export const blocksRouter = router({
  /**
   * Lists enabled block installs for a (modelId, slotId). Public — anon users
   * see the same blocks as authenticated users; the host stamps the viewer
   * context on the iframe at token-issuance time.
   */
  listForModel: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        modelId: z.number().int().positive(),
        slotId: KNOWN_SLOT_IDS,
        modelType: z.string().min(1).max(64).optional(),
        modelNsfwLevel: z.number().int().nonnegative().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) return [];
      // App Blocks visibility is gated by the `appBlocks` feature flag
      // (availability ['mod'] in prod today, 'public' once GA'd / on the
      // anon-conversion preview) — NOT a hardcoded moderator check. The old
      // `!ctx.user?.isModerator` gate returned [] for every anon / non-mod
      // viewer even when the flag was public, so the slot rendered but never
      // received installs — the anonymous-conversion flow's blocks never
      // appeared. ctx.features mirrors the client `useFeatureFlags()` gate and
      // the block-token mint gate (getFeatureFlags(...).appBlocks), keeping all
      // three consistent. In prod the flag is mod-only, so a direct tRPC call
      // from a non-mod still gets [] (nothing leaks pre-GA).
      if (!ctx.features.appBlocks) return [];
      return BlockRegistry.listForModel({
        ...input,
        viewerUserId: ctx.user?.id ?? null,
      });
    }),

  installOnModel: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        modelId: z.number().int().positive(),
        appBlockId: z.string().min(1).max(64),
        slotId: KNOWN_SLOT_IDS,
        settings: settingsSchema.optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertCanManageBlocks(ctx, input.modelId);
      // PAGE-ONLY LAUNCH GATE: installOnModel only ever targets a MODEL slot
      // (KNOWN_SLOT_IDS is the 3 model slots; the page slot never flows here),
      // so every model-slot install is a non-launch slot. Reject it for the
      // public (non-mod) audience; moderators are grandfathered so the live
      // mod-only generate-from-model install path is untouched. `isLaunchSlot`
      // is the single source of truth (not a hardcoded check on the slot id).
      assertLaunchSlotForCaller(ctx, input.slotId);
      return BlockRegistry.installOnModel({
        ...input,
        installedByUserId: ctx.user!.id,
      });
    }),

  updateSettings: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        blockInstanceId: z.string().min(1).max(64),
        settings: settingsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const modelId = await resolveModelIdFromBlockInstance(input.blockInstanceId);
      await assertCanManageBlocks(ctx, modelId);
      // B3: forward modelId so the write pins on (blockInstanceId, modelId).
      await BlockRegistry.updateSettings({ ...input, modelId });
      return { ok: true };
    }),

  /**
   * Publisher opt-out path. `enabled=false` keeps the install row in place
   * so the NOT EXISTS subquery in listForModel suppresses platform defaults
   * for the same app_block_id. See plan §4 invariant.
   */
  toggleEnabled: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        blockInstanceId: z.string().min(1).max(64),
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Post kill_per_model_installs: the per-model-pinned shape lives on
      // block_user_subscriptions (block_instance_id is UNIQUE there for
      // pinned rows).
      const sub = await dbWrite.blockUserSubscription.findUnique({
        where: { blockInstanceId: input.blockInstanceId },
        select: { appBlockId: true, slotId: true, targetModelIds: true },
      });
      if (!sub) throw throwNotFoundError('Block install not found');
      const modelId = sub.targetModelIds?.[0];
      if (!modelId || !sub.slotId) throw throwNotFoundError('Block install not found');
      await assertCanManageBlocks(ctx, modelId);
      await BlockRegistry.toggleEnabled({
        modelId,
        appBlockId: sub.appBlockId,
        slotId: sub.slotId,
        enabled: input.enabled,
      });
      return { ok: true };
    }),

  /**
   * Removes the install row entirely. Different from toggleEnabled(false):
   * uninstall re-enables platform defaults for this (model, slot) pair;
   * toggleEnabled(false) keeps the opt-out row in place.
   */
  // GA-relax (gotcha #66): own-data management action. moderator→protected +
  // flag below; ownership is still enforced by assertCanManageBlocks (the
  // caller must be the model owner or a mod), so a non-mod can only uninstall
  // a block from a model they own.
  uninstallFromModel: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(z.object({ blockInstanceId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const sub = await dbWrite.blockUserSubscription.findUnique({
        where: { blockInstanceId: input.blockInstanceId },
        select: { appBlockId: true, slotId: true, targetModelIds: true },
      });
      if (!sub) throw throwNotFoundError('Block install not found');
      const modelId = sub.targetModelIds?.[0];
      if (!modelId || !sub.slotId) throw throwNotFoundError('Block install not found');
      await assertCanManageBlocks(ctx, modelId);
      await BlockRegistry.uninstallFromModel({
        modelId,
        appBlockId: sub.appBlockId,
        slotId: sub.slotId,
      });
      return { ok: true };
    }),

  /**
   * NOTE: the W1 publish-request bundle upload (`submitVersion`) lives at the
   * dedicated route `POST /api/blocks/submit-version`, NOT here. The bundle is
   * a base64 ZIP (~67 MiB encoded) that exceeds the shared tRPC body limit;
   * keeping it off tRPC lets `/api/trpc/[trpc]` stay at 17 MiB instead of
   * lifting the cap for every tRPC call app-wide. That route uses ModEndpoint
   * (same moderator + appBlocks-flag gate) and the same `submitVersion` service.
   */

  /**
   * Developer-facing: withdraw your own pending publish request.
   * Idempotent. Allows resubmitting against the same slug without
   * accumulating dead pending rows.
   */
  withdrawPublishRequest: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(withdrawRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const { withdrawRequest } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      try {
        await withdrawRequest({
          publishRequestId: input.publishRequestId,
          userId: ctx.user.id,
        });
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: (err as Error).message,
        });
      }
      return { ok: true };
    }),

  /**
   * Pre-flight check for /apps/submit: does the current user already have
   * a pending publish request for this slug? Returns the id + version +
   * submittedAt so the form can show a "withdraw and resubmit" affordance
   * instead of letting the user hit the same-slug error on submit.
   * Scoped to the caller's own rows by design.
   */
  getMyPendingForSlug: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(getMyPendingForSlugSchema)
    .query(async ({ ctx, input }) => {
      const { getMyPendingForSlug } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      if (!ctx.user) return { pending: null };
      const pending = await getMyPendingForSlug({
        slug: input.slug,
        userId: ctx.user.id,
      });
      return { pending };
    }),

  /**
   * Mod queue: paginated list of publish requests waiting for review,
   * oldest first. Powers /apps/review.
   */
  listPendingRequests: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(listPendingRequestsSchema)
    .query(async ({ ctx, input }) => {
      const { listPendingRequests } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Mod review queue is restricted to civitai team');
      }
      return listPendingRequests({ limit: input.limit, cursor: input.cursor });
    }),

  /**
   * Mod history: paginated list of publish requests that were approved,
   * newest-first. Powers the Approved tab on /apps/review.
   */
  listApprovedRequests: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(listApprovedRequestsSchema)
    .query(async ({ ctx, input }) => {
      const { listApprovedRequests } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Mod review history is restricted to civitai team');
      }
      return listApprovedRequests({ limit: input.limit, cursor: input.cursor });
    }),

  /**
   * Mod history: paginated list of publish requests that were rejected,
   * newest-first. Powers the Rejected tab on /apps/review.
   */
  listRejectedRequests: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(listRejectedRequestsSchema)
    .query(async ({ ctx, input }) => {
      const { listRejectedRequests } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Mod review history is restricted to civitai team');
      }
      return listRejectedRequests({ limit: input.limit, cursor: input.cursor });
    }),

  /**
   * MOD-ONLY (F-E E5): derive the submitted bundle's screenshots for ONE publish
   * request so the reviewer can SEE the publisher-supplied images before
   * approving (publisher images = an abuse vector → must be reviewed with the
   * bundle). Returns base64 data URLs (the pending app has no public screenshot
   * URL yet — it isn't approved). Re-runs the SAME caps / magic-byte / name
   * validation as submit, so a malformed screenshot surfaces here too.
   *
   * `moderatorProcedure` + the `isModerator` belt + `enforceAppBlocksFlag`: a
   * non-mod / anon caller is denied before any bundle is read. No public path.
   */
  getPublishRequestScreenshots: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(getPublishRequestScreenshotsSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Mod review is restricted to civitai team');
      }
      const { getPublishRequestScreenshots } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      const items = await getPublishRequestScreenshots({
        publishRequestId: input.publishRequestId,
      });
      return { items };
    }),

  /**
   * Approve a pending publish request: pre-creates the OauthClient +
   * app_blocks row (first version), commits the bundle to Forgejo in a
   * single atomic commit, and lets the existing git-push webhook fire
   * the Tekton build chain.
   */
  approveRequest: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(approveRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const { approveRequest } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Approving publish requests is restricted to civitai team');
      }
      try {
        return await approveRequest({
          publishRequestId: input.publishRequestId,
          reviewerUserId: ctx.user.id,
          approvalNotes: input.approvalNotes,
        });
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: (err as Error).message,
        });
      }
    }),

  /**
   * One-shot W1 migration: backfill a publish_request row for an existing
   * live app whose first version predates this flow. Pulls the current
   * Forgejo state into a fresh ZIP, uploads to MinIO, inserts a
   * status='approved' row linked to the existing app_blocks entry.
   * Idempotent at the (slug, bundleSha256) level.
   */
  backfillPublishRequest: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(backfillPublishRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const { backfillPublishRequest } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Backfill is restricted to civitai team');
      }
      try {
        return await backfillPublishRequest({
          slug: input.slug,
          reviewerUserId: ctx.user.id,
          approvalNotes: input.approvalNotes,
        });
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: (err as Error).message,
        });
      }
    }),

  /**
   * Reject a pending publish request. Reason is required (≥10 chars) and
   * shown to the dev inline on /apps/my-submissions.
   */
  rejectRequest: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(rejectRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const { rejectRequest } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Rejecting publish requests is restricted to civitai team');
      }
      try {
        await rejectRequest({
          publishRequestId: input.publishRequestId,
          reviewerUserId: ctx.user.id,
          rejectionReason: input.rejectionReason,
        });
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: (err as Error).message,
        });
      }
      return { ok: true };
    }),

  /**
   * Developer-facing list: every publish request submitted by the current
   * viewer, newest first. The /apps/my-submissions page renders this.
   * Returns the rejection reason inline so the dev sees mod feedback
   * without a second round-trip.
   */
  listMyPublishRequests: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .query(async ({ ctx }) => {
      if (!ctx.user) return [];
      const rows = await dbRead.appBlockPublishRequest.findMany({
        where: { submittedByUserId: ctx.user.id },
        orderBy: { submittedAt: 'desc' },
        take: 100,
        select: {
          id: true,
          appBlockId: true,
          slug: true,
          version: true,
          status: true,
          submittedAt: true,
          reviewedAt: true,
          rejectionReason: true,
          approvalNotes: true,
          // Phase 2 build/deploy lifecycle, surfaced on /apps/my-submissions.
          deployState: true,
          deployDetail: true,
          deployUpdatedAt: true,
          fileSummary: true,
          manifestDiffSummary: true,
          appBlock: {
            select: {
              id: true,
              _count: { select: { userSubscriptions: true } },
            },
          },
        },
      });
      // Flatten _count onto each row so the UI doesn't have to dig through
      // the relation. Pending-first-version + withdrawn-first-version rows
      // have no appBlock (FK is set on approve) — surface null so the UI
      // can render "—".
      //
      // Post kill_per_model_installs: model installs are subscription rows
      // with target_model_ids populated. Compute the pinned-install count
      // via a second targeted query rather than over-fetching subs.
      type RawRow = (typeof rows)[number];
      const appBlockIds = rows
        .map((r: RawRow) => r.appBlock?.id)
        .filter((id: string | undefined): id is string => !!id);
      const pinnedCounts = appBlockIds.length
        ? (
            (await dbRead.blockUserSubscription.groupBy({
              by: ['appBlockId'],
              where: {
                appBlockId: { in: appBlockIds },
                scope: 'publisher_all_my_models',
                slotId: { not: null },
              },
              _count: { _all: true },
            })) as unknown as Array<{ appBlockId: string; _count: { _all: number } }>
          ).reduce<Record<string, number>>((acc, row) => {
            acc[row.appBlockId] = row._count._all;
            return acc;
          }, {})
        : {};
      type RowWithCount = (typeof rows)[number];
      return rows.map((r: RowWithCount) => {
        const counts = r.appBlock?._count;
        const appBlockId = r.appBlock?.id;
        const { appBlock: _drop, ...rest } = r;
        // userSubscriptionCount keeps the historical meaning ("blanket +
        // pinned subscriptions for this app"); modelInstallCount is the
        // pinned-subscription subset, mirroring what the pre-migration
        // model_block_installs row count meant.
        const totalSubs = counts?.userSubscriptions ?? null;
        const pinnedCount = appBlockId ? pinnedCounts[appBlockId] ?? 0 : null;
        return {
          ...rest,
          modelInstallCount: pinnedCount,
          userSubscriptionCount: totalSubs,
        };
      });
    }),

  /**
   * W5 v0 — reflection surface for /apps/installed. One row per app the
   * current user has either installed on a model OR subscribed to. Counts
   * + scope intersections derived from existing tables (no grant schema
   * yet — that's W5 v1). See user-app-surface.service.ts for shape.
   */
  // GA-relax (gotcha #66, manage-page half): own-data reflection query scoped
  // to ctx.user.id. moderator→protected + the appBlocks flag below. The
  // /apps/installed page already gates per-user on features.appBlocks, so the
  // old moderator gate just broke this tab for non-mods on flag-public surfaces.
  listMyScopeGrants: protectedProcedure
    .use(enforceAppBlocksFlag)
    .query(async ({ ctx }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) return [];
      if (!ctx.user) return [];
      const { listMyScopeGrants } = await import(
        '~/server/services/blocks/user-app-surface.service'
      );
      return listMyScopeGrants(ctx.user.id);
    }),

  /**
   * W5 v0 — chronological feed of `block_buzz_attribution` rows where the
   * current user is the spender (NOT the app owner). Powers the activity
   * panel on /apps/installed so users can audit what apps have spent
   * Buzz on their behalf.
   *
   * Cursor pagination by id (createdAt desc, id desc tiebreak); cap 100
   * to keep the payload bounded.
   */
  // GA-relax (gotcha #66): own-data activity feed scoped to ctx.user.id below.
  listMyAppActivity: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(64).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return { items: [], nextCursor: null };
      }
      if (!ctx.user) return { items: [], nextCursor: null };
      const { listMyAppActivity } = await import(
        '~/server/services/blocks/user-app-surface.service'
      );
      return listMyAppActivity({
        userId: ctx.user.id,
        limit: input.limit,
        cursor: input.cursor,
      });
    }),

  /**
   * Set or clear the version pin on a single subscription. NULL version
   * reverts to "latest" (host loads the AppBlock's current manifest); a
   * semver string pins to that version's manifest from `app_block
   * _publish_requests`. Service validates ownership + version existence;
   * this proc is the thin tRPC wrapper.
   *
   * Identifying the target row by the subscription's `id` (not the
   * blockInstanceId) — blanket subscriptions don't have a blockInstance
   * Id, and the management UI on /apps/installed reads `id` off the
   * SubscriptionRecord directly.
   */
  // GA-relax (gotcha #66): own-data management action. moderator→protected +
  // flag below; the service throws 'not the subscription owner' when
  // sub.userId !== caller, so a non-mod can only pin a version on their own sub.
  setSubscriptionPinnedVersion: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        subscriptionId: z.string().min(1).max(64),
        version: z.string().min(1).max(64).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { setSubscriptionPinnedVersion } = await import(
        '~/server/services/blocks/user-app-surface.service'
      );
      return setSubscriptionPinnedVersion({
        userId: ctx.user!.id,
        subscriptionId: input.subscriptionId,
        version: input.version,
      });
    }),

  /**
   * A6 — re-consent. The host surfaces `needs_consent` (from the block-token
   * response) with the scopes the app's approved manifest declares but the user
   * hasn't granted; on user accept, this records the grant so the next minted
   * token carries those scopes.
   *
   * The granted set is intersected server-side with the app's CURRENT approved
   * manifest∩approvedScopes — the client can only consent to scopes the app
   * actually declares + the mod approved (a malicious host can't grant itself
   * scopes the manifest never asked for). Additive: prior grants persist.
   */
  // Un-gated from moderatorProcedure → protectedProcedure (authenticated, not
  // moderator) + the appBlocks feature-flag check below. Consent is the
  // VIEWER's OWN action, so a logged-in non-mod viewer must be able to grant the
  // scopes their block needs (e.g. ai:write:budgeted) once the flag is public —
  // the old moderator gate meant a non-mod could never consent, so the block
  // could never spend their buzz. The grant stays bounded to the app's approved
  // manifest ∩ approvedScopes ceiling below, and writes only the caller's own
  // grant row.
  grantScopes: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        appBlockId: z.string().min(1).max(64),
        scopes: z.array(z.string().min(1).max(64)).min(1).max(32),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.features.appBlocks) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'App Blocks is not available to this account',
        });
      }
      const block = await dbRead.appBlock.findUnique({
        where: { id: input.appBlockId },
        select: { status: true, manifest: true, approvedScopes: true, version: true },
      });
      if (!block) throw throwNotFoundError('App block not found');
      if (block.status !== 'approved') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'App block is not approved' });
      }
      // Ceiling = manifest.scopes ∩ approvedScopes. The user may only consent
      // to scopes inside that ceiling; anything else is dropped.
      const manifestScopes = Array.isArray((block.manifest as { scopes?: unknown }).scopes)
        ? ((block.manifest as { scopes: unknown[] }).scopes.filter(
            (s): s is string => typeof s === 'string'
          ))
        : [];
      const approved = new Set(block.approvedScopes ?? []);
      const ceiling = new Set(manifestScopes.filter((s) => approved.has(s)));
      const toGrant = input.scopes.filter((s) => ceiling.has(s));
      if (toGrant.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'none of the requested scopes are within the app’s approved manifest',
        });
      }
      const { recordScopeGrant } = await import('~/server/services/blocks/scope-grant.service');
      await recordScopeGrant({
        userId: ctx.user!.id,
        appBlockId: input.appBlockId,
        version: block.version ?? '',
        scopes: toGrant,
      });
      return { ok: true, granted: toGrant };
    }),

  /**
   * W5 v0.5 — cursor-paginated feed of `block_scope_invocations` rows
   * scoped to the current viewer. Optional `appBlockId` filter for a
   * "show me what just this app did" drill-down. Cursor is the BigSerial
   * row id as a string (JSON can't carry int64 losslessly).
   */
  // GA-relax (gotcha #66): own-data scope-invocation feed scoped to ctx.user.id.
  listMyScopeInvocations: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        limit: z.number().int().min(1).max(100).optional(),
        cursor: z.string().max(64).optional(),
        appBlockId: z.string().min(1).max(64).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return { items: [], nextCursor: null };
      }
      if (!ctx.user) return { items: [], nextCursor: null };
      const { listMyScopeInvocations } = await import(
        '~/server/services/blocks/user-app-surface.service'
      );
      return listMyScopeInvocations({
        userId: ctx.user.id,
        limit: input.limit,
        cursor: input.cursor,
        appBlockId: input.appBlockId,
      });
    }),

  /**
   * Lists every user-subscription row (both scopes) for the current viewer.
   * Used by the management UI at /apps/installed. The app_block row is
   * denormalised onto each subscription so the UI can render block name,
   * icon, and target slot without a second round-trip.
   */
  // GA-relax (gotcha #66): returns only the caller's own subscriptions
  // (listUserSubscriptions(ctx.user.id)). moderator→protected + flag below.
  listMySubscriptions: protectedProcedure
    .use(enforceAppBlocksFlag)
    .query(async ({ ctx }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) return [];
      return BlockRegistry.listUserSubscriptions(ctx.user!.id);
    }),

  /**
   * Marketplace listing — approved app blocks, optionally filtered by slot
   * and/or a free-text query. Cursor-paginated. Public, ANON-CAPABLE (F-E E1):
   * any viewer the appBlocks flag grants can browse the marketplace without a
   * session; install requires auth (the Install CTA opens LoginModal for anon).
   *
   * GATING INVARIANT (E1) — this is anon-capable but stays DARK until launch:
   *   - `enforceAppBlocksFlag` runs FIRST and evaluates `isAppBlocksEnabled`
   *     with `ctx.user`. For a real anon / non-mod viewer the flag is the live
   *     mod-segmented `app-blocks-enabled`, which can never match without a
   *     moderator context → the middleware sets `_appBlocksDisabled` → we
   *     return empty below. So removing the prior hardcoded `isModerator` gate
   *     does NOT widen access today: the flag gate keeps it dark. The procedure
   *     only starts serving real anon callers once the SEGMENT is widened at
   *     launch (a deliberate, separate Flipt change). The earlier
   *     `if (!ctx.user?.isModerator) return []` was a redundant Phase-2 belt on
   *     top of the flag gate; it has to go for the segment-widen to actually
   *     expose this to anon, but the flag gate is the real control.
   *
   * EXPOSURE / SECURITY (what an anon caller can fetch once the segment widens):
   *   - ONLY `status='approved'` rows (the service WHERE-clause filters
   *     pending/rejected/withdrawn apps out — never returned).
   *   - ONLY an explicit PUBLIC-FIELD ALLOWLIST projection of each row
   *     (id, blockId, appId, appName, installCount + a vetted manifest subset:
   *     name/description/targets[].slotId). The full publisher-supplied
   *     `manifest` jsonb is NOT returned — it can carry arbitrary publisher
   *     fields plus server-set internal fields (e.g. `trustTier`, the internal
   *     `iframe.src` host) that must not leak to anon. See
   *     `BlockRegistry.listAvailable` for the allowlist.
   *   - No per-user data (subscriptions / earnings / grants stay on their own
   *     session-gated procedures).
   *
   * Anon rate-limiting: keyed on IP for anon (ctx.user?.id ?? ctx.ip in the
   * rateLimit middleware), consistent with other public procedures. Mods/dev/
   * test are exempt by the middleware itself.
   */
  listAvailable: publicProcedure
    .use(enforceAppBlocksFlag)
    .use(
      rateLimit({
        limit: 60,
        period: 60,
        errorMessage: 'Too many marketplace requests — slow down.',
      })
    )
    .input(listAvailableSchema)
    .query(async ({ ctx, input }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return { items: [], nextCursor: undefined };
      }
      // PAGE-ONLY LAUNCH GATE: the public (non-mod) audience sees launch (page)
      // apps only; moderators are grandfathered (see everything, incl. the
      // mod-only model-slot apps like generate-from-model). Mod status comes
      // from the server-stamped session `ctx.user?.isModerator` (cannot be
      // spoofed client-side — same source as every other belt in this router).
      return BlockRegistry.listAvailable(input, !ctx.user?.isModerator);
    }),

  /**
   * Per-app marketplace DETAIL — one approved app block, keyed on appBlockId.
   * Public, ANON-CAPABLE (F-E E2): backs the `/apps/<appBlockId>` detail page so
   * a viewer can evaluate an app (description, requested scopes, slots, content
   * rating, install count, version, live preview) before installing.
   *
   * GATING INVARIANT (E2) — anon-capable but DARK until launch (same as E1):
   *   - `enforceAppBlocksFlag` runs FIRST. For a real anon / non-mod viewer the
   *     mod-segmented `app-blocks-enabled` flag never matches → the middleware
   *     marks `_appBlocksDisabled` → this query returns NOT_FOUND (so a dark
   *     viewer sees the same 404 the page's SSR gate produces; no detail leaks).
   *     The procedure only serves real anon callers once the SEGMENT is widened
   *     at launch (a deliberate, separate Flipt change). There is intentionally
   *     NO hardcoded isModerator belt — the flag is the gate by design, so the
   *     eventual public launch is a pure segment-widen.
   *
   * EXPOSURE / SECURITY (what an anon caller can fetch once the segment widens):
   *   - ONLY a `status='approved'` app — a missing OR non-approved (pending/
   *     rejected/withdrawn) id returns NOT_FOUND, never its data. This blocks
   *     id-enumeration of unapproved apps.
   *   - ONLY the PublicAppDetail allowlist (see the type): the manifest is the
   *     same `toPublicBlockManifest` subset as the listing (name/description/
   *     targets[].slotId) — the raw manifest's internal fields (trustTier,
   *     internal iframe.src, renderMode, settings internals, raw scopes) are
   *     NEVER shipped. `scopes` are the approved scope ids (the permission
   *     disclosure); `liveUrl` is the already-public standalone block origin
   *     (no token / scope attached).
   *   - No per-user data.
   *
   * Anon rate-limiting: same posture as `listAvailable` (keyed on IP for anon;
   * mods/dev/test exempt by the middleware).
   */
  getAppDetail: publicProcedure
    .use(enforceAppBlocksFlag)
    .use(
      rateLimit({
        limit: 60,
        period: 60,
        errorMessage: 'Too many marketplace requests — slow down.',
      })
    )
    .input(getAppDetailSchema)
    .query(async ({ ctx, input }) => {
      // Dark-flag fail-closed: while the appBlocks flag is off the middleware
      // marks the ctx and we surface NOT_FOUND (matching the page SSR gate),
      // never the app's data.
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        throw throwNotFoundError('App block not found');
      }
      // PAGE-ONLY LAUNCH GATE: a non-mod hitting a non-launch (model-slot) app
      // gets the SAME NOT_FOUND posture as a missing/unapproved app — the
      // service returns null for it under launchOnly, so no model-app detail
      // leaks to the public. Mods (grandfathered) see every app. Mod status is
      // the server-stamped session flag.
      const detail = await BlockRegistry.getAppDetail(
        input.appBlockId,
        !ctx.user?.isModerator
      );
      if (!detail) throw throwNotFoundError('App block not found');
      return detail;
    }),

  /**
   * Featured rail — the curated, approved staff-picks (F-E E4). Public,
   * ANON-CAPABLE; backs the "Featured" rail above the marketplace grid.
   *
   * GATING INVARIANT (E4) — anon-capable but DARK until launch (same as E1/E2):
   *   - `enforceAppBlocksFlag` runs FIRST. For a real anon / non-mod viewer the
   *     mod-segmented `app-blocks-enabled` flag never matches → the middleware
   *     marks `_appBlocksDisabled` → this query returns an EMPTY rail (the same
   *     posture as `listAvailable` for a disabled flag; no data leaks). The rail
   *     only serves real anon callers once the SEGMENT is widened at launch.
   *
   * EXPOSURE / SECURITY — returns the SAME public `AvailableBlock` allowlist the
   * marketplace LISTING uses (no widening): the service hard-filters
   * `status='approved' AND featured=true`, so ONLY curated approved apps reach
   * the caller, and each row is the `toPublicBlockManifest` subset +
   * installCount + category + scopesSummary. No private/internal fields, no
   * per-user data.
   *
   * Anon rate-limiting: same posture as `listAvailable`.
   */
  getFeaturedBlocks: publicProcedure
    .use(enforceAppBlocksFlag)
    .use(
      rateLimit({
        limit: 60,
        period: 60,
        errorMessage: 'Too many marketplace requests — slow down.',
      })
    )
    .input(getFeaturedBlocksSchema)
    .query(async ({ ctx, input }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return { items: [] };
      }
      // PAGE-ONLY LAUNCH GATE: same public-vs-mod split as listAvailable — the
      // non-mod featured rail carries launch (page) apps only; mods see all.
      const items = await BlockRegistry.getFeaturedBlocks(
        input.limit,
        !ctx.user?.isModerator
      );
      return { items };
    }),

  // -------------------------------------------------------------------------
  // F-E marketplace REVIEWS (5-star) — all DARK behind enforceAppBlocksFlag.
  // -------------------------------------------------------------------------

  /**
   * Create-or-update the viewer's review for an app block (5-star).
   *
   * GATING / ANTI-ABUSE (all enforced, see appBlockReview.service):
   *   - enforceAppBlocksFlag (dark today: mutation throws UNAUTHORIZED when off).
   *   - guardedProcedure: authenticated, email-verified, NOT muted.
   *   - rating ∈ [1,5]; NO self-review (owner rejected); MUST have an enabled
   *     install; ONE per (user, app) via the DB unique (upsert, not a 2nd row).
   *
   * REWARD (money-touching): a blue-buzz reward fires ONCE per (user, app), only
   * on the CREATE branch (isFirstReview), AFTER the insert succeeds. It is
   * FAIL-SOFT — a reward/ClickHouse outage must never 500 the review. We wrap
   * it in try/catch as defense-in-depth on top of createBuzzEvent's own
   * fail-soft inline path.
   */
  upsertReview: guardedProcedure
    .use(enforceAppBlocksFlag)
    .use(
      rateLimit({
        limit: 30,
        period: 60,
        errorMessage: 'Too many review submissions — slow down.',
      })
    )
    .input(upsertAppBlockReviewSchema)
    .mutation(async ({ ctx, input }) => {
      const { review, isFirstReview } = await upsertAppBlockReview({
        userId: ctx.user.id,
        appBlockId: input.appBlockId,
        rating: input.rating,
        recommended: input.recommended,
        details: input.details ?? null,
      });

      // Blue-buzz reward — first review only, fail-soft. The reward must never
      // fail the review write (it's an audit/analytics + non-cashable grant).
      if (isFirstReview) {
        try {
          await appBlockReviewReward.apply(
            { appBlockId: input.appBlockId, userId: ctx.user.id, isFirstReview: true },
            { ip: ctx.ip }
          );
        } catch (error) {
          logToAxiom(
            {
              name: 'app-block-review-reward',
              type: 'error',
              message: 'Failed to apply appBlockReview reward (non-fatal)',
              appBlockId: input.appBlockId,
              userId: ctx.user.id,
              error: (error as Error)?.message,
            },
            'app-blocks'
          ).catch(() => undefined);
        }
      }

      return { review, isFirstReview };
    }),

  /**
   * Keyset-paginated list of an app's reviews (newest first), excluding
   * mod-excluded rows. Public/anon-CAPABLE but DARK behind the flag (returns an
   * empty page when the flag is off, same posture as listAvailable).
   */
  listReviews: publicProcedure
    .use(enforceAppBlocksFlag)
    .use(
      rateLimit({
        limit: 60,
        period: 60,
        errorMessage: 'Too many review requests — slow down.',
      })
    )
    .input(listAppBlockReviewsSchema)
    .query(async ({ ctx, input }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return { items: [], nextCursor: undefined };
      }
      return listAppBlockReviews(input);
    }),

  /**
   * The viewer's own review for an app block (or null) — backs the
   * "you rated this N★" state on the detail page. protectedProcedure (per-user
   * data), DARK behind the flag.
   */
  getMyReview: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(getAppDetailSchema)
    .query(async ({ ctx, input }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) return null;
      return getMyAppBlockReview(input.appBlockId, ctx.user.id);
    }),

  /**
   * MOD-ONLY: flip `exclude` on a review so it drops out of the rating aggregate
   * + the Bayesian sort. moderatorProcedure + the flag gate. Mirrors
   * toggleExcludeResourceReview.
   */
  setReviewExcluded: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(setAppReviewExcludedSchema)
    .mutation(async ({ input }) => {
      return setAppReviewExcluded(input);
    }),

  /**
   * MOD-ONLY: read the current marketplace metadata (category/featured/order)
   * for one app_block — seeds the review-page curation form (F-E E4).
   *
   * `moderatorProcedure` + the `isModerator` belt: a non-mod / anon caller is
   * rejected before any data is read. This is a moderator surface (carries the
   * internal `status`), NOT the anon `getAppDetail` allowlist.
   */
  getMarketplaceMeta: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(getMarketplaceMetaSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('App Blocks curation is restricted to civitai team');
      }
      const meta = await BlockRegistry.getMarketplaceMeta(input.appBlockId);
      if (!meta) throw throwNotFoundError('App block not found');
      return meta;
    }),

  /**
   * MOD-ONLY curation write — set category / featured / featured_order on one
   * app_block (F-E E4). This is the curation surface backing /apps/review.
   *
   * GATING / SECURITY:
   *   - `moderatorProcedure` checks the tRPC session user is a moderator, AND we
   *     re-assert `ctx.user?.isModerator` (defense-in-depth, mirroring the other
   *     mod mutations) — a non-mod / anon caller is DENIED (UNAUTHORIZED /
   *     FORBIDDEN) before any write. There is intentionally NO public path here.
   *   - `enforceAppBlocksFlag` keeps it behind the dark mod segment.
   *   - Validation lives in the service (`setMarketplaceMeta`): the category must
   *     be in the taxonomy const, and featuring is refused for a non-approved
   *     app — so an unapproved app can never be surfaced in the anon featured
   *     rail via this write.
   */
  setMarketplaceMeta: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(setMarketplaceMetaSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('App Blocks curation is restricted to civitai team');
      }
      return BlockRegistry.setMarketplaceMeta(input);
    }),

  /**
   * Install-time config for ONE approved app block, keyed on appBlockId.
   *
   * Why this exists (F-E E1 regression fix): the marketplace listing
   * (`listAvailable`) is anon-capable and so projects each manifest down to a
   * PUBLIC allowlist (name/description/targets only) via `toPublicBlockManifest`
   * — it deliberately drops `settings` and `scopes`. But the install modal
   * (`AppSettingsModal`) builds its publisher-settings form from
   * `manifest.settings` and reads `manifest.scopes`. Sourcing those from the
   * stripped public listing meant the settings form silently vanished when a
   * user installed a settings-declaring app FROM A MARKETPLACE CARD. This proc
   * is the AUTHENTICATED source for ONLY those two install-needed bits, so the
   * public listing can stay narrow (no widening of the anon-exposure allowlist).
   *
   * Gate: `moderatorProcedure` + appBlocks flag — the SAME audience that can
   * actually install (`installOnModel` / `upsertSubscription` are both
   * `moderatorProcedure`). A non-mod / anon caller is denied, so this can't be
   * used to enumerate manifest internals ahead of the public launch. It returns
   * ONLY for `status='approved'` apps (404 otherwise), matching the install
   * mutations' own approved gate.
   *
   * This is a DISPLAY fix only: `upsertSubscription` / `installOnModel` still
   * re-resolve settings + scopes server-side from the stored manifest by id and
   * validate them (see upsertSubscription's `dbRead.appBlock.findUnique` +
   * `validateBlockSettings`). The client never becomes the source of truth for
   * what gets persisted.
   */
  getInstallConfig: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(z.object({ appBlockId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      // Dark-flag fail-soft, consistent with the other query procs: when the
      // appBlocks flag is off the middleware marks the ctx and we surface no
      // manifest data (the modal renders no settings form rather than erroring).
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return { settings: {}, scopes: [] as string[] };
      }
      const block = await dbRead.appBlock.findUnique({
        where: { id: input.appBlockId },
        select: { status: true, manifest: true, approvedScopes: true },
      });
      if (!block || block.status !== 'approved') {
        throw throwNotFoundError('App block not found');
      }
      const manifest = (block.manifest ?? {}) as Record<string, unknown>;
      // Project ONLY the install-form inputs. `settings` is validated against
      // manifestSettingsSchema so a malformed/absent declaration yields {} (the
      // form renders no fields rather than throwing).
      const parsedSettings = manifestSettingsSchema.safeParse(manifest.settings ?? {});
      // `scopes` = manifest.scopes ∩ approvedScopes — the SAME mod-narrowed
      // ceiling grantScopes (above) enforces at mint and getAppDetail/
      // scopesSummary expose on the public surfaces. The disclosure must match
      // what the app can actually be granted: surfacing raw `manifest.scopes`
      // would over-state (list scopes the mod did NOT approve, so the app will
      // never be minted them) and could leak an unapproved/internal scope id
      // the manifest declares but approval dropped.
      const manifestScopes = Array.isArray(manifest.scopes)
        ? manifest.scopes.filter((s): s is string => typeof s === 'string')
        : [];
      const approved = new Set(block.approvedScopes ?? []);
      const scopes = manifestScopes.filter((s) => approved.has(s));
      return {
        settings: parsedSettings.success ? parsedSettings.data : {},
        scopes,
      };
    }),

  /**
   * Create or update the user's subscription for a (appBlockId, scope)
   * pair. Toggling a scope on writes a row; toggling off uses
   * deleteSubscription instead. Settings are validated against the app's
   * manifest-declared settings (W3 generic validator) so the subscription
   * row carries the same shape as a per-model install — and third-party
   * apps don't need civitai-side TypeScript to add new fields.
   *
   * Subscription scope drives which side of the publisher/viewer split the
   * settings write targets: `publisher_all_my_models` is a publisher write
   * (mirrors per-model install row shape); `viewer_personal` is a viewer
   * write (mirrors per-viewer override row shape).
   */
  upsertSubscription: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        appBlockId: z.string().min(1).max(64),
        scope: subscriptionScopeSchema,
        targetModelTypes: z.array(z.string().min(1).max(32)).max(16).nullable(),
        targetBaseModels: z.array(z.string().min(1).max(64)).max(32).nullable(),
        settings: settingsSchema.default({}),
        enabled: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Resolve the appBlock once for both status check and manifest-driven
      // settings validation. Need the manifest + approvedScopes here.
      const block = await dbRead.appBlock.findUnique({
        where: { id: input.appBlockId },
        select: { blockId: true, status: true, manifest: true, approvedScopes: true },
      });
      if (!block) throw throwNotFoundError('App block not found');
      if (block.status !== 'approved') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'App block is not approved' });
      }
      // PAGE-ONLY LAUNCH GATE: a subscription only ever attaches a MODEL-slot
      // app (page apps are stateless — Decision 2 — and never subscribed), so
      // for the public (non-mod) audience this is always a non-launch app and is
      // rejected. Moderators are grandfathered. Resolves launch-eligibility from
      // the app's manifest (declares a page) since the slot isn't an input here.
      assertLaunchAppForCaller(ctx, block.manifest);
      // Manifest-driven settings validation. The 4KB cap from the router-
      // level settingsSchema has already fired; this pass enforces the
      // per-field shape declared in the manifest. Manifests without a
      // settings declaration (or malformed ones — should have been caught
      // at submission time) forward the input through unchanged so that
      // a manifest schema drift doesn't break previously-accepted apps.
      const parsedManifestSettings = manifestSettingsSchema.safeParse(
        ((block.manifest ?? {}) as Record<string, unknown>).settings ?? {}
      );
      const forScope: 'publisher' | 'viewer' =
        input.scope === 'viewer_personal' ? 'viewer' : 'publisher';
      const validatedSettings = parsedManifestSettings.success
        ? validateBlockSettings({
            manifestSettings: parsedManifestSettings.data,
            inputSettings: input.settings,
            declaredScopes: block.approvedScopes ?? [],
            forScope,
          })
        : input.settings;
      return BlockRegistry.upsertSubscription({
        userId: ctx.user!.id,
        appBlockId: input.appBlockId,
        scope: input.scope,
        targetModelTypes: input.targetModelTypes,
        targetBaseModels: input.targetBaseModels,
        settings: validatedSettings,
        enabled: input.enabled,
      });
    }),

  /**
   * Idempotent + ownership-checking delete. Missing rows return ok:true
   * (already deleted is a success); rows owned by another user raise
   * authorization at the service layer.
   */
  deleteSubscription: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(z.object({ subscriptionId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      await BlockRegistry.deleteSubscription({
        subscriptionId: input.subscriptionId,
        userId: ctx.user!.id,
      });
      return { ok: true };
    }),

  /**
   * Read a workflow's current status. Returns a `BlockWorkflowSnapshot` —
   * a flattened, public-safe subset of the orchestrator's Workflow shape.
   *
   * Ownership: we fetch with the user's orchestrator token (`getOrchestratorToken`),
   * so the orchestrator returns 404/403 for workflows the user doesn't own.
   * That's the gate — we don't need a second client-side ownership check.
   */
  pollWorkflow: publicProcedure
    // No `enforceAppBlocksFlag` middleware here: block-token procs are
    // block-JWT-authed (no session for dev:live/localhost), so the flag must be
    // evaluated against the TOKEN subject — see assertAppBlocksEnabledForTokenUser.
    .input(
      z.object({
        blockToken: z.string().min(1),
        workflowId: z.string().min(1).max(64),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      if (!claims.scopes.includes('ai:write:budgeted')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
      }
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'workflow poll requires authenticated viewer',
        });
      }
      // App-Blocks flag gate, evaluated against the TOKEN subject (not ctx.user).
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsModerator(userId);
      const token = await getOrchestratorToken(userId, ctx);
      const workflow = await getWorkflow({ token, path: { workflowId: input.workflowId } });
      return { snapshot: snapshotFromWorkflow(workflow) };
    }),

  /**
   * Cancel a running workflow on the orchestrator (a real server-side stop).
   *
   * Mirrors pollWorkflow's auth + ownership model exactly: we cancel with the
   * viewer's orchestrator token (`getOrchestratorToken`), so the orchestrator
   * 403/404s for workflows the viewer doesn't own — that's the gate, no second
   * client-side ownership check needed. After the cancel PATCH lands we re-read
   * the workflow and return its (now-canceled) snapshot so the block can render
   * the terminal state. Best-effort from the block's side: a workflow that
   * already reached a terminal status may reject the cancel, which surfaces as
   * the mutation throwing — the host echoes a failure snapshot and the block
   * still clears its card.
   */
  cancelWorkflow: publicProcedure
    // Block-JWT-authed (no session for dev:live) — flag evaluated against the
    // TOKEN subject below, not the `enforceAppBlocksFlag` middleware's ctx.user.
    .input(
      z.object({
        blockToken: z.string().min(1),
        workflowId: z.string().min(1).max(64),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      if (!claims.scopes.includes('ai:write:budgeted')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
      }
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'workflow cancel requires authenticated viewer',
        });
      }
      // App-Blocks flag gate, evaluated against the TOKEN subject (not ctx.user).
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsModerator(userId);
      const token = await getOrchestratorToken(userId, ctx);
      await cancelWorkflow({ workflowId: input.workflowId, token });
      const workflow = await getWorkflow({ token, path: { workflowId: input.workflowId } });
      return { snapshot: snapshotFromWorkflow(workflow) };
    }),

  /**
   * Cost-only preview. Builds the same orchestrator step `submitWorkflow`
   * would, then calls submit with `whatif:true` so the orchestrator computes
   * cost without queueing the job. No budget gate — estimate is how the block
   * discovers whether budget is sufficient.
   */
  estimateWorkflow: publicProcedure
    // Block-JWT-authed (no session for dev:live) — flag evaluated against the
    // TOKEN subject below, not the `enforceAppBlocksFlag` middleware's ctx.user.
    .input(z.object({ blockToken: z.string().min(1), body: blockWorkflowBodySchema }))
    .mutation(async ({ ctx, input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      if (!claims.scopes.includes('ai:write:budgeted')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
      }
      // Context binding. A MODEL token pins `ctx.modelId`; the body must match
      // it. A PAGE token (ctx.entityType==='none') has NO model binding — it
      // lets the viewer pick a model, so the modelId match is SKIPPED and
      // replaced (below, after the version read) by the pre-spend availability
      // gate (assertViewerCanGeneratePageResources). That gate is a fail-fast UX
      // layer over the body version + LoRAs only — it does NOT cover the
      // resolved/billed checkpoint anchor; early-access + Private-subscription
      // entitlement (and the resolved anchor) are enforced by the orchestrator
      // resource belt over the full array. See isPageToken /
      // assertViewerCanGeneratePageResources.
      const isPage = isPageToken(claims);
      if (!isPage) {
        const ctxModelId = Number(
          (claims.ctx as { modelId?: unknown } | undefined)?.modelId ?? NaN
        );
        if (!Number.isInteger(ctxModelId) || ctxModelId !== input.body.modelId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'modelId mismatch with token' });
        }
        // Page-LoRA (Increment 1): additionalResources is a PAGE-ONLY feature.
        // A MODEL token's checkpoint comes from resolveBlockCheckpoint (install
        // rows), and the model branch never runs the per-resource entitlement
        // gate — so accepting additionalResources here would fan un-gated LoRAs
        // into the resources array. Reject them fail-closed on the model path.
        if (input.body.additionalResources?.length) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'additionalResources are not supported for model-bound blocks',
          });
        }
      }
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'estimate requires authenticated viewer',
        });
      }
      // App-Blocks flag gate, evaluated against the TOKEN subject (not ctx.user).
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsModerator(userId);
      const ctxSlotId = (claims.ctx as { slotId?: unknown } | undefined)?.slotId;
      if (typeof ctxSlotId !== 'string' || ctxSlotId.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'block token lacks slotId context' });
      }
      const resolved = await resolveBlockVersionContext(
        input.body.modelVersionId,
        input.body.modelId
      );
      const user = await getBlockSessionUser(userId);
      // Resolve the effective checkpoint BEFORE the page gate. This is the
      // ACTUAL anchor buildTextToImageInput puts at the head of the resources
      // array — for a non-Checkpoint page body it is NOT resolved.baseModel
      // (resolveBlockCheckpoint falls through to a viewer/publisher/popular
      // checkpoint that may belong to a different base-model family). The page
      // LoRA family-match must anchor on THIS checkpoint, not the body model.
      // resolveBlockCheckpoint is a pure read (install/override rows + a
      // fail-open cache populate) with no side effect that must follow the
      // gate, so it is safe to run before it.
      const checkpoint = await resolveBlockCheckpoint({
        blockInstanceId: claims.blockInstanceId,
        modelId: resolved.modelId,
        modelVersionId: resolved.modelVersionId,
        baseModel: resolved.baseModel,
        modelType: resolved.modelType,
        userId,
        slotId: ctxSlotId,
      });
      // PAGE branch: pre-spend availability gate over the resources THIS gate
      // can see — the viewer-picked BODY version (`resolved.gate`) AND each
      // additional LoRA — as a fail-fast UX layer in place of the skipped
      // model-binding check. NOTE it does NOT cover the resolved/billed
      // checkpoint ANCHOR: for a non-Checkpoint page body, resolveBlockCheckpoint
      // picks a DIFFERENT default checkpoint (validated there only for
      // Published + base-model family — not early-access/Private/availability).
      // That anchor's entitlement — and early-access + Private-sub entitlement
      // for the whole array — is enforced downstream by the orchestrator
      // resource belt over the FULL resources array; this gate is not the sole
      // boundary. Keep both belts.
      // Maturity clamp (authoritative). Derived ONCE from the token's
      // server-minted ceiling claim, NOT a client body field nor request-time
      // `ctx.domain`. Drives both the resource-selection gate (`sfwOnly`, so a
      // SFW-domain block can't even PICK a mature resource — defense in depth)
      // and the generation-output clamp (`allowMatureContent`). Green AND blue
      // → sfwOnly true; red → false. Mirrors submitWorkflow below.
      const { allowMatureContent } = resolveBlockMaturity(claims);
      if (isPage) {
        // Resolve + validate the LoRA stack first (LoRA-only + family-match)
        // so a bad resource fails BEFORE the entitlement gate / any cost.
        // Family-match anchors on the RESOLVED checkpoint's baseModel.
        const loraGates = await resolvePageLoraGates({
          additionalResources: input.body.additionalResources,
          checkpointBaseModel: checkpoint.baseModel,
        });
        await assertViewerCanGeneratePageResources({
          gates: [buildGateVersion(resolved.gate), ...loraGates],
          viewer: { id: userId, isModerator: !!user.isModerator },
          // SFW-only resource selection unifies with the output clamp: derive
          // from the authoritative token maturity (green/blue → true), not the
          // request domain. `allowMatureContent === false` ⇔ SFW ceiling.
          sfwOnly: allowMatureContent === false,
          wildcardsEnabled: !!ctx.features.wildcards,
        });
      }
      const token = await getOrchestratorToken(userId, ctx);
      const generateInput = buildTextToImageInput(input.body, {
        ...resolved,
        checkpointVersionId: checkpoint.versionId,
        checkpointBaseModel: checkpoint.baseModel,
      });
      const step = await createBlockTextToImageStep({ input: generateInput, user, whatIf: true });
      const workflow = await submitWorkflow({
        token,
        body: {
          steps: [step],
          tags: buildWorkflowTags(claims, resolved.baseModel),
          currencies: BLOCK_CURRENCIES,
          ...(allowMatureContent === false ? { allowMatureContent: false } : {}),
        },
        query: { whatif: true },
      });
      return { snapshot: snapshotFromWorkflow(workflow) };
    }),

  /**
   * Submit a workflow for actual execution. Enforces the buzz budget the
   * JWT carries (`claims.buzzBudget`) — over-budget submits return a
   * failed-shape snapshot instead of throwing, since the SDK treats throws
   * as block lifecycle errors but expects budget rejections as workflow
   * outcomes the block can recover from (e.g. by opening BuyBuzzModal).
   */
  submitWorkflow: publicProcedure
    // Block-JWT-authed (no session for dev:live) — flag evaluated against the
    // TOKEN subject below, not the `enforceAppBlocksFlag` middleware's ctx.user.
    .input(z.object({ blockToken: z.string().min(1), body: blockWorkflowBodySchema }))
    .mutation(async ({ ctx, input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      if (!claims.scopes.includes('ai:write:budgeted')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
      }
      if (typeof claims.buzzBudget !== 'number' || claims.buzzBudget <= 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block token missing budget' });
      }
      // Context binding. MODEL token → body.modelId must match ctx.modelId.
      // PAGE token (ctx.entityType==='none') → no model binding; skip the match
      // and enforce the pre-spend availability gate after the version read
      // instead (see estimateWorkflow for the same branch; that gate covers the
      // body version + LoRAs as fail-fast UX — the resolved checkpoint anchor
      // plus early-access + Private-sub entitlement are left to the orchestrator
      // resource belt over the full array). The buzzBudget claim + per-user
      // daily cap still bound spend identically for pages.
      const isPage = isPageToken(claims);
      if (!isPage) {
        const ctxModelId = Number(
          (claims.ctx as { modelId?: unknown } | undefined)?.modelId ?? NaN
        );
        if (!Number.isInteger(ctxModelId) || ctxModelId !== input.body.modelId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'modelId mismatch with token' });
        }
        // Page-LoRA (Increment 1): additionalResources is PAGE-ONLY. The model
        // branch never runs the per-resource entitlement gate, so reject the
        // field fail-closed rather than fan un-gated LoRAs into the resources
        // array. (See estimateWorkflow for the same guard.)
        if (input.body.additionalResources?.length) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'additionalResources are not supported for model-bound blocks',
          });
        }
      }
      const userId = parseSubjectUserId(claims.sub);
      // Anon submit is not just forbidden — there's no buzz account to charge.
      // Block tokens for anon viewers carry `sub: 'anon'`; the budget check
      // above doesn't catch this because the token issuer doesn't gate budget
      // on subject type. Belt-and-suspenders.
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'workflow submit requires authenticated viewer',
        });
      }
      // App-Blocks flag gate, evaluated against the TOKEN subject (not ctx.user).
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsModerator(userId);
      const ctxSlotId = (claims.ctx as { slotId?: unknown } | undefined)?.slotId;
      if (typeof ctxSlotId !== 'string' || ctxSlotId.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'block token lacks slotId context' });
      }
      const resolved = await resolveBlockVersionContext(
        input.body.modelVersionId,
        input.body.modelId
      );
      const user = await getBlockSessionUser(userId);
      // Resolve the effective checkpoint BEFORE the page gate so the page LoRA
      // family-match anchors on the ACTUAL checkpoint buildTextToImageInput
      // uses (see estimateWorkflow for the full rationale — for a
      // non-Checkpoint page body this differs from resolved.baseModel).
      // resolveBlockCheckpoint is a pure read with no gate-ordering side
      // effect, so resolving it ahead of the gate is safe.
      const checkpoint = await resolveBlockCheckpoint({
        blockInstanceId: claims.blockInstanceId,
        modelId: resolved.modelId,
        modelVersionId: resolved.modelVersionId,
        baseModel: resolved.baseModel,
        modelType: resolved.modelType,
        userId,
        slotId: ctxSlotId,
      });
      // PAGE branch: pre-spend availability gate over the resources THIS gate
      // can see — the viewer-picked BODY version (`resolved.gate`) AND each
      // additional LoRA — a fail-fast UX layer in place of the skipped
      // model-binding check. It does NOT cover the resolved/billed checkpoint
      // ANCHOR: a non-Checkpoint page body resolves a DIFFERENT default
      // checkpoint (validated there only for Published + base-model family).
      // That anchor's entitlement, plus early-access + Private-sub entitlement
      // for the whole array, is enforced downstream by the orchestrator
      // resource belt over the FULL array (whatIf + real) — this gate is not
      // the sole boundary. Keep both belts.
      // Maturity clamp (authoritative, GA gate). Derived ONCE from the token's
      // server-minted ceiling claim and applied to: (a) the resource-selection
      // gate (`sfwOnly`, defense in depth — a SFW block can't even PICK a
      // mature resource), (b) the prompt audit (`isGreen` → SFW prompt audit on
      // SFW domains), (c) the whatIf cost step, and (d) the real submit. NEVER
      // from a client body field nor request-time `ctx.domain`, so a SFW-domain
      // (green/blue) block cannot widen to mature output. Fail closed: a
      // legacy/absent claim resolves to the SFW ceiling.
      const { allowMatureContent, isGreen } = resolveBlockMaturity(claims);

      if (isPage) {
        const loraGates = await resolvePageLoraGates({
          additionalResources: input.body.additionalResources,
          checkpointBaseModel: checkpoint.baseModel,
        });
        await assertViewerCanGeneratePageResources({
          gates: [buildGateVersion(resolved.gate), ...loraGates],
          viewer: { id: userId, isModerator: !!user.isModerator },
          // Unify resource selection with the output clamp: SFW-only iff the
          // authoritative token maturity is SFW (green/blue), not the request
          // domain. `allowMatureContent === false` ⇔ SFW ceiling.
          sfwOnly: allowMatureContent === false,
          wildcardsEnabled: !!ctx.features.wildcards,
        });
      }
      const token = await getOrchestratorToken(userId, ctx);

      // Prompt audit before any orchestrator interaction (mirrors what
      // generateFromGraph does). A block can't bypass moderation by submitting
      // through this path. `isGreen` (SFW prompt audit) is domain/ceiling-
      // derived so a SFW-domain block's prompts get the stricter audit.
      await auditPromptServer({
        prompt: input.body.params.prompt,
        negativePrompt: input.body.params.negativePrompt,
        userId,
        isGreen,
        isModerator: !!user.isModerator,
      });

      const generateInput = buildTextToImageInput(input.body, {
        ...resolved,
        checkpointVersionId: checkpoint.versionId,
        checkpointBaseModel: checkpoint.baseModel,
      });

      // Cost preflight. Build a whatIf step for the cost estimate, then a
      // separate real step for submit below. Seed defaulting differs between the
      // two (the graph fills a random seed when none is supplied), but that
      // doesn't affect cost — the estimate is computed against the same
      // resources/params the real submit uses.
      const stepForCostCheck = await createBlockTextToImageStep({
        input: generateInput,
        user,
        whatIf: true,
      });
      const tags = buildWorkflowTags(claims, resolved.baseModel);
      const whatIfResult = await submitWorkflow({
        token,
        body: {
          steps: [stepForCostCheck],
          tags,
          currencies: BLOCK_CURRENCIES,
          ...(allowMatureContent === false ? { allowMatureContent: false } : {}),
        },
        query: { whatif: true },
      });
      const cost = whatIfResult.cost?.total ?? 0;
      if (cost > claims.buzzBudget) {
        return {
          snapshot: {
            // Non-empty sentinel: the block SDK validator drops empty-workflowId
            // snapshots, which would silently swallow this insufficient-budget
            // reply and hang submit to its 120s timeout instead of surfacing the
            // top-up CTA. (Same class as failureSnapshot in IframeHost.tsx.)
            workflowId: 'failed',
            status: 'failed' as const,
            cost: { total: cost },
            error: `insufficient buzz budget: estimate ${cost} exceeds budget ${claims.buzzBudget}`,
          },
        };
      }

      // CUMULATIVE Buzz-spend cap (audit A7 / design-gaps H1). The per-call
      // check above only bounds THIS submit; reserve `cost` against the running
      // per-(USER, UTC-day) total so a block can't drain the balance via many
      // sequential ≤budget submits, and so multiple installed blocks can't
      // multiply the ceiling (the key is per-user, see buzzCapRedisKey).
      //
      // RESERVE FIRST (atomic INCRBY): this closes the read→check→record
      // TOCTOU — two concurrent submits can't both read a stale total and both
      // pass. If the reservation pushes the total over the cap, REFUND it and
      // reject without submitting; otherwise the reservation IS the spend
      // record (no separate fire-and-forget incr that could silently drop and
      // under-count). A Redis error on the reserve throws → fails CLOSED,
      // matching the old read path.
      const { total, key: buzzCapKey } = await reserveBlockBuzzSpend(userId, cost);
      if (total > BLOCK_BUZZ_CAP_PER_DAY) {
        await refundBlockBuzzSpend(buzzCapKey, cost);
        return {
          snapshot: {
            workflowId: 'failed',
            status: 'failed' as const,
            cost: { total: cost },
            error:
              `daily Buzz cap reached: ${total - Math.ceil(cost)} already spent today ` +
              `across your installed apps, this generation costs ${cost}, ` +
              `daily cap is ${BLOCK_BUZZ_CAP_PER_DAY}`,
          },
        };
      }

      // From here the reservation is live. If ANYTHING throws before a resolved
      // submitWorkflow, refund the reservation and re-throw — this matches the
      // original semantics exactly (the old code recorded the spend only after
      // submitWorkflow RESOLVED, so a throw meant no record). A resolved submit
      // KEEPS the reservation regardless of snapshot status (the old code
      // recorded after submitWorkflow resolved, including a returned `failed`
      // snapshot) — so we do NOT refund on a non-throwing failed snapshot.
      let snapshot: ReturnType<typeof snapshotFromWorkflow>;
      let autoClaim: Awaited<ReturnType<typeof maybeAutoClaimDailyBoost>>;
      try {
        // Daily-boost autoclaim. Cost cleared the install's budget cap; check
        // whether the user's actual spendable Buzz can pay for it. If they're
        // short AND the 25-blue daily boost would close the gap, fire the
        // reward apply() before submitting — it's idempotent (Redis Lua dedup
        // per UTC day) so re-entering this code path twice on the same UTC
        // day is a no-op.
        //
        // Conservative rule: only claim when (current + awardAmount) >= cost.
        // Burning a one-per-day boost on a still-hopeless submit would be
        // worse UX than the existing "insufficient buzz" Top-Up CTA the
        // block already renders.
        autoClaim = await maybeAutoClaimDailyBoost({
          userId,
          cost,
          ip: ctx.ip,
        });

        const step = await createBlockTextToImageStep({ input: generateInput, user, isGreen });
        const submitted = await submitWorkflow({
          token,
          body: {
            steps: [step],
            tags,
            currencies: BLOCK_CURRENCIES,
            // Authoritative maturity clamp on the REAL submit — the orchestrator
            // rejects mature output when this is false. Token-claim derived.
            ...(allowMatureContent === false ? { allowMatureContent: false } : {}),
          },
        });
        snapshot = snapshotFromWorkflow(submitted);
      } catch (e) {
        // No resolved submit → undo the reservation (net-equivalent to the old
        // "only record after a resolved submit" behavior) and propagate. Refund
        // against the pinned key, not a re-derived one (midnight-UTC race).
        await refundBlockBuzzSpend(buzzCapKey, cost);
        throw e;
      }

      // Log the workflow submission to the per-user activity feed so
      // /apps/installed → Activity shows "this app ran a workflow on
      // your behalf at time T". Without this, generations that spend
      // existing balance (the common case) leave NO trace anywhere —
      // block_buzz_attribution only covers Buzz PURCHASES from inside
      // the block (publisher revenue share), not vanilla spends. Fire-
      // and-forget; recordScopeInvocation has internal try/catch so a
      // failed audit insert can't poison the user-facing response.
      //
      // workflow:submit is a synthetic endpoint string (this path is
      // tRPC, not REST) — the UI's Activity panel humanises it via the
      // 'ai:write:budgeted' scope to "Generated an image".
      void (async () => {
        const { recordScopeInvocation } = await import(
          '~/server/services/blocks/user-app-surface.service'
        );
        await recordScopeInvocation({
          userId,
          appBlockId: claims.appBlockId,
          blockInstanceId: claims.blockInstanceId,
          scope: 'ai:write:budgeted',
          endpoint: `workflow:submit:${snapshot.workflowId || 'pending'}`,
          // Snapshot status is 'pending' / 'failed' / etc — map to an HTTP-
          // ish code so the existing UI badge colors are coherent.
          statusCode: snapshot.status === 'failed' ? 500 : 200,
        });
      })().catch(() => {
        /* swallowed inside helper */
      });

      // W3 flow A — buzz SPEND attribution (author bounty). The block
      // burned the viewer's own Buzz on this generation; accrue the app
      // author's platform-funded bounty share. EVERYTHING is server-derived
      // from the VERIFIED token claims (appId/appBlockId/blockInstanceId
      // from the JWT, spender from `sub`, author looked up from the app's
      // OauthClient) — there is NO client-supplied attribution, so spend is
      // inherently forge-safe. Idempotent on (workflowId, appBlockId), so a
      // re-poll / retry can't double-attribute. Fire-and-forget with its
      // own try/catch (mirrors recordScopeInvocation): a failed attribution
      // write must NEVER break the generation — the Buzz was already spent
      // and the snapshot is already the user-facing source of truth.
      //
      // Only fire on a REAL workflow id. A returned 'failed' sentinel
      // snapshot (the over-budget / insufficient-budget path above returns
      // early before we get here, but the orchestrator can also resolve to
      // a 'failed' status without queueing) has no generation to attribute.
      const spendWorkflowId = snapshot.workflowId;
      if (spendWorkflowId && spendWorkflowId !== 'failed' && snapshot.status !== 'failed') {
        void (async () => {
          const { recordSpendAttribution } = await import(
            '~/server/services/blocks/buzz-attribution.service'
          );
          // Accrue the author bounty off the REALIZED debit, not the
          // whatif preflight ESTIMATE (`cost`). `snapshotFromWorkflow`
          // surfaces the REAL submit's `workflow.cost.total` onto
          // `snapshot.cost.total` (see workflow.service.ts:~49,61), read
          // from the SAME resolved `submitted` snapshot this handler
          // already holds (no re-fetch). The realized value is what the
          // platform actually took, so the bounty matches the spend
          // (the `share_le_gross` intent). This closes: (a) estimate >
          // realized over-accrual; (b) a cache-hit / 0-realized that
          // would otherwise still accrue off a non-zero estimate (author
          // paid for a gen that cost nothing); (c) queue/surge/tier drift
          // landing on platform bounty liability. Fall back to the
          // estimate ONLY when the realized value is absent on the
          // snapshot (e.g. a snapshot that carries no cost).
          //
          // SYBIL CAP NOTE (audit 🟡-2): there is NO per-APP aggregate
          // accrual cap here — only the per-(USER, UTC-day) Buzz SPEND
          // reservation above. A Sybil ring of many viewers could mint
          // unbounded platform-funded bounty toward ONE app. This is
          // accrual-only + mod-gated today, so it is not a merge blocker,
          // but a per-app earnings cap / velocity check is a HARD
          // prerequisite before the spend flow opens to non-mods (track
          // alongside the Slice-4 payout gate + the rate sign-off).
          await recordSpendAttribution({
            userId,
            buzzAmount: Math.ceil(snapshot.cost?.total ?? cost),
            workflowId: spendWorkflowId,
            appId: claims.appId,
            appBlockId: claims.appBlockId,
            blockInstanceId: claims.blockInstanceId,
            modelId: resolved.modelId,
          });
        })().catch(() => {
          /* best-effort: a failed attribution write never breaks submit */
        });
      }

      return { snapshot: autoClaim ? { ...snapshot, autoClaim } : snapshot };
    }),

  /**
   * Read up to N showcase images for a model version with their gen-meta
   * extracted. Used by the block UI to render a "click an image to copy
   * its params" carousel. Public — showcase images are already public on
   * the model page; this is the same data with a stable shape.
   */
  getShowcaseImages: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        modelVersionId: z.number().int().positive(),
        // Viewer's requested browsing-level flags (bitwise NsfwLevel), as the
        // model-page gallery sends them. Optional; the service forces anon
        // viewers to public (PG) and never trusts this to widen an anon view.
        // Logged-in viewers with no value fall back to SFW server-side.
        browsingLevel: z.number().int().min(0).optional(),
      })
    )
    .query(({ input, ctx }) => {
      // Gated by the `appBlocks` feature flag (availability ['mod'] in prod
      // today, 'public' once GA'd / on the anon-conversion preview), mirroring
      // listForModel + the block-token mint gate. A hardcoded moderator check
      // here blocked anon / non-mod viewers' blocks from loading showcase
      // images (FORBIDDEN) even when the flag was public, breaking the
      // anonymous-conversion flow. Return an empty showcase (the block renders
      // a "no preview images" state) when the flag is off, so a non-eligible
      // caller leaks nothing and the slot degrades gracefully.
      if (!ctx.features.appBlocks) return [];
      // Thread the viewer's browsing context so NSFW image URLs + their full
      // gen-meta (prompt/seed) aren't leaked into the third-party publisher
      // iframe for NSFW-opted-out or logged-out viewers. Anon (no ctx.user)
      // is forced to public (PG) inside the service.
      //
      // The color domain carries the maturity CEILING: on a SFW domain
      // (green/blue) the service clamps the effective browsing level to SFW so a
      // logged-in viewer can't request `browsingLevel: 31` and pull mature
      // thumbnails + meta into the iframe. This is the display-surface analogue
      // of the authoritative generation clamp. This is a public read with no
      // block-token claim handy, so the request-time domain is the authority.
      //
      // LOW-1 hardening: derive the maturity domain from the RAW
      // `getRequestDomainColor(req)` — which returns `undefined` for an
      // UNRESOLVED host — NOT from `ctx.domain`, which is `?? 'blue'`-defaulted
      // in createContext for the convenience of code that wants a concrete
      // color. Routing the showcase clamp through that default would make an
      // unresolved host fail-CLOSED today only because `domainBrowsingCeiling`
      // happens to map 'blue' → SFW; the moment the platform flips blue→mature
      // there, the `?? 'blue'` default would silently turn this fail-closed read
      // into a fail-OPEN one for unresolved hosts. Passing the raw `undefined`
      // through makes `domainBrowsingCeiling(undefined)` fail closed to SFW
      // independent of blue's mapping — matching how the authoritative
      // generation belt clamps off the raw color (never the 'blue' default).
      const rawDomain = getRequestDomainColor(ctx.req);
      return getModelShowcaseImages(input.modelVersionId, {
        userId: ctx.user?.id ?? null,
        browsingLevel: input.browsingLevel,
        domain: rawDomain,
      });
    }),

  /**
   * Compute the effective checkpoint for a (blockInstanceId, viewer) pair.
   * Called by the IframeHost before BLOCK_INIT so the iframe receives the
   * merged publisher-default ∪ viewer-override value via
   * `BLOCK_INIT.context.checkpoint`.
   *
   * Public procedure (no session required) so anon viewers can also see
   * the publisher default. Authenticated viewers additionally see their
   * override if set.
   */
  getEffectiveCheckpoint: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        blockInstanceId: z.string().min(1).max(64),
        // modelId + slotId are the resolver's auth pin for synthetic ids
        // (pdb_*, bus_*). Without them, those blockInstanceIds would 404
        // here even though they validly surface on the model page.
        modelId: z.number().int().positive(),
        slotId: KNOWN_SLOT_IDS,
      })
    )
    .query(async ({ ctx, input }) => {
      // Gated by the `appBlocks` feature flag (mirrors listForModel +
      // getShowcaseImages + the block-token mint), NOT a hardcoded moderator
      // check — otherwise anon / non-mod viewers' blocks FORBIDDEN on
      // checkpoint resolution even when the flag is public, breaking the
      // anonymous-conversion flow. Return a null checkpoint when the flag is
      // off (the block falls back to the platform per-ecosystem default).
      // getEffectiveCheckpoint already accepts userId: number | null, so anon
      // (no viewer override) resolves to the publisher/platform default.
      if (!ctx.features.appBlocks) return { checkpoint: null };
      const checkpoint = await BlockRegistry.getEffectiveCheckpoint({
        blockInstanceId: input.blockInstanceId,
        modelId: input.modelId,
        slotId: input.slotId,
        userId: ctx.user?.id ?? null,
      });
      return { checkpoint };
    }),

  /**
   * Persist a viewer's per-block-instance settings (currently just the
   * checkpoint override). Gated on the block JWT — anon viewers don't get
   * an override because there's no user row to key on. Setting
   * `checkpoint_version_id: null` clears the override and falls back to
   * the publisher default at next resolveBlockCheckpoint call.
   *
   * Re-validates the checkpoint at write-time (ecosystem match etc.) so
   * the persisted value is never something resolveBlockCheckpoint will
   * later reject — the client gets a structured error inline instead of
   * a "your saved override is invalid" failure at next generate.
   */
  updateUserSettings: publicProcedure
    // Block-JWT-authed (no session for dev:live) — flag evaluated against the
    // TOKEN subject below, not the `enforceAppBlocksFlag` middleware's ctx.user.
    .input(
      z.object({
        blockToken: z.string().min(1),
        // W3 v0 — accept any record; the manifest declaration is the
        // contract. Server-side validation is keyed on the appBlock's
        // manifest fetched below, not a per-block-id zod schema. Generic
        // settingsSchema enforces the 4KB / JSON-safety cap.
        settings: settingsSchema,
      })
    )
    .mutation(async ({ input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'anon viewers cannot persist block settings',
        });
      }
      // App-Blocks flag gate, evaluated against the TOKEN subject (not ctx.user).
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsModerator(userId);
      const ctxModelId = Number((claims.ctx as { modelId?: unknown } | undefined)?.modelId ?? NaN);
      if (!Number.isInteger(ctxModelId)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'block token lacks modelId context' });
      }
      const ctxSlotId = (claims.ctx as { slotId?: unknown } | undefined)?.slotId;
      if (typeof ctxSlotId !== 'string' || ctxSlotId.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'block token lacks slotId context' });
      }

      // Resolve the install (or synthetic source row) so we can pull the
      // app block's manifest + scopes for the validator. Re-validation of
      // the (modelId, slotId, viewer) tuple is handled inside
      // resolveBlockInstance — synthetic ids fail-closed without it.
      const resolved = await BlockRegistry.resolveBlockInstance({
        blockInstanceId: claims.blockInstanceId,
        modelId: ctxModelId,
        slotId: ctxSlotId,
        viewerUserId: userId,
        db: 'read',
      });
      if (!resolved) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Block install not found' });
      }

      // Manifest-driven shape validation. Wrong-scope fields are silently
      // skipped, so a viewer payload that accidentally includes publisher
      // keys just drops them rather than failing the whole call.
      const parsedManifestSettings = manifestSettingsSchema.safeParse(
        (resolved.appBlock.manifest as Record<string, unknown>).settings ?? {}
      );
      const validatedSettings = parsedManifestSettings.success
        ? validateBlockSettings({
            manifestSettings: parsedManifestSettings.data,
            inputSettings: input.settings,
            declaredScopes: resolved.appBlock.approvedScopes,
            forScope: 'viewer',
          })
        : input.settings;

      // Cross-row validation for the resource_picker → checkpoint case
      // (same known field name pattern as the publisher path in
      // block-registry.validateInstallSettings). Skip when explicitly
      // clearing (`null`) — that's just dropping the override.
      if (typeof validatedSettings.checkpoint_version_id === 'number') {
        const baseModel = await getRepresentativeBaseModel(ctxModelId);
        if (!baseModel) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'cannot determine base model for the bound install',
          });
        }
        await validateBlockCheckpoint({
          checkpointVersionId: validatedSettings.checkpoint_version_id,
          forBaseModel: baseModel,
          reason: 'viewer-override',
        });
      }

      await BlockRegistry.upsertUserSettings({
        blockInstanceId: claims.blockInstanceId,
        userId,
        settings: validatedSettings,
      });

      // Audit — log every viewer-settings write (including checkpoint pin
      // swaps via SET_CHECKPOINT) to the activity feed. Fire-and-forget.
      void (async () => {
        const { recordScopeInvocation } = await import(
          '~/server/services/blocks/user-app-surface.service'
        );
        await recordScopeInvocation({
          userId,
          appBlockId: claims.appBlockId,
          blockInstanceId: claims.blockInstanceId,
          scope: 'block:settings:write',
          endpoint: 'user-settings:write',
          statusCode: 200,
        });
      })().catch(() => {});

      return { ok: true };
    }),

  /**
   * Publisher revenue summary. Caller must be the app owner — the
   * service filters by `app_owner_user_id` so even if the request
   * carries a different appBlockId, the rows are scoped to the caller.
   * Auth check is enforced by moderatorProcedure; no need to also assert
   * ownership of the requested appBlockId (the join filter does it).
   */
  getMyRevenue: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        appBlockId: z.string().min(1).max(64).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Dark-flag fail-closed: while the appBlocks flag is off the middleware
      // marks the ctx → return the zeroed revenue shape WITHOUT running any
      // aggregate, so a flag-off moderator gets no live revenue data.
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return emptyRevenue();
      }
      const user = ctx.user as SessionUser;
      const { summary, topApps } = await getRevenueForOwner({
        ownerUserId: user.id,
        appBlockId: input.appBlockId,
        from: input.from ? new Date(input.from) : undefined,
        to: input.to ? new Date(input.to) : undefined,
      });
      const recentAttributions = await getRecentAttributionsForOwner({
        ownerUserId: user.id,
        appBlockId: input.appBlockId,
      });
      return { summary, topApps, recentAttributions };
    }),

  /**
   * Phase 0 author analytics — installs, runs+buzz spent, buzz purchased,
   * and engagement for the caller's OWN app(s), derived entirely from
   * existing App Blocks tables (no new instrumentation). Read-only.
   *
   * Same audience gate as getMyRevenue (moderatorProcedure +
   * enforceAppBlocksFlag — dark behind the appBlocks flag). Ownership is
   * enforced inside the service: it resolves the caller's owned app_block
   * ids via AppBlock.app.userId and returns zeroed/empty analytics for a
   * non-owned id, so an author can never read another author's metrics.
   */
  getMyAppAnalytics: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        appBlockId: z.string().min(1).max(64).optional(),
        from: z.string().datetime().optional(),
        to: z.string().datetime().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const from = input.from ? new Date(input.from) : undefined;
      const to = input.to ? new Date(input.to) : undefined;
      // Dark-flag fail-closed: while the appBlocks flag is off the middleware
      // marks the ctx → return the zeroed analytics shape (with the resolved
      // range, so the UI still has a window) WITHOUT running any aggregate.
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return emptyAnalytics(resolveRange({ from, to }), false);
      }
      const user = ctx.user as SessionUser;
      return getMyAppAnalytics({
        userId: user.id,
        appBlockId: input.appBlockId,
        from,
        to,
      });
    }),

  /**
   * The current user's owned apps + lifetime revenue per app. Drives
   * the per-app dropdown on /apps/revenue. OauthClient.userId is the
   * single source of truth for app ownership in v1.
   */
  getMyApps: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .query(async ({ ctx }) => {
      const user = ctx.user as SessionUser;
      const apps = await dbRead.appBlock.findMany({
        where: { app: { userId: user.id } },
        select: {
          id: true,
          blockId: true,
          appId: true,
          status: true,
          manifest: true,
          app: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      // One groupBy across all of the user's apps so the request
      // doesn't N+1 against the attribution table. Skip when there
      // are no apps — pointless query.
      const lifetimeByApp = apps.length
        ? await dbRead.blockBuzzAttribution.groupBy({
            by: ['appBlockId'],
            where: {
              appOwnerUserId: user.id,
              status: { in: ['confirmed', 'paid_out'] },
            },
            _sum: { appOwnerShareCents: true },
            _count: true,
          })
        : [];
      type LifetimeRow = {
        appBlockId: string;
        _sum: { appOwnerShareCents: number | null };
        _count: number;
      };
      const lifetimeMap = new Map<string, { shareCents: number; count: number }>(
        (lifetimeByApp as LifetimeRow[]).map((r) => [
          r.appBlockId,
          { shareCents: r._sum.appOwnerShareCents ?? 0, count: r._count },
        ])
      );

      type AppRow = {
        id: string;
        blockId: string;
        appId: string;
        status: string;
        manifest: unknown;
        app: { name: string } | null;
      };
      return (apps as AppRow[]).map((a) => ({
        id: a.id,
        blockId: a.blockId,
        appId: a.appId,
        status: a.status,
        appName: a.app?.name ?? null,
        manifest: a.manifest as Record<string, unknown>,
        lifetimeShareCents: lifetimeMap.get(a.id)?.shareCents ?? 0,
        lifetimeCount: lifetimeMap.get(a.id)?.count ?? 0,
      }));
    }),

  /**
   * Phase 3 (git-push self-service) — return the developer's clone URL +
   * push credential for one of THEIR apps.
   *
   * Owner-gated on OauthClient.userId (the same v1 source of truth as
   * getMyApps). Lazily provisions a scoped, restricted Forgejo identity for
   * the caller the first time they ask (ensureForgejoIdentity), then grants
   * that identity `write` on the app's own civitai-apps/<slug> repo
   * (addCollaborator). A push parks a pending review request and can NEVER
   * deploy without mod approval — the no-trust-on-push gate is unchanged.
   *
   * The repo only exists once the FIRST version has been ZIP-approved (approve
   * pre-creates civitai-apps/<slug>); until then there's nothing to push to, so
   * we return a `notYetAvailable` shape rather than provisioning a credential
   * the dev can't use.
   *
   * `protectedProcedure` (not moderator): an app owner authoring their own app
   * need not be a mod. Access is bounded by the app.userId owner check + the
   * appBlocks flag, and the credential is write-on-their-own-repo-only.
   */
  getMyAppRepo: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(z.object({ appBlockId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.features.appBlocks) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'App Blocks is not available to this account',
        });
      }
      const block = await dbRead.appBlock.findUnique({
        where: { id: input.appBlockId },
        select: {
          blockId: true,
          status: true,
          app: { select: { userId: true } },
        },
      });
      if (!block) throw throwNotFoundError('App block not found');
      // Owner gate — OauthClient.userId is the v1 app-ownership source of truth.
      // FORBIDDEN (authenticated but not permitted) rather than UNAUTHORIZED, to
      // distinguish a logged-in non-owner from an anon caller; mirrors the
      // grantScopes ceiling gate above.
      if (block.app?.userId !== ctx.user!.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not the app owner' });
      }
      // A banned/suspended account must not be issued (or re-issued) a live push
      // credential. They still can't deploy (the mod gate holds), but we don't
      // hand out a fresh Forgejo token. Full revoke-on-ban is a follow-up.
      if (ctx.user!.bannedAt) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Account is not eligible for git access',
        });
      }

      const slug = block.blockId;

      // No Forgejo repo exists until the first version is ZIP-approved
      // (approveRequest pre-creates civitai-apps/<slug>). Signal "not yet"
      // instead of provisioning a credential against a missing repo.
      if (block.status !== 'approved') {
        return {
          notYetAvailable: true as const,
          slug,
          firstVersionIsZip: true as const,
          message:
            'Your first version must be submitted as a ZIP and approved before git access is available. After that, git push to this repo to submit updates.',
        };
      }

      const { ensureForgejoIdentity } = await import(
        '~/server/services/blocks/dev-git-access.service'
      );
      const { addCollaborator } = await import('~/server/services/blocks/forgejo.service');

      const { forgejoUsername, token } = await ensureForgejoIdentity(ctx.user!.id);
      // Idempotent: grants write on this slug's repo (no-op if already a
      // collaborator). The repo lives under civitai-apps/<slug>.
      await addCollaborator({ slug, username: forgejoUsername, permission: 'write' });

      // Browser-facing host (clone via Cloudflare → oauth2-proxy is bypassed by
      // the embedded basic-auth credential, which Forgejo accepts for git).
      const publicHost = env.FORGEJO_PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const httpUrl = `https://${publicHost}/${FORGEJO_ORG}/${slug}.git`;
      const cloneUrl = `https://${encodeURIComponent(forgejoUsername)}:${token}@${publicHost}/${FORGEJO_ORG}/${slug}.git`;

      const instructions = [
        `# Clone your app repo (credential is embedded in the URL):`,
        `git clone ${cloneUrl}`,
        `cd ${slug}`,
        ``,
        `# Make changes, then:`,
        `git add -A`,
        `git commit -m "describe your change"`,
        `git push origin main`,
        ``,
        `# A push parks a pending review request. It is NOT deployed until a`,
        `# Civitai moderator approves it.`,
      ].join('\n');

      return {
        notYetAvailable: false as const,
        slug,
        httpUrl,
        cloneUrl,
        forgejoUsername,
        instructions,
        firstVersionIsZip: false as const,
      };
    }),
});

// Block-initiated workflows pay in yellow buzz only. Mature-content paid
// (blue/green) and creator-only (red) are out of scope for v1 — the
// budget is denominated in yellow, the JWT carries a yellow cap.
const BLOCK_CURRENCIES = BuzzTypes.toOrchestratorType(['yellow']);

/**
 * Fetch the user fields `parseGenerateImageInput` actually consumes
 * (id, isModerator). Cast to SessionUser at the boundary — the orchestrator
 * helpers don't reach for NextAuth-only fields.
 *
 * `tier` is intentionally absent: it's not a User column, it's stamped on
 * SessionUser at session-creation time from the highest active subscription
 * (see types/next-auth.d.ts). Without that machinery, the safest policy for
 * block-initiated calls is to fall through to the free-tier limits via the
 * `user?.tier ?? 'free'` default downstream consumers already apply. A
 * higher-tier user gets free-tier limits when generating through a block —
 * acceptable for v1; revisit if blocks need parity with web generation.
 */
async function getBlockSessionUser(userId: number): Promise<SessionUser> {
  const row = await getUserById({
    id: userId,
    select: { id: true, isModerator: true, email: true, username: true },
  });
  if (!row) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'user not found' });
  return row as unknown as SessionUser;
}

/**
 * Workflow tags drive orchestrator-side filtering, billing attribution, and
 * the "submitted via app block" audit trail. Mirrors what createTextToImage
 * does (WORKFLOW_TAGS.GENERATION + IMAGE + workflow + baseModel) plus the
 * block-specific provenance tags.
 */
function buildWorkflowTags(
  claims: { blockId: string; blockInstanceId: string; appId: string },
  baseModel: string
): string[] {
  return [
    WORKFLOW_TAGS.GENERATION,
    WORKFLOW_TAGS.IMAGE,
    'txt2img',
    baseModel,
    'app-block',
    `app-block:${claims.appId}`,
    `app-block:block:${claims.blockId}`,
    `app-block:instance:${claims.blockInstanceId}`,
  ];
}

/**
 * Server-side opportunistic daily-boost claim for block generation submits.
 *
 * Returns the `autoClaim` snapshot fragment when (and only when) the apply()
 * actually granted the user new Buzz. Returns `undefined` in every other
 * case — already-claimed-today, balance already sufficient, balance still
 * short after the would-be claim, or apply() failed.
 *
 * The Buzz API is the source of truth for balance. We sum across all
 * spend-type accounts (yellow + blue + green + red) because the user's
 * spendable pool is the union; block submits are charged in yellow today
 * but a separate yellow-only check would over-trigger the claim for users
 * whose Buzz is parked in blue/green from previous rewards.
 *
 * Conservative gating — apply() is only called when:
 *   1. boost is unclaimed today (cheap Redis HGET)
 *   2. current balance < cost (Buzz API call)
 *   3. current balance + awardAmount >= cost (boost closes the gap)
 *
 * Failure of apply() is logged and swallowed — the submit still proceeds
 * (and may fail the orchestrator-side balance check, which surfaces as
 * the existing insufficient-buzz Top-Up CTA in the block).
 */
async function maybeAutoClaimDailyBoost({
  userId,
  cost,
  ip,
}: {
  userId: number;
  cost: number;
  ip?: string | null;
}): Promise<NonNullable<ReturnType<typeof buildAutoClaim>> | undefined> {
  if (cost <= 0) return undefined;

  let boostDetails: Awaited<ReturnType<typeof dailyBoostReward.getUserRewardDetails>>;
  let balanceSum: number;
  try {
    const [details, accounts] = await Promise.all([
      dailyBoostReward.getUserRewardDetails(userId),
      getUserBuzzAccounts({ userId }),
    ]);
    boostDetails = details;
    balanceSum = Object.values(accounts).reduce((sum, n) => sum + (n ?? 0), 0);
  } catch (err) {
    // Reward-details lookup or Buzz API hiccup — don't fail the submit;
    // the user keeps the path they had pre-autoclaim.
    logToAxiom(
      {
        name: 'block-autoclaim-boost',
        type: 'warning',
        userId,
        cost,
        stage: 'precheck',
        err: (err as Error).message,
      },
      'webhooks'
    ).catch(() => null);
    return undefined;
  }

  // Already claimed today, or the reward has no payout (e.g. user is
  // rewardsIneligible — multiplier zeroed the amount).
  if (boostDetails.awarded > 0 || boostDetails.awardAmount <= 0) return undefined;

  // Balance already covers the cost — boost would just sit unused today.
  if (balanceSum >= cost) return undefined;

  // Boost wouldn't close the gap — don't burn it.
  if (balanceSum + boostDetails.awardAmount < cost) return undefined;

  try {
    await dailyBoostReward.apply({ userId }, { ip: ip ?? undefined });
  } catch (err) {
    logToAxiom(
      {
        name: 'block-autoclaim-boost',
        type: 'warning',
        userId,
        cost,
        stage: 'apply',
        err: (err as Error).message,
      },
      'webhooks'
    ).catch(() => null);
    return undefined;
  }

  return buildAutoClaim(boostDetails.awardAmount, boostDetails.accountType);
}

function buildAutoClaim(amount: number, accountType: string) {
  // Narrow the reward's accountType (could be any BuzzAccountType) into the
  // four spend-type values the snapshot contract exposes. Daily boost is
  // hard-coded to 'blue' today; the narrow exists so we don't lie to the
  // iframe if the reward's account type ever changes.
  const allowed = ['yellow', 'blue', 'red', 'green'] as const;
  type Allowed = (typeof allowed)[number];
  const safeAccountType: Allowed = (allowed as readonly string[]).includes(accountType)
    ? (accountType as Allowed)
    : 'blue';
  return { type: 'dailyBoost' as const, amount, accountType: safeAccountType };
}
