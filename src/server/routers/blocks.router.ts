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
import {
  getDailyCompensationRewardByUser,
  getUserBuzzAccount,
  getUserBuzzAccounts,
  getUserBuzzTransactions,
} from '~/server/services/buzz.service';
import { projectBlockBuzzTransaction } from '~/server/services/blocks/block-buzz-read.projection';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import {
  blockBuzzAccountTypes,
  getMyBuzzAccountsInput,
  getMyBuzzTransactionsInput,
  getMyDailyCompensationInput,
} from '~/server/schema/buzz.schema';
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
  toPublicBlockManifest,
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
  getPublishRequestDiffSchema,
  getPublishRequestScreenshotsSchema,
  getReviewStatusSchema,
  listApprovedRequestsSchema,
  listPendingRequestsSchema,
  listRejectedRequestsSchema,
  previewRequestSchema,
  rejectRequestSchema,
  teardownPreviewSchema,
  withdrawRequestSchema,
} from '~/server/schema/blocks/publish-request.schema';
import { blockWorkflowBodySchema } from '~/server/schema/blocks/workflow.schema';
import {
  allowMatureContentForCeiling,
  sfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { isAppBlocksAuthorEnabled, isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
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
import { getRequestDomainColor, isHostForColor } from '~/server/utils/server-domain';
// Type-only: the runtime `resolveCanGenerateForVersions` is loaded via a
// dynamic import() inside assertViewerCanGeneratePageResources so the heavy
// generation-service import graph (image.service → event-engine-common, etc.)
// stays OUT of this router's static import graph — mirroring the existing
// lazy import of recordScopeInvocation below.
import type { ResolveCanGenerateVersion } from '~/server/services/generation/generation.service';
import {
  appBlockTag,
  buildTextToImageInput,
  isPageLoraResource,
  projectAppWorkflow,
  resolveBlockVersionContext,
  resolvePageResourceContext,
  snapshotFromWorkflow,
} from '~/server/services/blocks/workflow.service';
// G8 — per-app aggregate spend/velocity cap. Type-only import (erased at
// runtime): the cap functions themselves are dynamic-imported in the submit
// path (mirrors recordSpendAttribution / the dev-tunnel backstop), so this adds
// no import-time cost and nothing to mock beyond the dynamic module.
import type { AppSpendDailyKey } from '~/server/services/blocks/app-spend-cap.service';
import { getResourceGenerationSupport } from '~/shared/constants/basemodel.constants';
import type { ModelType } from '~/shared/utils/prisma/enums';
import { isAppReviewer } from '~/shared/utils/app-blocks-access';
import { BuzzTypes, TransactionType } from '~/shared/constants/buzz.constants';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import {
  getBlockAllowedAccountTypes,
  isPayoutEligibleBuzz,
  orderBlockCurrencyTypes,
} from '~/server/utils/buzz-helpers';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { getBaseModelSetType, WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import {
  cancelWorkflow,
  getWorkflow,
  queryWorkflows,
  submitWorkflow,
} from '~/server/services/orchestrator/workflows';
import {
  buildGenerationContext,
  createWorkflowStepsFromGraphInput,
} from '~/server/services/orchestrator/orchestration-new.service';
import { getUserById } from '~/server/services/user.service';
import { sessionClient } from '~/server/auth/session-client';
import {
  appDeveloperProcedure,
  guardedProcedure,
  moderatorProcedure,
  protectedProcedure,
  middleware,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError, throwNotFoundError } from '~/server/utils/errorHandling';
import type { SessionUser } from '~/types/session';

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
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
});

/**
 * AUTHZ gate for the BLOCK-TOKEN-authed runtime procs (estimate/submit/poll/
 * cancelWorkflow, updateUserSettings). These are `publicProcedure` authenticated
 * by a block JWT that resolves to a viewer userId rather than `ctx.user`, so the
 * `appDeveloperProcedure` middleware can't gate them — we re-assert the AUTHOR
 * capability against the RESOLVED subject here (defense-in-depth: don't trust
 * "only authors get block tokens" — the mint is gated too, but each call
 * re-checks).
 *
 * Developer soft-launch (Phase B): this replaced the old
 * `assertViewerIsModerator` — the subject must hold the `appBlocksAuthor`
 * capability (Flipt `app-blocks-author`, static fallback mod-only), so a curated
 * non-mod cohort can generate + spend Buzz from their OWN block while a random
 * non-author subject is still FORBIDDEN.
 *
 * Hydrates the subject IDENTICALLY to `assertAppBlocksEnabledForTokenUser` (the
 * enabled kill-switch that runs right before this) — `sessionClient
 * .getSessionUserById`, the authoritative hub-backed resolver, never a
 * client-supplied value — so `buildFliptContext` sees the subject's real
 * isModerator/tier and the mod floor / segment match can't be spoofed. A
 * vanished user → undefined → no mod floor + global eval (never matches a
 * segment) → FORBIDDEN (fail-closed).
 *
 * This is the AUTHZ half only; the `isAppBlocksEnabled` kill-switch
 * (`assertAppBlocksEnabledForTokenUser`) still runs first and is unchanged.
 */
async function assertViewerIsAppDeveloper(userId: number): Promise<void> {
  const user = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  if (!(await isAppBlocksAuthorEnabled({ user: user ?? undefined }))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Apps authoring is not enabled for this account',
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
 * tokens before this runs, and `assertViewerIsAppDeveloper` + every other belt
 * (budget cap, daily Buzz cap, reserveBlockBuzzSpend, getOrchestratorToken,
 * forced-SFW) are unchanged — this only swaps which identity the FLAG sees.
 *
 * Resolves the FULL server-side SessionUser via `sessionClient.getSessionUserById`
 * (the hub-backed resolver; never a client-supplied value) so the segment match
 * can't be spoofed AND every property `buildFliptContext` consumes is real.
 *
 * ## Why the full SessionUser, not a trimmed `{ id, isModerator }` cast
 *
 * `isAppBlocksEnabled({ user })` feeds `user` to `buildFliptContext`, which
 * reads `id`, `isModerator`, AND `tier` (deriving `isMember` from `tier`). A
 * trimmed `getUserById({ select: { id, isModerator } })` cast to SessionUser
 * (the #2740 shape) leaves `tier` undefined → the Flipt context carries the
 * type-default `tier:'free'` / `isMember:'false'` instead of the user's real
 * subscription tier. That is correct TODAY only because the live
 * `app-blocks-enabled` flag segments solely on `isModerator`. The moment the
 * flag is widened to segment on `tier`/region, a stale-`free` context would
 * silently mis-gate a paying user. Resolving the real SessionUser here (whose
 * `tier` is derived from the highest active subscription — not a User column,
 * so it CANNOT be fetched by widening the select) makes the gate stay correct
 * across any future widening. Pre-GA security review hardening.
 */
async function assertAppBlocksEnabledForTokenUser(userId: number): Promise<void> {
  // Full, authoritative SessionUser (cached; tier derived from active
  // subscriptions) so buildFliptContext sees the user's REAL tier/isMember,
  // not type-defaults. A vanished user → undefined → global eval → flag false
  // → blocked (fail-closed; the subsequent assertViewerIsAppDeveloper would also
  // reject).
  // getSessionUserById returns the package SessionUser (loosely typed at this boundary — cast as bearer-token.ts
  // does) or null for a vanished user. null → undefined → isAppBlocksEnabled's global eval → flag false → blocked.
  const user = (await sessionClient.getSessionUserById(userId)) as SessionUser | null;
  if (!(await isAppBlocksEnabled({ user: user ?? undefined }))) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Apps are not enabled' });
  }
}

/**
 * Shared authorization gate for the buzz self-read bridges (`getMyBuzz*` below).
 * Mirrors `getMyBuzzBalance`'s gate but adds the `buzz:read:self` CONSENT check:
 * these reads (full ledger / all-pool balances incl. creator payout pools /
 * per-model earnings) are MORE sensitive than the spendable-balance convenience
 * read, so unlike the scope-free `getMyBuzzBalance` they require the token to
 * carry the declared+granted `buzz:read:self` scope.
 *
 * Order (each step fail-closed): verify token → require consent scope → self-bind
 * the userId off `claims.sub` (never client input) → App-Blocks kill-switch +
 * author gate against the token subject → per-instance rate limit (keyed on the
 * stable `blockInstanceId`, BEFORE any db/ClickHouse work). Returns the
 * self-bound `userId` + verified `claims`.
 */
async function authorizeBlockBuzzRead(
  blockToken: string
): Promise<{ userId: number; claims: NonNullable<Awaited<ReturnType<typeof verifyBlockToken>>> }> {
  const claims = await verifyBlockToken(blockToken);
  if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
  if (!claims.scopes.includes('buzz:read:self')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks buzz:read:self scope' });
  }
  const userId = parseSubjectUserId(claims.sub);
  if (userId == null) {
    throw new TRPCError({
      code: 'UNAUTHORIZED',
      message: 'buzz read requires an authenticated viewer',
    });
  }
  await assertAppBlocksEnabledForTokenUser(userId);
  await assertViewerIsAppDeveloper(userId);
  // Per-instance rate limit (shared blocks limiter) — bounds a block hammering
  // these private reads (esp. daily-compensation → ClickHouse) onto the origin.
  // Runs BEFORE any service call. Fail-open on a redis incident.
  const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rate.allowed) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: 'Rate limit exceeded, please retry shortly.',
    });
  }
  return { userId, claims };
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
// always an author (assertViewerIsAppDeveloper), so they see the appropriate
// access; when GA opens further the same gate bounds them properly. Fail-closed:
// a version missing from the result Map → FORBIDDEN.
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

// EPHEMERAL DEV-TUNNEL rate limit (Phase 1 pre-submit). Per-user fixed window,
// bounding how many EPHEMERAL (no-owned-AppBlock) dev-tunnel starts a single
// author can trigger — blunts host-pool enumeration / DoS across many unclaimed
// slugs. Applies ONLY to the ephemeral branch; the approved/owned path never
// increments this counter.
const EPHEMERAL_DEV_TUNNEL_RATE_LIMIT = { max: 20, windowSeconds: 3600 } as const;

/**
 * Atomically counts one ephemeral dev-tunnel start against this user's fixed
 * window and returns whether the call is ALLOWED. Same `INCR` + first-hit `EX`
 * (with a ttl<0 self-heal) shape as reserveBlockBuzzSpend / the dev-token
 * limiter. Fails CLOSED (returns false) on a Redis error — an ephemeral tunnel
 * start is not latency-critical, and failing closed here can never block the
 * approved/owned path (which does not call this).
 */
async function checkEphemeralDevTunnelRateLimit(userId: number): Promise<boolean> {
  const key = `${REDIS_SYS_KEYS.BLOCKS.DEV_TUNNEL_EPHEMERAL_RATE_LIMIT}:${userId}` as const;
  try {
    const count = await sysRedis.incrBy(key, 1);
    if (count === 1) {
      await sysRedis.expire(key, EPHEMERAL_DEV_TUNNEL_RATE_LIMIT.windowSeconds);
    } else {
      const ttl = await sysRedis.ttl(key);
      if (ttl < 0) await sysRedis.expire(key, EPHEMERAL_DEV_TUNNEL_RATE_LIMIT.windowSeconds);
    }
    return count <= EPHEMERAL_DEV_TUNNEL_RATE_LIMIT.max;
  } catch {
    // Fail closed — never silently bypass the ephemeral enumeration limiter.
    return false;
  }
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
 * NSFW-APP-RED-ONLY: true when the request is on a red-capable host
 * (civitai.red or a red alias). Drives whether mature (r/x) apps appear in the
 * marketplace listing / featured rail / detail / model-slot reads. Uses
 * `isHostForColor(host, 'red')` (NOT `getRequestDomainColor`, which returns
 * `blue` for civitai.red). Maturity is a HOST property — independent of
 * moderator status — so even a mod on civitai.com does not see mature apps in
 * these viewer-facing surfaces. Fail-closed: a missing host → false (SFW only).
 */
function isRedCapableRequest(ctx: { req?: { headers?: { host?: string } } }): boolean {
  const host = ctx.req?.headers?.host ?? '';
  return host !== '' && isHostForColor(host, 'red');
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
  const { steps, workflowMetadata } = await createWorkflowStepsFromGraphInput({
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
  // `workflowMetadata` (params/resources/remixOfId/isPrivateGeneration, already
  // `removeEmpty`-cleaned) is what populates the orchestrator queue/remix view
  // (`WorkflowData.params/resources/remixOfId`). The normal generation form
  // attaches it on submit; the block path historically dropped it, leaving
  // block-generated images with blank queue metadata (no prompt/seed/sampler/
  // resources). It is `undefined` on whatIf calls (the graph omits it then), so
  // callers can attach it to the REAL submit body only — mirroring the normal
  // path's `isWhatIf ? undefined : metadata` semantics — without a separate flag.
  return { step, workflowMetadata };
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
        // NSFW-APP-RED-ONLY: mature (r/x) apps render in a model slot only on a
        // red-capable host. Threaded from the request host.
        redCapable: isRedCapableRequest(ctx),
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
  withdrawPublishRequest: appDeveloperProcedure
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
  getMyPendingForSlug: appDeveloperProcedure
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
   * APP DEV TUNNEL — start an on-site dev tunnel for one of the caller's OWN
   * apps. Mints a pubkey-bound tunnel credential + an unguessable
   * `dev-<16hex>.<APPS_DOMAIN>` host, and renders the ephemeral Traefik route.
   *
   * GATES (all server-side, fail-closed): `appDeveloperProcedure` (author cap) +
   * `enforceAppBlocksFlag` (app-blocks-enabled) — the dual-flag — PLUS the
   * `app-blocks-dev-tunnel` kill-switch (base off → dark) PLUS the caller must OWN
   * `blockId` (resolveDevPageBlockForAuthor → null for a foreign/absent app → the
   * SAME bare NOT_FOUND, no ownership oracle). DARK until the flag is on.
   */
  startDevTunnel: appDeveloperProcedure
    // Scope gate: an OAuth token (the `civitai login` token the civitai-cli mints)
    // may open a dev tunnel ONLY if it carries the opt-in AppBlocksDevTunnel bit.
    // NOTE: enforceTokenScope (trpc.ts) EARLY-RETURNS for `ctx.tokenScope === TokenScope.Full`,
    // so a Full-scope PERSONAL API key still passes regardless of this meta — this is the
    // no-regression guarantee. Do NOT "tighten" enforceTokenScope to also gate Full keys here.
    .meta({ requiredScope: TokenScope.AppBlocksDevTunnel })
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        blockId: z.string().min(1).max(64),
        // The CLI's ephemeral SSH public key (raw OpenSSH line). Bounded so a
        // determined caller can't push parse pressure; a real ed25519/rsa pubkey
        // is well under 2kb.
        sshPublicKey: z.string().min(1).max(4096),
        // App Dev Tunnel — the caller's local `block.manifest.json` scopes, sent by
        // the CLI. Stored (clamped) on the session so an UNSUBMITTED (no-pending-row)
        // app can mint a dev token carrying them. NOT an authz input: the proc has
        // already gated author + ownership + flags; these are clamped to the tunnel
        // allowlist at write + re-gated (incl. the dedicated unsubmitted-spend flag)
        // at the mint. Bounded to blunt parse pressure; absent → read-only.
        declaredScopes: z.array(z.string().min(1).max(64)).max(32).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { isAppBlocksDevTunnelEnabled } = await import('~/server/services/app-blocks-flag');
      if (!(await isAppBlocksDevTunnelEnabled({ user: ctx.user }))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Dev tunnels are not available' });
      }
      // Ownership gate — resolve the caller's OWN app at any status. null → the
      // bare NOT_FOUND (no existence/ownership oracle, mirrors dev-token).
      const app = await BlockRegistry.resolveDevPageBlockForAuthor(input.blockId, ctx.user.id, {
        db: 'write',
      });
      if (!app) throw throwNotFoundError('App not found');
      // EPHEMERAL PRE-SUBMIT PATH (Phase 1): the caller owns no AppBlock row for
      // this slug yet (resolveEphemeralDevPageBlock returned a synthetic
      // `status:'ephemeral'` resolution — already anti-shadow-guarded so the slug
      // is unclaimed / the caller's own pending / canonical). Rate-limit these
      // host-pool allocations per-user to blunt enumeration / DoS across unclaimed
      // slugs. The approved/owned path skips this entirely.
      //
      // HONEST SECURITY NOTE (not a full "no existence oracle"): a claimed slug
      // returns the bare NOT_FOUND above (consuming NO rate-limit budget) while an
      // unclaimed slug reaches this branch (consuming budget / allocating a host),
      // so a claimed-vs-unclaimed signal is INHERENT — and once a caller exhausts
      // their 20/hr budget, claimed→NOT_FOUND vs unclaimed→429 becomes freely
      // distinguishable. What the guard DOES guarantee: it never distinguishes
      // AMONG the claimed cases (foreign-approved / foreign-pending / foreign-
      // suspended all return the identical bare NOT_FOUND). Approved slugs are
      // already public (they render at `<slug>.civit.ai`), so the only residual
      // leak is the existence of a PENDING/SUSPENDED slug — and only to another
      // author-flagged (trusted-cohort) caller. The 429 message is kept (not
      // suppressed to NOT_FOUND): actionable rate-limit feedback is better UX for
      // that trusted cohort, and it exposes nothing an exhausted-budget probe
      // couldn't already infer.
      if (app.status === 'ephemeral') {
        if (!(await checkEphemeralDevTunnelRateLimit(ctx.user.id))) {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many dev tunnel starts for unsubmitted apps; please retry shortly',
          });
        }
      }
      const { startDevTunnel } = await import('~/server/services/blocks/dev-tunnel.service');
      try {
        return await startDevTunnel({
          userId: ctx.user.id,
          // Belt-and-suspenders: key the tunnel state off the RESOLVED, canonical
          // block_id (app.blockId), never the raw client input. Safe today only
          // because the ownership resolve above ran first — using the resolved
          // value makes that independent of input normalization.
          blockId: app.blockId,
          sshPublicKey: input.sshPublicKey,
          // Self-declared local-manifest scopes (bounded above). Clamped to the
          // tunnel allowlist at write; the mint re-gates spend behind the dedicated
          // unsubmitted-spend flag. An old CLI omits this → read-only session.
          declaredScopes: input.declaredScopes,
        });
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /**
   * APP DEV TUNNEL — stop the caller's dev tunnel (revokes the credential +
   * entry-token binding + deletes the Traefik route). Idempotent. By `sessionId`
   * (from startDevTunnel) OR `blockId`. Ownership-checked server-side: a caller
   * can never tear down another author's tunnel. Same gates as startDevTunnel.
   */
  stopDevTunnel: appDeveloperProcedure
    // Same AppBlocksDevTunnel scope gate as startDevTunnel. A Full personal API key
    // still passes (enforceTokenScope early-returns on TokenScope.Full) — no regression.
    .meta({ requiredScope: TokenScope.AppBlocksDevTunnel })
    .use(enforceAppBlocksFlag)
    .input(
      z
        .object({
          sessionId: z.string().min(1).max(128).optional(),
          blockId: z.string().min(1).max(64).optional(),
        })
        .refine((v) => !!v.sessionId || !!v.blockId, {
          message: 'one of sessionId or blockId is required',
        })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { isAppBlocksDevTunnelEnabled } = await import('~/server/services/app-blocks-flag');
      if (!(await isAppBlocksDevTunnelEnabled({ user: ctx.user }))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Dev tunnels are not available' });
      }
      const { stopDevTunnel, stopDevTunnelForUserBlock } = await import(
        '~/server/services/blocks/dev-tunnel.service'
      );
      const stopped = input.sessionId
        ? await stopDevTunnel(ctx.user.id, input.sessionId)
        : await stopDevTunnelForUserBlock(ctx.user.id, input.blockId!);
      return { ok: true, stopped };
    }),

  /**
   * APP DEV TUNNEL — status of the caller's active tunnel for a block (host,
   * expiry, spend ceiling), or null when none is active. Same gates.
   */
  devTunnelStatus: appDeveloperProcedure
    // Same AppBlocksDevTunnel scope gate as startDevTunnel. A Full personal API key
    // still passes (enforceTokenScope early-returns on TokenScope.Full) — no regression.
    .meta({ requiredScope: TokenScope.AppBlocksDevTunnel })
    .use(enforceAppBlocksFlag)
    .input(z.object({ blockId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.user) throw throwAuthorizationError('Not authenticated');
      const { isAppBlocksDevTunnelEnabled } = await import('~/server/services/app-blocks-flag');
      if (!(await isAppBlocksDevTunnelEnabled({ user: ctx.user }))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Dev tunnels are not available' });
      }
      const { getActiveDevTunnel } = await import('~/server/services/blocks/dev-tunnel.service');
      const session = await getActiveDevTunnel(ctx.user.id, input.blockId);
      if (!session) return { active: false as const };
      return {
        active: true as const,
        sessionId: session.sessionId,
        host: session.host,
        expiresAt: session.hardExpiresAt,
        spendCapBuzz: session.spendCapBuzz,
      };
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
   * MOD-ONLY line-level code diff for a publish request. Computes the per-file
   * UNIFIED diff between the pending bundle and the previous approved version so
   * a reviewer can read the actual code change in the modal instead of clicking
   * out to Forgejo per file. Bounded server-side (text-only, per-file byte +
   * line caps, total file cap) — elided files are explicitly marked so the UI
   * shows the "diff too large / binary — view in Forgejo" fallback.
   *
   * Same auth shape as getPublishRequestScreenshots: `moderatorProcedure` +
   * `isModerator` belt + `enforceAppBlocksFlag` — no public path.
   */
  getPublishRequestDiff: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(getPublishRequestDiffSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Mod review is restricted to civitai team');
      }
      const { getPublishRequestDiff } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      return getPublishRequestDiff({ publishRequestId: input.publishRequestId });
    }),

  /**
   * MOD REVIEW SANDBOX (#2831) — start a temporary, mod-gated preview of a
   * PENDING version so the mod can run the actual block before approving.
   * Triggers a SEPARATE review build (distinct image + host from production)
   * and returns the review URL the UI polls toward. Torn down on the
   * approve/reject decision.
   *
   * DORMANT until the mod-only `app-blocks-review-sandbox` flag is enabled: the
   * extra flag check (on top of moderatorProcedure + the isModerator belt +
   * enforceAppBlocksFlag) makes the whole feature ship dark.
   */
  previewRequest: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(previewRequestSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Review previews are restricted to civitai team');
      }
      const { isAppBlocksReviewSandboxEnabled } = await import(
        '~/server/services/app-blocks-flag'
      );
      if (!(await isAppBlocksReviewSandboxEnabled({ user: ctx.user }))) {
        throw throwAuthorizationError('The review sandbox is not enabled');
      }
      const { previewRequest } = await import('~/server/services/blocks/publish-request.service');
      try {
        return await previewRequest({
          publishRequestId: input.publishRequestId,
          modUserId: ctx.user.id,
        });
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /**
   * MOD REVIEW SANDBOX (#2831) — poll target for the preview lifecycle state
   * (preview-building → deploying → live | failed) + the review URL. Same
   * mod-only flag gate as previewRequest.
   */
  getReviewStatus: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(getReviewStatusSchema)
    .query(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Review previews are restricted to civitai team');
      }
      const { isAppBlocksReviewSandboxEnabled } = await import(
        '~/server/services/app-blocks-flag'
      );
      if (!(await isAppBlocksReviewSandboxEnabled({ user: ctx.user }))) {
        throw throwAuthorizationError('The review sandbox is not enabled');
      }
      const { getReviewStatus } = await import('~/server/services/blocks/publish-request.service');
      try {
        // Pass the calling mod's id so getReviewStatus mints a FRESH, mod-bound,
        // short-TTL tokened previewUrl when the preview is live — the cross-origin
        // access bridge the `*.civit.ai` mod-gate forwardAuth verifies.
        return await getReviewStatus({
          publishRequestId: input.publishRequestId,
          modUserId: ctx.user.id,
        });
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /**
   * MOD REVIEW SANDBOX — MANUAL teardown of a single review preview (also the way
   * to free a slot when the global concurrent-preview cap is hit). Deletes the
   * per-request review k8s resources (label-scoped) AND clears the DB preview
   * state so the request reverts to "no preview". Same mod-only flag gate as
   * previewRequest.
   */
  teardownPreview: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(teardownPreviewSchema)
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Review previews are restricted to civitai team');
      }
      const { isAppBlocksReviewSandboxEnabled } = await import(
        '~/server/services/app-blocks-flag'
      );
      if (!(await isAppBlocksReviewSandboxEnabled({ user: ctx.user }))) {
        throw throwAuthorizationError('The review sandbox is not enabled');
      }
      const { teardownPreview } = await import('~/server/services/blocks/publish-request.service');
      try {
        return await teardownPreview({ publishRequestId: input.publishRequestId });
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
    }),

  /**
   * MOD REVIEW SANDBOX — list the currently-active review previews (global across
   * all mods) + the cap, for the "Active previews (N / cap)" panel. Same mod-only
   * flag gate as previewRequest; no input.
   */
  listActivePreviews: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .query(async ({ ctx }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Review previews are restricted to civitai team');
      }
      const { isAppBlocksReviewSandboxEnabled } = await import(
        '~/server/services/app-blocks-flag'
      );
      if (!(await isAppBlocksReviewSandboxEnabled({ user: ctx.user }))) {
        throw throwAuthorizationError('The review sandbox is not enabled');
      }
      const { listActiveReviewPreviews } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      try {
        return await listActiveReviewPreviews();
      } catch (err) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
      }
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
   * F-E E5 autogen — moderator-only backfill of autogenerated marketplace
   * screenshots for EXISTING approved apps that lack any. The deploy-success
   * hook only fires autogen on a NEW deploy; this lets a mod populate the
   * CURRENT catalog without waiting for each app to redeploy.
   *
   * Best-effort + serialised (verify-runner is single-replica). Returns a
   * per-app summary. Gated like the other mod management procs: moderatorProcedure
   * + the isModerator belt + enforceAppBlocksFlag (dark behind the flag).
   */
  backfillScreenshots: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(z.object({ limit: z.number().int().min(1).max(200).optional() }))
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Screenshot backfill is restricted to civitai team');
      }
      // DISABLED (no-op) — `backfillMissingScreenshots` short-circuits while
      // `BLOCK_SCREENSHOT_AUTOGEN_ENABLED` is false. It captured the standalone
      // `<slug>.<APPS_DOMAIN>` URL, which only renders a waiting-for-host
      // skeleton (blocks need the host `BLOCK_INIT` postMessage), so it only ever
      // produced useless skeleton screenshots. Real screenshots come from
      // creator/dev upload (or a future in-host `/apps/run/<slug>` capture). Proc
      // retained so re-enabling is a one-line flip of the const.
      const { backfillMissingScreenshots } = await import(
        '~/server/services/blocks/autogenerate-screenshot.service'
      );
      return backfillMissingScreenshots({ limit: input.limit });
    }),

  /**
   * App Store Listings (W13 P0) — moderator-only backfill. Creates one
   * store-facing AppListing per existing approved AppBlock (on-site + the #2821
   * external-link off-site rows). Idempotent on appBlockId; DARK (writes only
   * app_listings, read by nothing in the running image). `dryRun` previews the
   * counts without writing. Gated like the other mod-management procs.
   */
  backfillAppListings: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        limit: z.number().int().min(1).max(1000).optional(),
        dryRun: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('Listing backfill is restricted to civitai team');
      }
      const { backfillAppListings } = await import(
        '~/server/services/blocks/app-listing-backfill.service'
      );
      return backfillAppListings({ limit: input.limit, dryRun: input.dryRun });
    }),

  /**
   * Reject a pending publish request. Reason is required
   * (≥`PUBLISH_REJECTION_REASON_MIN` — the shared `OFFSITE_MOD_REASON_MIN`, 3 —
   * chars) and shown to the dev inline on /apps/my-submissions.
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
  listMyPublishRequests: appDeveloperProcedure
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
              // W13 P4: `hasPage` for the Open-live run-page link (does the manifest
              // declare a launchable page). PUBLIC subset only — never the raw manifest.
              manifest: true,
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

      // W13 P4 (owner controls): resolve the backing on-site `AppListing` (1:1 with
      // the AppBlock — `AppListing.appBlockId`) for each row so the UI reads the TRUE
      // live/removed listing state. A publish request stays `approved` after an owner
      // unpublish, so the request status alone can't tell live from owner-hidden. One
      // batched findMany (NOT per-row) keyed by appBlockId.
      const listingByBlockId = new Map<string, { id: string; status: string }>();
      if (appBlockIds.length) {
        const listings = await dbRead.appListing.findMany({
          where: { appBlockId: { in: appBlockIds }, kind: 'onsite' },
          select: { id: true, appBlockId: true, status: true },
        });
        for (const l of listings) {
          if (l.appBlockId) listingByBlockId.set(l.appBlockId, { id: l.id, status: l.status });
        }
      }

      // For every REMOVED backing listing, its MOST-RECENT moderation-event action —
      // so the UI distinguishes an owner-hidden listing (last event `owner-unpublish`
      // → Republish-eligible) from a moderator takedown (last event `delist`/`purge` →
      // Republish FORBIDDEN, shown as "removed by a moderator"). Batched `distinct` +
      // `orderBy desc` (ONE query, latest per listing), only over removed listings —
      // mirrors the off-site `listMySubmissions` approach.
      const removedListingIds = [...listingByBlockId.values()]
        .filter((l) => l.status === 'removed')
        .map((l) => l.id);
      const lastEvents = removedListingIds.length
        ? await dbRead.appListingModerationEvent.findMany({
            where: { appListingId: { in: removedListingIds } },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            distinct: ['appListingId'],
            select: { appListingId: true, action: true },
          })
        : [];
      const lastActionByListingId = new Map(
        lastEvents
          .filter((e): e is { appListingId: string; action: string } => e.appListingId != null)
          .map((e) => [e.appListingId, e.action])
      );

      type RowWithCount = (typeof rows)[number];
      return rows.map((r: RowWithCount) => {
        const counts = r.appBlock?._count;
        const appBlockId = r.appBlock?.id;
        const manifest = r.appBlock?.manifest;
        const { appBlock: _drop, ...rest } = r;
        // userSubscriptionCount keeps the historical meaning ("blanket +
        // pinned subscriptions for this app"); modelInstallCount is the
        // pinned-subscription subset, mirroring what the pre-migration
        // model_block_installs row count meant.
        const totalSubs = counts?.userSubscriptions ?? null;
        const pinnedCount = appBlockId ? pinnedCounts[appBlockId] ?? 0 : null;
        const listing = appBlockId ? listingByBlockId.get(appBlockId) : undefined;
        return {
          ...rest,
          modelInstallCount: pinnedCount,
          userSubscriptionCount: totalSubs,
          // The backing on-site listing id (owner unpublish/republish/history target)
          // + its TRUE lifecycle status, and — for a removed listing — the last mod
          // action (owner-hidden vs mod-removed). Null when no backing listing exists
          // (e.g. a pending first-version request, or a pre-W13 backfill gap).
          appListingId: listing?.id ?? null,
          listingStatus: listing?.status ?? null,
          lastModerationAction: listing ? lastActionByListingId.get(listing.id) ?? null : null,
          // Whether the manifest declares a launchable page (drives the Open-live →
          // /apps/run/<slug> vs standalone-origin vs model-slot branching). PUBLIC
          // subset only.
          hasPage: !!toPublicBlockManifest(manifest).hasPage,
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
        // Optional per-app drill-down ("what has THIS app spent on my behalf")
        // for the run-frame Permissions & activity drawer. Mirrors
        // listMyScopeInvocations so the per-app Buzz feed paginates server-side.
        appBlockId: z.string().min(1).max(64).optional(),
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
        appBlockId: input.appBlockId,
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
          message: 'Apps are not available to this account',
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
   * Lightweight booleans that drive the conditional links in the apps
   * sub-nav (`AppsSubNav`). One round-trip instead of fanning out to
   * `listMySubscriptions` + `listMyPublishRequests` + `getMyApps` (the
   * heavyweight per-page queries) just to decide which tabs to show.
   *
   * Booleans ONLY — no rows, no manifests, no per-app data. Each check is a
   * `findFirst({ select: { id } })` so Prisma pushes `LIMIT 1` into SQL and
   * stops at the first matching row (a `count({ take: 1 })` would NOT — Prisma
   * ignores `take` for `count` and runs a full `COUNT(*)`). Stays cheap even
   * for a user with many installs/submissions.
   *
   * `protectedProcedure` + `enforceAppBlocksFlag`: own-data scoped to
   * `ctx.user.id`; returns the all-false shape when the flag is dark so
   * the sub-nav degrades to just the always-on tabs.
   */
  getNavSummary: protectedProcedure
    .use(enforceAppBlocksFlag)
    .query(async ({ ctx }) => {
      const allFalse = {
        hasInstalls: false,
        hasSubmissions: false,
        hasApprovedApps: false,
        isReviewer: false,
      };
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) return allFalse;
      const user = ctx.user;
      if (!user) return allFalse;

      const [install, submission, approvedApp] = await Promise.all([
        dbRead.blockUserSubscription.findFirst({
          where: { userId: user.id },
          select: { id: true },
        }),
        dbRead.appBlockPublishRequest.findFirst({
          where: { submittedByUserId: user.id },
          select: { id: true },
        }),
        dbRead.appBlock.findFirst({
          where: { app: { userId: user.id }, status: 'approved' },
          select: { id: true },
        }),
      ]);

      return {
        hasInstalls: install !== null,
        hasSubmissions: submission !== null,
        hasApprovedApps: approvedApp !== null,
        isReviewer: isAppReviewer(user),
      };
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
      return BlockRegistry.listAvailable(
        input,
        !ctx.user?.isModerator,
        // NSFW-APP-RED-ONLY: hide mature (r/x) apps from the listing off .red.
        isRedCapableRequest(ctx)
      );
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
        !ctx.user?.isModerator,
        // NSFW-APP-RED-ONLY: a mature (r/x) app's detail resolves to NOT_FOUND
        // off a red-capable host (mirrors the run-page SSR 404).
        isRedCapableRequest(ctx)
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
        !ctx.user?.isModerator,
        // NSFW-APP-RED-ONLY: hide mature (r/x) apps from the featured rail off .red.
        isRedCapableRequest(ctx)
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
        throw throwAuthorizationError('Apps curation is restricted to the Civitai team');
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
        throw throwAuthorizationError('Apps curation is restricted to the Civitai team');
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
      await assertViewerIsAppDeveloper(userId);
      const token = await getOrchestratorToken(userId, ctx);
      const workflow = await getWorkflow({ token, path: { workflowId: input.workflowId } });
      return { snapshot: snapshotFromWorkflow(workflow) };
    }),

  /**
   * G6 — persistent block output queue read. Returns the CALLING VIEWER's OWN
   * recent workflows for the CALLING app block, newest first, keyset-paginated
   * + bounded. Lets a block rebuild its in-flight+done generation queue on load
   * (today the queue is client-side only, held in the iframe's memory, and lost
   * on reload / device switch).
   *
   * SERVER-SCOPED: both the viewer (`userId` from the token `sub`) and the app
   * block (`claims.appBlockId` from the JWT) are derived from the VERIFIED block
   * token — NEVER from client input — so a block can only ever read the queue of
   * the exact viewer whose session minted the token, scoped to that one app
   * block. Auth model is IDENTICAL to pollWorkflow's block-token gate. A `.query`
   * (read): returns the PERSISTED status per item; the block polls the
   * orchestrator for live details/images via `pollWorkflow`.
   */
  listMyWorkflows: publicProcedure
    // Block-JWT-authed (no session for dev:live) — flag evaluated against the
    // TOKEN subject below, not the `enforceAppBlocksFlag` middleware's ctx.user.
    .input(
      z.object({
        blockToken: z.string().min(1),
        limit: z.number().int().min(1).max(50).optional(),
        cursor: z.string().min(1).max(128).nullish(),
      })
    )
    .query(async ({ input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      if (!claims.scopes.includes('ai:write:budgeted')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
      }
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'workflow list requires authenticated viewer',
        });
      }
      // App-Blocks flag gate, evaluated against the TOKEN subject (not ctx.user).
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsAppDeveloper(userId);
      const { listMyBlockWorkflows } = await import(
        '~/server/services/blocks/block-workflows.service'
      );
      // appBlockId is bound from the token (server-scoped) — a block cannot ask
      // for another app's queue.
      return listMyBlockWorkflows({
        userId,
        appBlockId: claims.appBlockId,
        limit: input.limit,
        cursor: input.cursor,
      });
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
      await assertViewerIsAppDeveloper(userId);
      const token = await getOrchestratorToken(userId, ctx);
      await cancelWorkflow({ workflowId: input.workflowId, token });
      const workflow = await getWorkflow({ token, path: { workflowId: input.workflowId } });
      return { snapshot: snapshotFromWorkflow(workflow) };
    }),

  /**
   * App generator SUBQUEUE read — the calling app's OWN tag-scoped slice of the
   * viewer's generation workflows, projected to the clean `AppWorkflow` wire
   * shape (see projectAppWorkflow). Backs an app rebuilding its in-flight+done
   * generation queue WITH live image results (distinct from `listMyWorkflows`,
   * which reads only the persisted status read-model, and `pollWorkflow`, which
   * reads ONE workflow).
   *
   * TWO independent scoping boundaries, both server-derived from the VERIFIED
   * token — NEVER client input:
   *   1. USER scope — the orchestrator LIST is called with the viewer's OWN
   *      per-user orchestrator token, so it only ever returns that user's
   *      workflows (the personal-queue read works the same way).
   *   2. APP scope — a HOST-FORCED positive `tags:['app-block:<appId>']` filter
   *      (`appBlockTag(claims.appId)`). This is the SECURITY BOUNDARY that keeps
   *      the read to the app's OWN subqueue and OUT of the user's personal gens.
   *      The input schema exposes NO `tags` field, so a block CANNOT pass/override
   *      tags to widen the filter — the host tag is the only tag, always applied.
   *
   * MUTATION (not query) DELIBERATELY, for the same bearer-token-in-URL reason as
   * every other block-token proc (a `.query` leaks the JWT into `?input=…` /
   * logs / Referer where it is replayable within its TTL).
   *
   * Order (each step fail-closed): verify token → require `ai:write:budgeted`
   * (same trust boundary as submit — an app that can submit gens can read its own
   * subqueue) → self-bind userId off `claims.sub` (UNAUTHORIZED for anon) →
   * App-Blocks kill-switch + author gate against the TOKEN subject → per-instance
   * rate limit → orchestrator LIST with the host-forced tag → project + return.
   */
  queryAppWorkflows: publicProcedure
    // Block-JWT-authed (no session for dev:live) — flag evaluated against the
    // TOKEN subject below, not the `enforceAppBlocksFlag` middleware's ctx.user.
    .input(
      z.object({
        blockToken: z.string().min(1),
        cursor: z.string().min(1).max(256).nullish(),
        limit: z.number().int().min(1).max(50).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      // Same trust boundary as submit: an app authorized to spend the viewer's
      // Buzz on generation can read the subqueue of gens it produced.
      if (!claims.scopes.includes('ai:write:budgeted')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
      }
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'workflow query requires authenticated viewer',
        });
      }
      // App-Blocks flag gate, evaluated against the TOKEN subject (not ctx.user).
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsAppDeveloper(userId);
      // Per-instance rate limit (shared blocks limiter), BEFORE the orchestrator
      // call. Bounds a block hammering the LIST onto the origin. Fail-open on a
      // redis incident (same posture as the buzz self-read bridges).
      const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);
      if (!rate.allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Rate limit exceeded, please retry shortly.',
        });
      }
      const token = await getOrchestratorToken(userId, ctx);
      // HOST-FORCED per-app tag — the ONLY tag passed (the input has no `tags`
      // field), so a block can never remove/override/widen it. queryWorkflows
      // itself prepends 'civitai', yielding a positive AND-match of
      // ['civitai', 'app-block:<appId>'] scoped to the viewer's own workflows.
      const { nextCursor, items } = await queryWorkflows({
        token,
        tags: [appBlockTag(claims.appId)],
        take: input.limit ?? 20,
        cursor: input.cursor ?? undefined,
        hideMatureContent: false,
      });
      return {
        workflows: items.map(projectAppWorkflow),
        cursor: nextCursor ?? null,
      };
    }),

  /**
   * Cancel ONE workflow in the calling app's OWN subqueue — FAIL-CLOSED.
   *
   * The orchestrator's by-id GET/PATCH/DELETE `/{workflowId}` endpoints do NOT
   * verify caller-vs-workflow ownership, so canceling with the viewer's token is
   * NOT by itself a gate — a guessed/forged id belonging to another user (or a
   * non-app personal generation) could otherwise be canceled. This procedure
   * COMPENSATES with a two-part guard BEFORE the cancel:
   *   (a) OWNERSHIP+ATTRIBUTION — the `block_workflows` read-model must carry a
   *       row for the exact (userId from token `sub`, appBlockId from token,
   *       workflowId) tuple (`blockWorkflowOwnedByAppUser`). This is the durable
   *       USER binding the orchestrator lacks — the load-bearing check.
   *   (b) APP TAG — the orchestrator's OWN record for the workflow must carry the
   *       `app-block:<appId>` tag (defense-in-depth: the two systems must agree it
   *       is this app's workflow).
   * If EITHER fails → FORBIDDEN and the orchestrator cancel is NEVER called.
   *
   * MUTATION for the bearer-token-in-URL reason (see queryAppWorkflows). Scope +
   * gate order identical to queryAppWorkflows/cancelWorkflow.
   */
  cancelAppWorkflow: publicProcedure
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
      await assertViewerIsAppDeveloper(userId);
      // Per-instance rate limit (shared blocks limiter), BEFORE any orchestrator
      // read/DELETE or DB query. Cancel is the HEAVIER path (2 orchestrator GETs +
      // 1 DELETE + 1 DB lookup per call), so it MUST be bounded exactly like the
      // sibling queryAppWorkflows — same key (blockInstanceId) + scope. Fail-open
      // on a redis incident (matches the buzz self-read bridges / query proc).
      const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);
      if (!rate.allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Rate limit exceeded, please retry shortly.',
        });
      }
      // GUARD (a): the durable user+app-block-bound ownership proof. Bound
      // entirely from the verified token — a block can only ever authorize a
      // workflow it actually submitted for THIS viewer. Fail-closed.
      const { blockWorkflowOwnedByAppUser } = await import(
        '~/server/services/blocks/block-workflows.service'
      );
      const owned = await blockWorkflowOwnedByAppUser({
        userId,
        appBlockId: claims.appBlockId,
        workflowId: input.workflowId,
      });
      if (!owned) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'workflow is not in this app subqueue',
        });
      }
      const token = await getOrchestratorToken(userId, ctx);
      // GUARD (b): re-read the workflow and assert the orchestrator's OWN record
      // carries the per-app tag — defense-in-depth over (a). Done with the
      // viewer's token (which does NOT itself gate ownership per the note above).
      const workflow = await getWorkflow({ token, path: { workflowId: input.workflowId } });
      if (!(workflow.tags ?? []).includes(appBlockTag(claims.appId))) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'workflow is not tagged for this app',
        });
      }
      // Both guards passed — cancel, then re-read + project the terminal state.
      await cancelWorkflow({ workflowId: input.workflowId, token });
      const canceled = await getWorkflow({ token, path: { workflowId: input.workflowId } });
      return { workflow: projectAppWorkflow(canceled) };
    }),

  /**
   * PUBLISH selected outputs of ONE of the calling app's OWN workflows as bare,
   * REAL-SCANNED public `Image` rows — the write half of the Model-Benchmarking
   * shared-grid seam. FAIL-CLOSED, and identical gate order to
   * queryAppWorkflows/cancelAppWorkflow up to the ownership guard.
   *
   * The block sends `workflowId` + optional `imageIndexes` (indexes into the same
   * ordered `images` array queryAppWorkflows exposes) — NEVER urls: the HOST
   * resolves the orchestrator urls SERVER-SIDE from the ownership-verified
   * workflow, fetches + re-uploads each selected output to civitai storage, and
   * creates each `Image` with DEFAULT ingestion (real NSFW scan; NO skipIngestion)
   * and NO postId — a bare row, no Post / gallery / feed / reward / notification.
   * So a sandboxed iframe can never inject an arbitrary blob NOR publish someone
   * else's workflow.
   *
   * Two fail-closed ownership guards BEFORE any byte is fetched (mirrors
   * cancelAppWorkflow): (a) `blockWorkflowOwnedByAppUser` — the durable
   * (userId-from-token, appBlockId-from-token, workflowId) binding the
   * orchestrator lacks; (b) the orchestrator's own record must carry the
   * `app-block:<appId>` tag. Either fails → FORBIDDEN, nothing is published.
   *
   * MUTATION for the bearer-token-in-URL reason (see queryAppWorkflows).
   */
  publishGenerationOutputs: publicProcedure
    .input(
      z.object({
        blockToken: z.string().min(1),
        workflowId: z.string().min(1).max(64),
        // Indexes into the workflow's available outputs (the same ordering
        // queryAppWorkflows returns). Absent ⇒ publish ALL available outputs.
        imageIndexes: z.number().int().nonnegative().array().max(50).optional(),
        // Advisory label (reserved; bare Image rows carry no title today).
        title: z.string().max(255).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      // Same trust boundary as submit/query: an app authorized to spend the
      // viewer's Buzz on generation can publish the outputs it produced.
      if (!claims.scopes.includes('ai:write:budgeted')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
      }
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'publishing requires an authenticated viewer',
        });
      }
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsAppDeveloper(userId);
      const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);
      if (!rate.allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Rate limit exceeded, please retry shortly.',
        });
      }
      // GUARD (a): durable user+app-bound ownership proof — fail-closed.
      const { blockWorkflowOwnedByAppUser } = await import(
        '~/server/services/blocks/block-workflows.service'
      );
      const owned = await blockWorkflowOwnedByAppUser({
        userId,
        appBlockId: claims.appBlockId,
        workflowId: input.workflowId,
      });
      if (!owned) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'workflow is not in this app subqueue' });
      }
      const token = await getOrchestratorToken(userId, ctx);
      // GUARD (b): re-read + assert the orchestrator's own app-tag (defense in depth).
      const workflow = await getWorkflow({ token, path: { workflowId: input.workflowId } });
      if (!(workflow.tags ?? []).includes(appBlockTag(claims.appId))) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'workflow is not tagged for this app' });
      }

      // The SAME ordered projection queryAppWorkflows hands the block — so the
      // block's `imageIndexes` line up exactly with what it saw. Only `available`
      // outputs with a non-null url are present (dead/pending blobs are dropped).
      const outputs = projectAppWorkflow(workflow).images;
      if (outputs.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'workflow has no available outputs to publish',
        });
      }
      // Resolve the selection: given indexes (validated in-range) or all outputs.
      // Dedupe + cap so a block can't drive an unbounded fetch/upload fan-out.
      const PUBLISH_MAX_IMAGES = 20;
      const rawIndexes = input.imageIndexes ?? outputs.map((_, i) => i);
      const selected: typeof outputs = [];
      const seenIdx = new Set<number>();
      for (const idx of rawIndexes) {
        if (idx < 0 || idx >= outputs.length || seenIdx.has(idx)) continue;
        seenIdx.add(idx);
        selected.push(outputs[idx]);
        if (selected.length >= PUBLISH_MAX_IMAGES) break;
      }
      if (selected.length === 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'no valid output indexes to publish',
        });
      }

      const { persistBlockWorkflowOutputImage } = await import(
        '~/server/services/blocks/block-image-upload.service'
      );
      // Best-effort per image: collect the ids that publish, so one bad blob
      // never blanks the whole grid. Only throw when EVERY selected output failed.
      const imageIds: number[] = [];
      let lastError: unknown;
      for (const out of selected) {
        try {
          const { imageId } = await persistBlockWorkflowOutputImage({
            imageUrl: out.url,
            width: out.width,
            height: out.height,
            userId,
          });
          imageIds.push(imageId);
        } catch (err) {
          lastError = err;
        }
      }
      if (imageIds.length === 0) {
        throw lastError instanceof TRPCError
          ? lastError
          : new TRPCError({ code: 'BAD_REQUEST', message: 'failed to publish any output' });
      }
      return { imageIds };
    }),

  /**
   * Cross-user gated image read — the read half of the Model-Benchmarking
   * shared-grid seam. Given the image ids a benchmark grid stored, returns a
   * per-VIEWER gated projection: `visible` (moderated projection incl. a gated
   * edge url) for images this viewer may see, `hidden` (NO url) for anything
   * above their browsing ceiling / unscanned / flagged. The clamp is the block
   * token's `maxBrowsingLevel` (the platform-computed viewer+domain ceiling),
   * failed closed to the public floor — a block can NEVER obtain an unclamped url
   * for an image the viewer isn't allowed to see. Reads ONLY bare (post-less)
   * rows. Public, maturity-clamped data (like the block catalog reads) → no
   * capability scope beyond a valid block token; auth is still required so the
   * clamp is bound to a real viewer.
   *
   * MUTATION for the bearer-token-in-URL reason (see queryAppWorkflows).
   */
  getImagesByIds: publicProcedure
    .input(
      z.object({
        blockToken: z.string().min(1),
        imageIds: z.number().int().positive().array().min(1).max(100),
      })
    )
    .mutation(async ({ input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'gated image read requires an authenticated viewer',
        });
      }
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsAppDeveloper(userId);
      const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);
      if (!rate.allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Rate limit exceeded, please retry shortly.',
        });
      }
      const { getBlockGatedImagesByIds, resolveViewerBrowsingLevel } = await import(
        '~/server/services/blocks/block-gated-images.service'
      );
      // The AUTHORITATIVE per-viewer ceiling for a block surface is the token's
      // maxBrowsingLevel claim (platform-computed at mint), failed closed to PG.
      const browsingLevel = resolveViewerBrowsingLevel(claims.maxBrowsingLevel);
      return getBlockGatedImagesByIds({ imageIds: input.imageIds, browsingLevel });
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
        // IMAGE bridge (Phase-2a): img2img via `sourceImage` is a PAGE-ONLY
        // feature. Custom Generators is a page app; model-bound img2img is out
        // of scope and unvetted for 2a, so reject it fail-closed on the model
        // path (mirrors the additionalResources guard above).
        if (input.body.sourceImage) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'source image (img2img) is not supported for model-bound blocks',
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
      await assertViewerIsAppDeveloper(userId);
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
      const { allowMatureContent, isGreen } = resolveBlockMaturity(claims);
      // Currency parity (on-site `resolveGenerationCurrencies`): blue-first +
      // the domain currency, derived from the SAME authoritative ceiling as the
      // output clamp. SFW → blue/green; mature → blue/yellow.
      const currencies = resolveBlockCurrencies(isGreen);
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
      // whatIf: no `metadata` on the body — matches the normal path
      // (`generateFromGraph` builds workflowMetadata only for real submits) and
      // `createBlockTextToImageStep` returns `workflowMetadata: undefined` here.
      const { step } = await createBlockTextToImageStep({ input: generateInput, user, whatIf: true });
      const workflow = await submitWorkflow({
        token,
        body: {
          steps: [step],
          tags: buildWorkflowTags(claims, resolved.baseModel),
          currencies,
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
        // IMAGE bridge (Phase-2a): img2img via `sourceImage` is PAGE-ONLY.
        // Reject it fail-closed on the model path (see estimateWorkflow for the
        // same guard). Custom Generators is a page app.
        if (input.body.sourceImage) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'source image (img2img) is not supported for model-bound blocks',
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
      await assertViewerIsAppDeveloper(userId);
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
      // Currency parity (on-site `resolveGenerationCurrencies`): blue-first +
      // the domain currency, derived from the SAME authoritative ceiling as the
      // output clamp. SFW → blue/green; mature → blue/yellow. Used by BOTH the
      // whatIf cost-check and the real submit below so the estimate matches what
      // the real submit will actually drain.
      //
      // Money page blocks may pick a preferred `accountType` — honor it
      // PREFERRED-FIRST while keeping the maturity policy clamp: an in-set pick
      // is moved to the front (with the rest as fallback); an out-of-set pick is
      // rejected; absent → Auto (unchanged). See resolveBlockCurrenciesForAccount.
      const currencies = resolveBlockCurrenciesForAccount(isGreen, input.body.accountType);

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
      // whatIf cost preflight: `workflowMetadata` is undefined here (graph omits
      // it on whatIf), and the whatif body never carries `metadata` anyway.
      const { step: stepForCostCheck } = await createBlockTextToImageStep({
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
          currencies,
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

      // G8 — PER-APP aggregate SPEND + VELOCITY cap (generic safety). The
      // per-user cap above bounds ONE viewer's daily spend but is BLIND to MANY
      // viewers (a Sybil ring of sockpuppets, each under its own per-user
      // ceiling) funnelling aggregate spend through ONE app. This is the HARD
      // PREREQUISITE called out below at the spend-attribution "SYBIL CAP NOTE"
      // before shareable, spend-driving block apps open to non-mods. Reserve
      // this generation against the app's rolling DAILY Buzz total + short-window
      // generation VELOCITY (same atomic INCRBY reserve/refund as the per-user
      // cap). On breach → refund the per-user daily reservation just made and
      // reject fail-safe (NO spend).
      //
      // EXCLUSION: skipped for DEV/live-harness tokens (`claims.dev === true`),
      // which carry a synthetic non-FK appBlockId and already have the
      // per-session dev-tunnel spend backstop below — so a dev iterating locally
      // is never clamped by the aggregate cap (matches recordSpendAttribution
      // being inert for a synthetic appId).
      let appSpendReserve: { key: AppSpendDailyKey; cost: number } | null = null;
      if (claims.dev !== true) {
        const { reserveAppSpend } = await import('~/server/services/blocks/app-spend-cap.service');
        const appSpend = await reserveAppSpend(claims.appBlockId, cost);
        if (!appSpend.allowed) {
          // Roll back the per-user reservation made above so a rejected submit
          // doesn't burn the viewer's own daily ceiling for a spend that never
          // happened.
          await refundBlockBuzzSpend(buzzCapKey, cost);
          return {
            snapshot: {
              workflowId: 'failed',
              status: 'failed' as const,
              cost: { total: cost },
              // Generic, no-number rejection — the exact aggregate ceiling is not
              // leaked to a (potentially hostile) app.
              error:
                appSpend.reason === 'velocity'
                  ? 'app generation rate limit reached: this app has run too many generations in a short window — please retry shortly'
                  : appSpend.reason === 'unavailable'
                  ? 'generation temporarily unavailable — please retry shortly'
                  : "app daily spend cap reached: this app has hit its aggregate daily generation-spend ceiling — please try again later",
            },
          };
        }
        // Keep the pinned key so a later throw can refund the reservation.
        if (appSpend.dailyKey) appSpendReserve = { key: appSpend.dailyKey, cost };
      }

      // APP DEV TUNNEL per-session spend backstop (F4). When the caller has an
      // ACTIVE dev tunnel for THIS block, bound cumulative spend within that ONE
      // dev session (a backstop OVER the per-call budget + the per-user daily cap
      // above) so a runaway LOCAL submit loop can't drain Buzz. The block token
      // carries no dev-session id (see the P4 audit / handoff note), so the
      // session is resolved SERVER-SIDE from (userId, blockId) — a single Redis
      // GET that misses (and no-ops) for every non-dev submit.
      //
      // Posture: the LOOKUP fails OPEN (a getActiveDevTunnel error → treat as
      // non-dev, so a Redis blip can't break ALL generation — the daily cap still
      // applies), but the ENFORCEMENT fails CLOSED (reserveDevSessionBuzz denies
      // on a Redis error once we know it IS a dev session). Mirrors the daily
      // cap's refund-on-throw so a failed submit doesn't permanently burn the
      // session ceiling. Why the fail-open is SAFE: the fail-CLOSED per-user daily
      // cap (reserveBlockBuzzSpend above, whose incrBy is NOT wrapped in a catch)
      // has ALREADY run and throws on any Redis error — so a real Redis outage
      // rejects the submit BEFORE this lookup even executes. The fail-open here
      // can therefore only degrade the finer session cap while the daily cap is
      // healthy, i.e. within an already-daily-capped bound — never an uncapped one.
      let devSessionReserve: { sessionId: string; cost: number } | null = null;
      {
        const { getActiveDevTunnel, reserveDevSessionBuzz } = await import(
          '~/server/services/blocks/dev-tunnel.service'
        );
        const devTunnel = await getActiveDevTunnel(userId, claims.blockId).catch(() => null);
        if (devTunnel) {
          const reserved = await reserveDevSessionBuzz(
            devTunnel.sessionId,
            cost,
            devTunnel.spendCapBuzz
          );
          if (!reserved.allowed) {
            // Over the session ceiling → refund the daily reservation made above
            // (the session reserve rolled ITSELF back on deny) and reject. Also
            // refund the G8 per-app reservation (present only for non-dev tokens;
            // a token with `dev !== true` can still have an active dev tunnel).
            await refundBlockBuzzSpend(buzzCapKey, cost);
            if (appSpendReserve) {
              const { refundAppSpend } = await import(
                '~/server/services/blocks/app-spend-cap.service'
              );
              await refundAppSpend(appSpendReserve.key, appSpendReserve.cost);
            }
            return {
              snapshot: {
                workflowId: 'failed',
                status: 'failed' as const,
                cost: { total: cost },
                error:
                  `dev tunnel session Buzz cap reached: ${reserved.total} already spent ` +
                  `this dev session, this generation costs ${Math.ceil(cost)}, ` +
                  `session cap is ${devTunnel.spendCapBuzz}`,
              },
            };
          }
          devSessionReserve = { sessionId: devTunnel.sessionId, cost: Math.ceil(cost) };
        }
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
      // Hoisted out of the try so the post-submit spend-attribution closure
      // (which runs AFTER the try/catch) can read the REALIZED per-account
      // debit — `submitted` is a try-block `const` and is out of scope there.
      let realizedTransactions: Awaited<ReturnType<typeof submitWorkflow>>['transactions'];
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

        // REAL submit: attach `workflowMetadata` so the orchestrator queue/remix
        // view shows the prompt/seed/sampler/cfg/steps/resources. This is the
        // non-whatIf call (no `whatIf` flag), so the graph builds metadata and
        // `createBlockTextToImageStep` returns it. Mirrors the normal form path
        // (`generateFromGraph` passes `metadata: workflowMetadata`). `removeEmpty`
        // already stripped fields the block context lacks (e.g. remixOfId).
        const { step, workflowMetadata } = await createBlockTextToImageStep({
          input: generateInput,
          user,
          isGreen,
        });
        const submitted = await submitWorkflow({
          token,
          body: {
            steps: [step],
            tags,
            currencies,
            metadata: workflowMetadata,
            // Authoritative maturity clamp on the REAL submit — the orchestrator
            // rejects mature output when this is false. Token-claim derived.
            ...(allowMatureContent === false ? { allowMatureContent: false } : {}),
          },
        });
        snapshot = snapshotFromWorkflow(submitted);
        realizedTransactions = submitted.transactions;
      } catch (e) {
        // No resolved submit → undo the reservation (net-equivalent to the old
        // "only record after a resolved submit" behavior) and propagate. Refund
        // against the pinned key, not a re-derived one (midnight-UTC race).
        await refundBlockBuzzSpend(buzzCapKey, cost);
        // G8 — mirror the daily refund for the per-app aggregate reservation so a
        // failed submit doesn't permanently burn the app's daily ceiling.
        // Best-effort; present only for non-dev tokens.
        if (appSpendReserve) {
          const { refundAppSpend } = await import(
            '~/server/services/blocks/app-spend-cap.service'
          );
          await refundAppSpend(appSpendReserve.key, appSpendReserve.cost);
        }
        // F4 — mirror the daily refund for the dev-session reservation so a failed
        // submit doesn't permanently burn the session ceiling. Best-effort.
        if (devSessionReserve) {
          const { refundDevSessionBuzz } = await import(
            '~/server/services/blocks/dev-tunnel.service'
          );
          await refundDevSessionBuzz(devSessionReserve.sessionId, devSessionReserve.cost);
        }
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
          // W13 richer detail — the buzz SPEND (negative) + terminal outcome so
          // the activity row reads "Generated an image (spent N Buzz)". `cost`
          // is the reserved/charged budget for this submit.
          detail: {
            action: 'workflow.submit',
            amount: typeof cost === 'number' ? -Math.abs(cost) : undefined,
            outcome: snapshot.status === 'failed' ? 'failed' : 'ok',
          },
          // Phase 2 — App Dev Tunnel: a PRE-APPROVAL dev-tunnel spend carries a
          // synthetic, non-FK appBlockId (`ephemeral-<slug>`). This is the durable
          // per-spend audit row for that case (recordSpendAttribution below is
          // inert for a synthetic appId, by design). `dev` routes it to the
          // nullable-appBlockId path so the row persists instead of FK-failing.
          dev: claims.dev === true,
        });
      })().catch(() => {
        /* swallowed inside helper */
      });

      // G6 — persistent block output queue (generic read-model). Upsert a
      // `block_workflows` row so the block can rebuild its in-flight+done
      // generation queue on reload / device switch (today the queue is
      // client-side only, held in the iframe's memory, and lost on reload).
      // EVERYTHING is server-derived from the VERIFIED token claims
      // (appBlockId/blockInstanceId from the JWT, viewer from `sub`) + the
      // orchestrator workflow id + the submit-time status. Fire-and-forget with
      // the write's OWN try/catch (mirrors recordScopeInvocation /
      // recordSpendAttribution): a failed queue write must NEVER add latency to,
      // or break, the submit response.
      //
      // Only on a REAL workflow id, and NOT for dev/live-harness tokens (which
      // carry a synthetic non-FK appBlockId — the FK would reject them; the
      // dev/live queue is ephemeral and held in the harness).
      if (
        claims.dev !== true &&
        snapshot.workflowId &&
        snapshot.workflowId !== 'failed' &&
        snapshot.workflowId !== 'whatif'
      ) {
        void (async () => {
          const { upsertBlockWorkflowOnSubmit } = await import(
            '~/server/services/blocks/block-workflows.service'
          );
          await upsertBlockWorkflowOnSubmit({
            workflowId: snapshot.workflowId,
            appBlockId: claims.appBlockId,
            blockInstanceId: claims.blockInstanceId,
            userId,
            status: snapshot.status,
          });
        })().catch(() => {
          /* best-effort: a failed queue write never breaks (or slows) submit */
        });
      }

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
          // Record a PAYOUT-SAFE currency basis for this spend off the REAL
          // per-account debit. The orchestrator drains the offered currencies
          // in spend order (blue-FIRST — blue is the free generation Buzz) and
          // surfaces the REALIZED per-account debit on the SAME `submitted`
          // workflow this handler already holds: `transactions.list` carries
          // one entry per charge with `type` (debit/credit), `amount`, and
          // `accountType` (blue | green | yellow). On-site generation earns at
          // parity off this exact signal, so block payout must too.
          //
          // Rule: a generation can split across FREE (blue) and PAID
          // (green/yellow) Buzz. ONLY the PAID portion earns — stamp the paid
          // account and the SUMMED paid debit amount, so the author bounty
          // accrues off what the user actually paid, never the free blue
          // portion. The offered currencies are ['blue', green|yellow] (never
          // both green and yellow), so at most ONE paid account is ever
          // drained; we NET that paid account's debits against any same-submit
          // credits (a partial refund / charge correction the orchestrator may
          // emit in the SAME transactions.list) so the bounty accrues off what
          // the user NET paid, not a gross debit that was partly refunded.
          //
          // When NO paid debit is present — a blue-only spend, OR a cache-hit /
          // 0-cost gen, OR a snapshot the orchestrator returned WITHOUT
          // transactions — we fall back to the conservative FREE floor (blue +
          // the realized/estimated cost), which `isPayoutEligibleBuzz`
          // (computeSpendShare) EXCLUDES → ZERO bounty. This preserves the
          // anti-farming guarantee: free-Buzz spend can never accrue a bounty,
          // and an absent/unknown debit signal never pays. Forge-safe:
          // `submitted` is the orchestrator's authoritative response, not
          // client input.
          // ALL paid-account (green/yellow) entries — debits AND credits — so we
          // can net them. Blue/fakeRed are excluded by isPayoutEligibleBuzz.
          const paidEntries = (realizedTransactions?.list ?? []).filter((t) =>
            isPayoutEligibleBuzz(t.accountType)
          );
          // Defensive guard against a FUTURE change that offers BOTH green and
          // yellow (today the contract is ['blue', green|yellow], so at most one
          // paid account is touched). If more than one distinct paid accountType
          // shows up we can't attribute a single paid currency, so refuse to
          // conflate them and fall back to the conservative blue floor below.
          const distinctPaidTypes = new Set(paidEntries.map((t) => t.accountType));
          // NET the paid account: debits add, credits (refunds/corrections in the
          // same workflow) subtract. A net <= 0 means nothing was net-paid → floor.
          const netPaidAmount =
            distinctPaidTypes.size > 1
              ? 0
              : paidEntries.reduce(
                  (sum, t) =>
                    sum + (t.type === 'debit' ? Math.abs(t.amount ?? 0) : -Math.abs(t.amount ?? 0)),
                  0
                );
          const hasPaidDebit = distinctPaidTypes.size === 1 && netPaidAmount > 0;
          // `isPayoutEligibleBuzz` already narrowed accountType to green|yellow,
          // both valid `BuzzSpendType`s; size===1 ⇒ every paid entry shares it.
          const paidType = hasPaidDebit
            ? (paidEntries[0].accountType as BuzzSpendType)
            : undefined;

          // paidType is set iff hasPaidDebit; otherwise fall to the conservative
          // free floor (getBlockAllowedAccountTypes[0] === 'blue' in both branches).
          const spentBuzzType: BuzzSpendType = paidType ?? getBlockAllowedAccountTypes(isGreen)[0];
          const spentBuzzAmount = hasPaidDebit
            ? netPaidAmount
            : Math.ceil(snapshot.cost?.total ?? cost);

          await recordSpendAttribution({
            userId,
            buzzAmount: spentBuzzAmount,
            buzzType: spentBuzzType,
            workflowId: spendWorkflowId,
            appId: claims.appId,
            appBlockId: claims.appBlockId,
            blockInstanceId: claims.blockInstanceId,
            modelId: resolved.modelId,
            // GENERIC published-content-author basis: the opaque shared-storage
            // key the app supplied for the content this generation runs on
            // behalf of. Passed through OPAQUE — the service resolves the author
            // SERVER-SIDE from the app's own shared storage (never trusts the
            // client). Omitted → unchanged app-owner-only attribution.
            sharedContentKey: input.body.sharedContentKey ?? null,
          });
        })().catch(() => {
          /* best-effort: a failed attribution write never breaks submit */
        });
      }

      return { snapshot: autoClaim ? { ...snapshot, autoClaim } : snapshot };
    }),

  /**
   * HOST-MEDIATED balance read for the token-bound viewer (money page blocks).
   * Returns the viewer's OWN spendable buzz balances so a page can render an
   * account picker + "you have N buzz" without the page ever holding the
   * `buzz:read:self` scope.
   *
   * NOTE: `buzz:read:self` is page-safe (PAGE_FORBIDDEN_SCOPES is empty — see
   * slot-registry.ts), and the richer self-reads (ledger / all-pool balances /
   * per-model earnings) live on the sibling `getMyBuzz{Transactions,Accounts}` /
   * `getMyDailyCompensation` bridges, which REQUIRE that scope. This procedure
   * stays the scope-free convenience path: the FIRST-PARTY host exposing the
   * viewer's OWN spendable balance to their OWN page session, mediated by the
   * proof-of-session block token — userId is derived from the token `sub`
   * (self-bound), NEVER from client input, so a page can only ever read the
   * balance of the exact user whose session minted the token.
   *
   * Auth model is IDENTICAL to submitWorkflow's block-token gate: verify the
   * token, require an authenticated (non-anon) subject, then the App-Blocks
   * enabled kill-switch + author gate evaluated against the TOKEN subject. Only
   * the three spendable types the UI needs are returned (blue/green/yellow) —
   * internal types (red / creatorProgram / cash) are omitted.
   */
  getMyBuzzBalance: publicProcedure
    // Block-JWT-authed (no session for dev:live) — flag evaluated against the
    // TOKEN subject below, not the `enforceAppBlocksFlag` middleware's ctx.user.
    //
    // MUTATION (not query) DELIBERATELY: the block JWT is a bearer credential
    // that ALSO authorizes submitWorkflow (spend). A tRPC .query sends small
    // inputs as HTTP GET with the input in the URL (?input=...), leaking the
    // token into CF/nginx/Traefik logs, browser history, and Referer where it
    // is replayable within its TTL. Every block-token-authed proc in this router
    // is a mutation for exactly this reason (token in the POST body). Keep it so.
    .input(z.object({ blockToken: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      // Derive the user from the SELF-BOUND token subject, never client input.
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'buzz balance requires an authenticated viewer',
        });
      }
      // Same gates as the other block-token procs, evaluated against the TOKEN
      // subject: the enabled kill-switch AND the author capability.
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsAppDeveloper(userId);
      // getUserBuzzAccounts returns every spend type; project to just the three
      // spendable types the UI needs (omit red / creator-program / cash).
      const accounts = await getUserBuzzAccounts({ userId });
      return {
        blue: accounts.blue ?? 0,
        green: accounts.green ?? 0,
        yellow: accounts.yellow ?? 0,
      };
    }),

  /**
   * HOST-MEDIATED buzz LEDGER read for the token-bound viewer (money page
   * blocks — a Buzz dashboard). Pages the SUBJECT's own transactions for ONE
   * pool per call. MUTATION (not query) for the same reason as getMyBuzzBalance:
   * a .query leaks the bearer block token into the ?input= URL / logs / Referer.
   *
   * CONSENT: requires the `buzz:read:self` scope (see authorizeBlockBuzzRead) —
   * the ledger is more sensitive than the spendable-balance convenience read.
   *
   * Response rows carry the SECURITY-HARDENED projection
   * (projectBlockBuzzTransaction): `details` allowlisted to entity-attribution
   * only (no passthrough / no stripePaymentIntentId), `externalTransactionId`
   * nulled for payment-processor-reference rows, counterparties stripped to
   * `{ id, username }`, `type` serialized as its name.
   */
  getMyBuzzTransactions: publicProcedure
    .input(getMyBuzzTransactionsInput)
    .mutation(async ({ input }) => {
      const { userId } = await authorizeBlockBuzzRead(input.blockToken);
      const { accountType, type, cursor, start, end, limit } = input;
      const { cursor: nextCursor, transactions } = await getUserBuzzTransactions({
        accountId: userId, // SELF-BOUND — never client input.
        accountType,
        type: type ? TransactionType[type] : undefined,
        cursor,
        start,
        end,
        limit,
      });
      return { cursor: nextCursor, transactions: transactions.map(projectBlockBuzzTransaction) };
    }),

  /**
   * HOST-MEDIATED all-pool balance read for the token-bound viewer. Returns the
   * SUBJECT's balance for every pool in `blockBuzzAccountTypes` (the three
   * spendable types PLUS the creator payout pools the spendable-only
   * getMyBuzzBalance omits). MUTATION + `buzz:read:self` consent, self-bound.
   */
  getMyBuzzAccounts: publicProcedure
    .input(getMyBuzzAccountsInput)
    .mutation(async ({ input }) => {
      const { userId } = await authorizeBlockBuzzRead(input.blockToken);
      const accounts = await getUserBuzzAccount({
        accountId: userId, // SELF-BOUND — never client input.
        accountTypes: [...blockBuzzAccountTypes],
      });
      return { accounts: accounts.map(({ accountType, balance }) => ({ accountType, balance })) };
    }),

  /**
   * HOST-MEDIATED per-modelVersion generation-compensation read for the
   * token-bound viewer (the month containing `date`). MUTATION + `buzz:read:self`
   * consent, self-bound. Fans out to Postgres + ClickHouse — the rate limit in
   * authorizeBlockBuzzRead runs first. Cash amounts stay in tenths-of-a-penny as
   * the service returns them.
   */
  getMyDailyCompensation: publicProcedure
    .input(getMyDailyCompensationInput)
    .mutation(async ({ input }) => {
      const { userId } = await authorizeBlockBuzzRead(input.blockToken);
      return getDailyCompensationRewardByUser({
        userId, // SELF-BOUND — never client input.
        date: input.date,
        source: input.source,
        accountType: input.accountType,
      });
    }),

  /**
   * HOST-MEDIATED viewer self-read for the token-bound viewer (a page block
   * reading "who am I"). Backs the SDK `useViewer()` hook via the GET_VIEWER
   * page-host bridge, and is the host-mediated successor to the
   * `GET /api/v1/blocks/me` REST endpoint (which STAYS LIVE for now — this
   * bridge supersedes it once the SDK hook publishes + consumers migrate; a
   * later follow-up retires /me).
   *
   * MUTATION (not query) DELIBERATELY, for the SAME reason as getMyBuzzBalance:
   * the block JWT is a bearer credential a `.query` would leak into the
   * `?input=…` URL / logs / Referer where it is replayable within its TTL. Keep
   * it a mutation (token rides the POST body).
   *
   * CONSENT: requires the `user:read:self` scope — the least-privileged scope
   * that conveys "viewer identity" (audit I3; mirrors how /blocks/me gates via
   * `withBlockScope({ requiredScope: 'user:read:self' })`). Unlike the scope-free
   * getMyBuzzBalance, a block must declare+be-granted this scope.
   *
   * Order (each step fail-closed): verify token → require the consent scope →
   * self-bind the userId off `claims.sub` (never client input; UNAUTHORIZED for
   * anon) → App-Blocks kill-switch + author gate against the TOKEN subject →
   * per-instance rate limit (keyed on the stable `blockInstanceId`, BEFORE the
   * db read — the ban/mute lookup hits the PRIMARY, so a hammering block must be
   * bounded) → the /blocks/me identity read.
   *
   * The identity read mirrors src/pages/api/v1/blocks/me.ts EXACTLY: `dbWrite`
   * (NOT the replica) so a banned/muted-during-replication-lag viewer can't
   * surface as active; 404 (NOT_FOUND) on a vanished/deleted user; 403
   * (FORBIDDEN) on a banned viewer (a token minted just before a ban is valid
   * for up to ~15min — reject here as a second line of defense); a muted viewer
   * passes through with `status: 'muted'` so the block can suppress write UI.
   * `buzzBudget` is surfaced from the token claim (if present) so a block can
   * clamp UI without a second call — same shape /me returns.
   */
  getMyViewer: publicProcedure
    // Block-JWT-authed (no session for dev:live) — flag evaluated against the
    // TOKEN subject below, not the `enforceAppBlocksFlag` middleware's ctx.user.
    // MUTATION for the bearer-token-in-URL reason above (see getMyBuzzBalance).
    .input(z.object({ blockToken: z.string().min(1) }))
    .mutation(async ({ input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      // CONSENT: the least-privileged "viewer identity" scope (mirrors /blocks/me).
      if (!claims.scopes.includes('user:read:self')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks user:read:self scope' });
      }
      // Derive the user from the SELF-BOUND token subject, never client input.
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'viewer read requires an authenticated viewer',
        });
      }
      // Same gates as the other block-token procs, evaluated against the TOKEN
      // subject: the enabled kill-switch AND the author capability (pre-GA
      // team-only gate — the router-side equivalent of /blocks/me's isModerator
      // check).
      await assertAppBlocksEnabledForTokenUser(userId);
      await assertViewerIsAppDeveloper(userId);
      // Per-instance rate limit (shared blocks limiter) — bounds a block
      // hammering the PRIMARY (the ban/mute lookup below reads dbWrite). Runs
      // BEFORE the db read. Fail-open on a redis incident.
      const rate = await checkBlockCatalogRateLimit(claims.blockInstanceId);
      if (!rate.allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Rate limit exceeded, please retry shortly.',
        });
      }
      // dbWrite (NOT the replica) for the ban/mute/deleted lookup — mirrors
      // /blocks/me: reading the replica lets a banned-during-replication-lag
      // viewer surface to the block as active.
      const user = await dbWrite.user.findUnique({
        where: { id: userId },
        select: { id: true, username: true, bannedAt: true, muted: true, deletedAt: true },
      });
      if (!user || user.deletedAt) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }
      // A banned user with a still-valid token must NOT surface as a real viewer.
      if (user.bannedAt) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'banned' });
      }
      return {
        id: user.id,
        username: user.username,
        // Muted viewers pass through so the block can suppress write UI.
        status: (user.muted ? 'muted' : 'active') as 'active' | 'muted',
        // Per-call spend cap the block was issued with — surfaced so the block
        // can clamp UI without a second call (mirrors /blocks/me).
        buzzBudget: claims.buzzBudget ?? null,
      };
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
      await assertViewerIsAppDeveloper(userId);
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
          // W13 richer detail — structured code for the render-time sentence.
          detail: { action: 'settings.update', outcome: 'ok' },
        });
      })().catch(() => {});

      return { ok: true };
    }),

  /**
   * Publisher revenue summary. Caller must be the app owner — the
   * service filters by `app_owner_user_id` so even if the request
   * carries a different appBlockId, the rows are scoped to the caller.
   * Auth is enforced by appDeveloperProcedure (the `appBlocksAuthor`
   * capability); no need to also assert ownership of the requested appBlockId
   * (the join filter does it).
   */
  getMyRevenue: appDeveloperProcedure
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
   * Same audience gate as getMyRevenue (appDeveloperProcedure +
   * enforceAppBlocksFlag — dark behind the appBlocks flag). Ownership is
   * enforced inside the service: it resolves the caller's owned app_block
   * ids via AppBlock.app.userId and returns zeroed/empty analytics for a
   * non-owned id, so an author can never read another author's metrics.
   */
  getMyAppAnalytics: appDeveloperProcedure
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
  getMyApps: appDeveloperProcedure
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
          message: 'Apps are not available to this account',
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

  /**
   * App management (Phase 1) — return the FULL stored manifest for one of the
   * caller's OWN apps so the web editor can pre-fill the edit form. Owner-gated
   * exactly like getMyAppRepo (OauthClient.userId is the v1 ownership source of
   * truth). Distinct from the public getAppDetail (which returns only the
   * PublicAppDetail allowlist, no scopes/full manifest) — this is the owner's
   * own private read.
   */
  getMyAppManifest: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(z.object({ appBlockId: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      if (!ctx.features.appBlocks) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Apps are not available to this account',
        });
      }
      const block = await dbRead.appBlock.findUnique({
        where: { id: input.appBlockId },
        select: {
          id: true,
          blockId: true,
          status: true,
          version: true,
          manifest: true,
          app: {
            select: { userId: true, allowedScopes: true, allowedOrigins: true },
          },
        },
      });
      if (!block) throw throwNotFoundError('App block not found');
      if (block.app?.userId !== ctx.user!.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not the app owner' });
      }
      return {
        appBlockId: block.id,
        slug: block.blockId,
        status: block.status,
        version: block.version,
        manifest: block.manifest as Record<string, unknown>,
        // Surfaced so the client can preview which scopes/origins the edit is
        // bounded by (the SERVER re-derives + enforces these on save — the
        // client copy is advisory only).
        allowedScopes: block.app?.allowedScopes ?? 0,
        allowedOrigins: block.app?.allowedOrigins ?? [],
      };
    }),

  /**
   * App management (Phase 1) — edit an app's manifest from the web UI. On save
   * this does a BACKGROUND commit of the new block.manifest.json to the app's
   * canonical Forgejo repo (civitai-apps/<slug>), which RE-ENTERS the existing
   * no-trust review flow: the commit is recorded as a `pending` publish request
   * and NEVER auto-approves or deploys. A moderator must approve it through the
   * existing /apps/review → approveRequest → build → deploy path.
   *
   * HARD RULES enforced here:
   *   - OWNER-only (OauthClient.userId), authenticated, app must be `approved`
   *     (the canonical repo only exists after the first ZIP approval).
   *   - blockId is IMMUTABLE — the caller cannot rename the slug; we force the
   *     merged manifest's blockId back to the stored slug.
   *   - iframe.src is platform-owned — re-stamped to the canonical subdomain.
   *   - the merged manifest is RE-VALIDATED server-side with
   *     BlockManifestValidator against the app's OauthClient context (scope
   *     subset + allowedOrigins SSRF binding) — the client manifest is NEVER
   *     trusted.
   *   - version must strictly increase (semver) so each edit is a new version.
   *
   * The commit itself fires the git-push webhook too, but we ALSO call
   * recordPendingFromPush explicitly (idempotent at (slug, sha)) so the editor
   * gets a stable publishRequestId back without depending on webhook delivery.
   */
  updateManifest: protectedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        appBlockId: z.string().min(1).max(64),
        // Editable manifest fields. blockId / iframe.src are intentionally
        // ABSENT — blockId is immutable (forced server-side) and iframe.src is
        // platform-owned (stamped server-side). Everything is optional so the
        // client can send a sparse patch; we deep-merge onto the stored manifest.
        patch: z
          .object({
            name: z.string().min(1).max(200).optional(),
            // New version — REQUIRED so every manifest edit is a distinct
            // version (mirrors a ZIP submitVersion). Must strictly exceed the
            // stored version (checked below).
            version: z.string().min(1).max(64),
            contentRating: z.string().min(1).max(8).optional(),
            renderMode: z.string().min(1).max(16).optional(),
            trustTier: z.string().min(1).max(16).optional(),
            description: z.string().max(5000).optional(),
            scopes: z.array(z.string().min(1).max(128)).max(64).optional(),
            publicSettingsKeys: z.array(z.string().min(1).max(64)).max(32).optional(),
            targets: z
              .array(z.object({ slotId: z.string().min(1).max(64) }).passthrough())
              .max(16)
              .optional(),
            page: z
              .object({
                path: z.string().min(1).max(256),
                title: z.string().min(1).max(128),
                icon: z.string().max(128).optional(),
                buzzBudgetPerGen: z.number().int().positive().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
            // Editable iframe sub-fields (NOT src — that's platform-owned).
            iframe: z
              .object({
                minHeight: z.number().optional(),
                maxHeight: z.number().nullable().optional(),
                resizable: z.boolean().optional(),
                sandbox: z.string().max(256).optional(),
              })
              .partial()
              .optional(),
          })
          .strict(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!ctx.features.appBlocks) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Apps are not available to this account',
        });
      }

      const block = await dbRead.appBlock.findUnique({
        where: { id: input.appBlockId },
        select: {
          id: true,
          blockId: true,
          status: true,
          version: true,
          // trustTier is SERVER-OWNED (moderator-controlled, NOT
          // publisher-declared) — loaded so we can re-stamp it onto the merged
          // manifest before validation (see below), mirroring
          // submitVersion/approveRequest.
          trustTier: true,
          manifest: true,
          app: { select: { userId: true, allowedScopes: true, allowedOrigins: true } },
        },
      });
      if (!block) throw throwNotFoundError('App block not found');
      // Owner gate — OauthClient.userId is the v1 ownership source of truth.
      if (block.app?.userId !== ctx.user!.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not the app owner' });
      }
      // A banned/suspended account must not be able to mutate a live app.
      if (ctx.user!.bannedAt) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Account is not eligible to edit apps',
        });
      }
      // The canonical Forgejo repo only exists once the first version is
      // ZIP-approved (approveRequest pre-creates civitai-apps/<slug>); until
      // then there's nothing to commit to.
      if (block.status !== 'approved') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'Your first version must be submitted as a ZIP and approved before you can edit the manifest from the web.',
        });
      }

      const slug = block.blockId;
      const { patch } = input;

      // Merge the patch onto the STORED manifest (the source of truth) — never
      // trust a client-supplied full manifest. Deep-merge `iframe` so the
      // editable sub-fields override but the platform-owned `src` survives the
      // merge (it's then re-stamped below regardless).
      const stored = (block.manifest ?? {}) as Record<string, unknown>;
      const storedIframe =
        stored.iframe && typeof stored.iframe === 'object' && !Array.isArray(stored.iframe)
          ? (stored.iframe as Record<string, unknown>)
          : {};
      const merged: Record<string, unknown> = {
        ...stored,
        ...patch,
        // blockId is IMMUTABLE — force back to the stored slug regardless of
        // anything the client sent (the input schema doesn't even accept it, but
        // belt-and-suspenders against a future schema widening).
        blockId: slug,
        iframe: { ...storedIframe, ...(patch.iframe ?? {}) },
      };

      // version must STRICTLY increase so each edit is a new, ordered version
      // (mirrors a ZIP submitVersion). Reject equal/lower to keep the version
      // monotonic and avoid a no-op review churn.
      const { SEMVER_REGEX } = await import('~/server/schema/blocks/publish-request.schema');
      const newVersion = patch.version;
      if (!SEMVER_REGEX.test(newVersion)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `version "${newVersion}" must be semver (e.g. 1.2.3)`,
        });
      }
      if (compareSemver(newVersion, block.version) <= 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `version must be greater than the current version (${block.version})`,
        });
      }
      merged.version = newVersion;

      // iframe.src is PLATFORM-OWNED — stamp the canonical per-app subdomain
      // root so the validator's origin-binding + the webhook's exact-match gate
      // both pass, exactly as submit/approve/git-push do.
      const { stampCanonicalIframeSrc } = await import(
        '~/server/services/blocks/manifest-normalize'
      );
      stampCanonicalIframeSrc(merged, slug, env.APPS_DOMAIN);

      // trustTier is SERVER-OWNED (moderator-controlled, NOT publisher-declared)
      // — force it back to the tier already on the app's row regardless of what
      // the client patched. Raising the tier is a deliberate out-of-band
      // moderator/DB action, never a manifest field. This makes the validator
      // below (which reads `manifest.trustTier` to gate the iframe sandbox
      // allowlist) run against the tier we'll actually persist, exactly as
      // submitVersion/approveRequest do — closing the gap where a client could
      // self-declare `internal` to pass a sandbox/scope combo their real tier
      // forbids.
      merged.trustTier = block.trustTier ?? 'unverified';

      // RE-VALIDATE server-side against the app's OauthClient context. This is
      // the security boundary: scope-subset + allowedOrigins SSRF binding are
      // enforced here, never trusting the client. (The git-push webhook will
      // also re-validate the committed manifest — defense in depth.)
      const { BlockManifestValidator } = await import(
        '~/server/services/block-manifest-validator.service'
      );
      const appContext = {
        allowedScopes: block.app?.allowedScopes ?? 0,
        allowedOrigins: (block.app?.allowedOrigins ?? []).map((o: string) => o.toLowerCase()),
      };
      const validation = BlockManifestValidator.validate(merged, appContext);
      if (!validation.valid) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Invalid manifest: ${validation.errors.join('; ')}`,
        });
      }

      // Background commit of the new manifest to the CANONICAL repo. We use the
      // admin-token commitFiles (same call approveRequest uses) — Forgejo fires
      // the push webhook regardless of which token committed, so this naturally
      // re-enters the no-trust review path. replaceAllFiles is FALSE: we only
      // touch block.manifest.json, leaving the app's source untouched.
      const { commitFiles } = await import('~/server/services/blocks/forgejo.service');
      const manifestJson = Buffer.from(JSON.stringify(merged, null, 2) + '\n', 'utf8');
      const { sha } = await commitFiles({
        org: FORGEJO_ORG,
        slug,
        files: [{ path: 'block.manifest.json', content: manifestJson }],
        message: `Manifest update: ${slug} v${newVersion}`,
      });

      // Deterministically record the pending review (idempotent at (slug, sha)
      // with the webhook the commit also fires). This is what makes the edit
      // enter the SAME no-trust pending-review gate a direct git push does.
      const { recordPendingFromPush } = await import(
        '~/server/services/blocks/publish-request.service'
      );
      const { publishRequestId } = await recordPendingFromPush({
        slug,
        sha,
        appBlockId: block.id,
        manifest: merged,
        version: newVersion,
      });

      return {
        publishRequestId,
        slug,
        version: newVersion,
        sha,
        status: 'pending' as const,
      };
    }),

  /**
   * App management (Phase 2) — return the caller's per-user Forgejo clone info
   * for one of THEIR apps, for the read-only `civitai app pull` CLI command.
   * Owner-gated identically to getMyAppRepo; lazily provisions the scoped,
   * restricted per-user Forgejo identity (ensureForgejoIdentity) and grants it
   * read on the app's own civitai-apps/<slug> repo.
   *
   * Distinct from getMyAppRepo only in intent (pull/sync vs push instructions);
   * it returns the raw { forgejoUsername, token, cloneUrl } the CLI assembles
   * its git command from. The token is embedded in the returned cloneUrl exactly
   * as getMyAppRepo does (the CLI documents the token-in-URL leakage caveat).
   */
  getMyForgejoCloneInfo: protectedProcedure
    .use(enforceAppBlocksFlag)
    // Accept EITHER the appBlockId (ab_…) OR the slug (blockId / repo name) — the
    // CLI `civitai app pull --app <slug|appBlockId>` lets a developer pass the
    // human-friendly slug, which is the repo name they think in.
    .input(
      z
        .object({
          appBlockId: z.string().min(1).max(64).optional(),
          slug: z.string().min(1).max(64).optional(),
        })
        .refine((v) => !!v.appBlockId || !!v.slug, {
          message: 'one of appBlockId or slug is required',
        })
    )
    .query(async ({ ctx, input }) => {
      if (!ctx.features.appBlocks) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Apps are not available to this account',
        });
      }
      const block = input.appBlockId
        ? await dbRead.appBlock.findUnique({
            where: { id: input.appBlockId },
            select: { blockId: true, status: true, app: { select: { userId: true } } },
          })
        : await dbRead.appBlock.findFirst({
            where: { blockId: input.slug },
            select: { blockId: true, status: true, app: { select: { userId: true } } },
          });
      if (!block) throw throwNotFoundError('App block not found');
      if (block.app?.userId !== ctx.user!.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not the app owner' });
      }
      if (ctx.user!.bannedAt) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Account is not eligible for git access',
        });
      }
      const slug = block.blockId;
      if (block.status !== 'approved') {
        return {
          notYetAvailable: true as const,
          slug,
          message:
            'Your first version must be submitted as a ZIP and approved before git access is available.',
        };
      }

      const { ensureForgejoIdentity } = await import(
        '~/server/services/blocks/dev-git-access.service'
      );
      const { addCollaborator } = await import('~/server/services/blocks/forgejo.service');
      const { forgejoUsername, token } = await ensureForgejoIdentity(ctx.user!.id);
      // Read is enough to pull/sync; grant `read` (idempotent). getMyAppRepo
      // grants `write` for the push flow — the CLI `pull` only needs read.
      await addCollaborator({ slug, username: forgejoUsername, permission: 'read' });

      const publicHost = env.FORGEJO_PUBLIC_URL.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const httpUrl = `https://${publicHost}/${FORGEJO_ORG}/${slug}.git`;
      const cloneUrl = `https://${encodeURIComponent(forgejoUsername)}:${token}@${publicHost}/${FORGEJO_ORG}/${slug}.git`;

      return {
        notYetAvailable: false as const,
        slug,
        forgejoUsername,
        token,
        httpUrl,
        cloneUrl,
      };
    }),
});

/**
 * Compare two semver strings (x.y.z[-pre]). Returns -1 / 0 / 1 for a<b / a==b /
 * a>b. Pre-release handling is intentionally simple: any prerelease is ordered
 * BELOW its release (1.2.3-rc < 1.2.3) and two prereleases compare lexically —
 * enough to enforce "the new version must strictly increase" for the manifest
 * editor (the canonical SEMVER_REGEX already validated the shape).
 */
function compareSemver(a: string, b: string): number {
  const split = (v: string): { nums: number[]; pre: string | null } => {
    const [core, pre = null] = v.split('-', 2);
    const nums = core.split('.').map((n) => parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre };
  };
  const A = split(a);
  const B = split(b);
  for (let i = 0; i < 3; i++) {
    if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  }
  // Cores equal — a release outranks any prerelease of the same core.
  if (A.pre === null && B.pre === null) return 0;
  if (A.pre === null) return 1; // a is the release, b is a prerelease
  if (B.pre === null) return -1;
  return A.pre < B.pre ? -1 : A.pre > B.pre ? 1 : 0;
}

// Block-initiated workflows spend at PARITY with the on-site generator
// (`getAllowedAccountTypes` / `resolveGenerationCurrencies`): the currencies
// are derived PER REQUEST from the block token's AUTHORITATIVE maturity ceiling
// (`resolveBlockMaturity(claims).isGreen`), NOT hardcoded. SFW (green/blue)
// blocks spend ['blue','green']; mature (.red) blocks spend ['blue','yellow'] —
// blue-first, drained in array order, identical to on-site. See
// `getBlockAllowedAccountTypes`. The maturity that picks the currency is the
// SAME ceiling that drives the output clamp, so currency and clamp can never
// disagree. The per-gen Buzz BUDGET plumbing (`ai:write:budgeted` +
// `buzzBudget`) is currency-AGNOSTIC and unchanged — the cap bounds total Buzz
// regardless of which account type pays.
//
// PAYOUT-SAFETY: widening the SPENDABLE currencies here is decoupled from
// payout eligibility. The author-bounty rail (#2605) excludes only free
// (blue) Buzz via `isPayoutEligibleBuzz` at the payout boundary
// (`computeSpendShare`); green and yellow are PAID and payout-eligible. So
// this widening can NEVER make free Buzz become platform-funded farming.
// See buzz-helpers.ts.
function resolveBlockCurrencies(isGreen: boolean) {
  return BuzzTypes.toOrchestratorType(getBlockAllowedAccountTypes(isGreen));
}

// PREFERRED-FIRST + DOMAIN-CLAMPED currency selection for a viewer-picked
// account (money page blocks). The domain-allowed set is derived from the
// token's AUTHORITATIVE maturity ceiling (`getBlockAllowedAccountTypes`) — the
// maturity policy gate — and is NEVER widened here.
//
//   - accountType absent          → return the allowed set unchanged (Auto).
//     Byte-identical to `resolveBlockCurrencies(isGreen)`, so the no-pick path
//     preserves today's behavior exactly.
//   - accountType NOT in the set  → REJECT (BAD_REQUEST). A SFW block can't
//     spend yellow, a mature block can't spend green. We never silently spend a
//     different account than requested, and never add a disallowed account.
//   - accountType in the set      → move it to the FRONT, keeping the remaining
//     allowed currencies as FALLBACK. The orchestrator drains in array order,
//     so the picked account pays first but a generation still succeeds when the
//     preferred account alone can't cover it (total across the allowed accounts
//     is enough) — preferred-first, then fall back.
function resolveBlockCurrenciesForAccount(
  isGreen: boolean,
  accountType: BuzzSpendType | undefined
): ReturnType<typeof resolveBlockCurrencies> {
  const { ordered, disallowed } = orderBlockCurrencyTypes(isGreen, accountType);
  if (disallowed) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `buzz account '${accountType}' is not spendable for this app's content rating`,
    });
  }
  return BuzzTypes.toOrchestratorType(ordered);
}

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
    // Per-app subqueue tag — the SAME helper `blocks.queryAppWorkflows` filters
    // on, so the STAMP and the READ can never desync (see appBlockTag).
    appBlockTag(claims.appId),
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
