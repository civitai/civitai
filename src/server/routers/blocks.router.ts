import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { parseSubjectUserId, verifyBlockToken } from '~/server/middleware/block-scope.middleware';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { dailyBoostReward } from '~/server/rewards/active/dailyBoost.reward';
import { getUserBuzzAccounts } from '~/server/services/buzz.service';
import { manifestSettingsSchema } from '~/server/schema/blocks/manifest-settings.meta.schema';
import { validateBlockSettings } from '~/server/services/blocks/settings-validator.service';
import {
  listAvailableSchema,
  subscriptionScopeSchema,
} from '~/server/schema/blocks/subscription.schema';
import {
  approveRequestSchema,
  backfillPublishRequestSchema,
  getMyPendingForSlugSchema,
  listApprovedRequestsSchema,
  listPendingRequestsSchema,
  listRejectedRequestsSchema,
  rejectRequestSchema,
  submitVersionSchema,
  withdrawRequestSchema,
} from '~/server/schema/blocks/publish-request.schema';
import { blockWorkflowBodySchema } from '~/server/schema/blocks/workflow.schema';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { BlockRegistry } from '~/server/services/block-registry.service';
import {
  getRecentAttributionsForOwner,
  getRevenueForOwner,
} from '~/server/services/blocks/buzz-attribution.service';
import {
  getRepresentativeBaseModel,
  resolveBlockCheckpoint,
  validateBlockCheckpoint,
} from '~/server/services/blocks/checkpoint.service';
import { getModelShowcaseImages } from '~/server/services/blocks/showcase.service';
import {
  buildTextToImageInput,
  resolveBlockVersionContext,
  snapshotFromWorkflow,
} from '~/server/services/blocks/workflow.service';
import { BuzzTypes } from '~/shared/constants/buzz.constants';
import { WORKFLOW_TAGS } from '~/shared/constants/generation.constants';
import { auditPromptServer } from '~/server/services/orchestrator/promptAuditing';
import { cancelWorkflow, getWorkflow, submitWorkflow } from '~/server/services/orchestrator/workflows';
import { createTextToImageStep } from '~/server/services/orchestrator/textToImage/textToImage';
import { getUserById } from '~/server/services/user.service';
import {
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
 */
const enforceAppBlocksFlag = middleware(async ({ next, type }) => {
  if (await isAppBlocksEnabled()) return next();
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

// ---- Cumulative Buzz-spend cap (audit A7 / design-gaps H1) -----------------
//
// `claims.buzzBudget` is a PER-CALL ceiling only. Without an aggregate cap, a
// block holding a valid token (15-min lifetime, freely re-minted) can issue
// unlimited sequential `submitWorkflow` calls each ≤ budget and drain the
// viewer's entire Buzz balance. This adds a per-(user, app_block, UTC-day)
// cumulative ceiling enforced server-side in submitWorkflow, backed by a Redis
// counter that self-expires at the end of its window.
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

function buzzCapRedisKey(
  userId: number,
  appBlockId: string
): `${typeof REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:${string}` {
  return `${REDIS_SYS_KEYS.BLOCKS.BUZZ_CAP}:${userId}:${appBlockId}:${buzzCapWindowKey()}`;
}

/**
 * Returns the cumulative Buzz already spent by this (user, app_block) in the
 * current UTC-day window. 0 when the key is absent (fresh window / first spend).
 */
async function getBlockBuzzSpentInWindow(userId: number, appBlockId: string): Promise<number> {
  const raw = await sysRedis.get(buzzCapRedisKey(userId, appBlockId));
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Records `cost` against the cumulative window counter after a successful
 * submit. Sets the TTL on the (effectively) first write so the per-window key
 * self-expires. INCRBY is atomic, so concurrent submits accumulate correctly.
 */
async function recordBlockBuzzSpend(
  userId: number,
  appBlockId: string,
  cost: number
): Promise<void> {
  if (cost <= 0) return;
  const key = buzzCapRedisKey(userId, appBlockId);
  const total = await sysRedis.incrBy(key, Math.ceil(cost));
  // Set expiry once: if the counter just became >= the increment, this is the
  // first write of the window. (ttl<0 guard also re-arms a key that somehow
  // lost its TTL.)
  if (total <= Math.ceil(cost)) {
    await sysRedis.expire(key, BLOCK_BUZZ_CAP_TTL_SECONDS);
  } else {
    const ttl = await sysRedis.ttl(key);
    if (ttl < 0) await sysRedis.expire(key, BLOCK_BUZZ_CAP_TTL_SECONDS);
  }
}

// Free-form slot strings are a cache-busting surface for anon callers.
// Bound to the explicit set we ship today; new slots ship by extending this.
const KNOWN_SLOT_IDS = z.enum(['model.sidebar_top', 'model.below_images', 'model.actions_extra']);

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

  installOnModel: moderatorProcedure
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
      return BlockRegistry.installOnModel({
        ...input,
        installedByUserId: ctx.user!.id,
      });
    }),

  updateSettings: moderatorProcedure
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
  toggleEnabled: moderatorProcedure
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
  uninstallFromModel: moderatorProcedure
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
   * W1 publish-request flow — developer uploads a ZIP bundle (the full app
   * directory) for moderator review. v0 keeps the gate at `isModerator`;
   * v1 (W11 audit + W5 scopes) opens it to external developers.
   *
   * Replaced the legacy `submitApp` direct-Forgejo-push procedure: under
   * W1 there is no developer-facing "create repo" step — the OauthClient
   * + Forgejo repo + app_blocks row are all created server-side in
   * `approveRequest` (Phase 3) when a mod approves the first version.
   *
   * Bundle is base64-encoded in the JSON body — simpler than multipart
   * for v0 (50 MiB max, 67 MiB encoded, well within reach of the default
   * Next.js body limit).
   */
  submitVersion: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .input(submitVersionSchema)
    .mutation(async ({ ctx, input }) => {
      const [{ submitVersion }, { env }] = await Promise.all([
        import('~/server/services/blocks/publish-request.service'),
        import('~/env/server'),
      ]);

      if (!ctx.user?.isModerator) {
        throw throwAuthorizationError('App submission is restricted to civitai team at v0');
      }
      if (!env.BUNDLE_S3_ENDPOINT || !env.BUNDLE_S3_BUCKET) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Bundle storage not configured in this environment',
        });
      }

      // Decode + validate the bundle bytes. The schema's pre-decode cap
      // is a cheap sanity check; the service re-checks against the real
      // post-decode buffer size.
      let bundleBuffer: Buffer;
      try {
        bundleBuffer = Buffer.from(input.bundleBase64, 'base64');
      } catch (err) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `bundleBase64 is not valid base64: ${(err as Error).message}`,
        });
      }

      try {
        return await submitVersion({
          bundleBuffer,
          submittedByUserId: ctx.user.id,
        });
      } catch (err) {
        // Service throws plain Errors with human-readable messages
        // (bundle too large, missing manifest, invalid blockId / version
        // / name in manifest, etc). Surface as BAD_REQUEST so the form
        // can render them inline.
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: (err as Error).message,
        });
      }
    }),

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
  listMyScopeGrants: moderatorProcedure
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
  listMyAppActivity: moderatorProcedure
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
  setSubscriptionPinnedVersion: moderatorProcedure
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
  listMyScopeInvocations: moderatorProcedure
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
  listMySubscriptions: moderatorProcedure
    .use(enforceAppBlocksFlag)
    .query(async ({ ctx }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) return [];
      return BlockRegistry.listUserSubscriptions(ctx.user!.id);
    }),

  /**
   * Marketplace listing — approved app blocks, optionally filtered by slot
   * and/or a free-text query. Cursor-paginated. Public (any user can
   * browse the marketplace; install requires auth).
   */
  listAvailable: publicProcedure
    .use(enforceAppBlocksFlag)
    .input(listAvailableSchema)
    .query(async ({ ctx, input }) => {
      if ((ctx as { _appBlocksDisabled?: boolean })._appBlocksDisabled) {
        return { items: [], nextCursor: undefined };
      }
      // Phase 2: marketplace listing is moderator-only until GA.
      if (!ctx.user?.isModerator) return { items: [], nextCursor: undefined };
      return BlockRegistry.listAvailable(input);
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
  upsertSubscription: moderatorProcedure
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
  deleteSubscription: moderatorProcedure
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
    .use(enforceAppBlocksFlag)
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
    .use(enforceAppBlocksFlag)
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
    .use(enforceAppBlocksFlag)
    .input(z.object({ blockToken: z.string().min(1), body: blockWorkflowBodySchema }))
    .mutation(async ({ ctx, input }) => {
      const claims = await verifyBlockToken(input.blockToken);
      if (!claims) throw new TRPCError({ code: 'UNAUTHORIZED', message: 'invalid block token' });
      if (!claims.scopes.includes('ai:write:budgeted')) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'block lacks ai:write:budgeted scope' });
      }
      // Context binding mirrors enforceContextBinding's models:read:self path —
      // re-check here because the middleware version takes a NextApiRequest and
      // we're in tRPC land.
      const ctxModelId = Number((claims.ctx as { modelId?: unknown } | undefined)?.modelId ?? NaN);
      if (!Number.isInteger(ctxModelId) || ctxModelId !== input.body.modelId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'modelId mismatch with token' });
      }
      const userId = parseSubjectUserId(claims.sub);
      if (userId == null) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'estimate requires authenticated viewer',
        });
      }
      await assertViewerIsModerator(userId);
      const ctxSlotId = (claims.ctx as { slotId?: unknown } | undefined)?.slotId;
      if (typeof ctxSlotId !== 'string' || ctxSlotId.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'block token lacks slotId context' });
      }
      const resolved = await resolveBlockVersionContext(
        input.body.modelVersionId,
        input.body.modelId
      );
      const checkpoint = await resolveBlockCheckpoint({
        blockInstanceId: claims.blockInstanceId,
        modelId: resolved.modelId,
        modelVersionId: resolved.modelVersionId,
        baseModel: resolved.baseModel,
        modelType: resolved.modelType,
        userId,
        slotId: ctxSlotId,
      });
      const user = await getBlockSessionUser(userId);
      const token = await getOrchestratorToken(userId, ctx);
      const generateInput = buildTextToImageInput(input.body, {
        ...resolved,
        checkpointVersionId: checkpoint.versionId,
      });
      const step = await createTextToImageStep({ ...generateInput, user, whatIf: true });
      const workflow = await submitWorkflow({
        token,
        body: {
          steps: [step],
          tags: buildWorkflowTags(claims, resolved.baseModel),
          currencies: BLOCK_CURRENCIES,
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
    .use(enforceAppBlocksFlag)
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
      const ctxModelId = Number((claims.ctx as { modelId?: unknown } | undefined)?.modelId ?? NaN);
      if (!Number.isInteger(ctxModelId) || ctxModelId !== input.body.modelId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'modelId mismatch with token' });
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
      await assertViewerIsModerator(userId);
      const ctxSlotId = (claims.ctx as { slotId?: unknown } | undefined)?.slotId;
      if (typeof ctxSlotId !== 'string' || ctxSlotId.length === 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'block token lacks slotId context' });
      }
      const resolved = await resolveBlockVersionContext(
        input.body.modelVersionId,
        input.body.modelId
      );
      const checkpoint = await resolveBlockCheckpoint({
        blockInstanceId: claims.blockInstanceId,
        modelId: resolved.modelId,
        modelVersionId: resolved.modelVersionId,
        baseModel: resolved.baseModel,
        modelType: resolved.modelType,
        userId,
        slotId: ctxSlotId,
      });
      const user = await getBlockSessionUser(userId);
      const token = await getOrchestratorToken(userId, ctx);

      // Prompt audit before any orchestrator interaction (mirrors what
      // generateFromGraph does). A block can't bypass moderation by submitting
      // through this path.
      await auditPromptServer({
        prompt: input.body.params.prompt,
        negativePrompt: input.body.params.negativePrompt,
        userId,
        isGreen: false,
        isModerator: !!user.isModerator,
      });

      const generateInput = buildTextToImageInput(input.body, {
        ...resolved,
        checkpointVersionId: checkpoint.versionId,
      });

      // Cost preflight. Build the step once, reuse for both whatif and submit
      // so the orchestrator computes cost against the exact same step it'll
      // execute. (Calling createTextToImageStep twice would risk a different
      // seed defaulting, since the step creator fills seed via getRandomInt.)
      const stepForCostCheck = await createTextToImageStep({
        ...generateInput,
        user,
        whatIf: true,
      });
      const tags = buildWorkflowTags(claims, resolved.baseModel);
      const whatIfResult = await submitWorkflow({
        token,
        body: { steps: [stepForCostCheck], tags, currencies: BLOCK_CURRENCIES },
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
      // check above only bounds THIS submit; check the running per-(user,
      // app_block, UTC-day) total so a block can't drain the balance via many
      // sequential ≤budget submits. Reject (without spending) when this submit
      // would push the cumulative spend over the daily ceiling. The increment
      // happens AFTER a successful submit below — failed/blocked submits don't
      // consume the cap.
      const alreadySpent = await getBlockBuzzSpentInWindow(userId, claims.appBlockId);
      if (alreadySpent + cost > BLOCK_BUZZ_CAP_PER_DAY) {
        return {
          snapshot: {
            workflowId: 'failed',
            status: 'failed' as const,
            cost: { total: cost },
            error:
              `daily Buzz cap reached for this app: ${alreadySpent} already spent today, ` +
              `this generation costs ${cost}, daily cap is ${BLOCK_BUZZ_CAP_PER_DAY}`,
          },
        };
      }

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
      const autoClaim = await maybeAutoClaimDailyBoost({
        userId,
        cost,
        ip: ctx.ip,
      });

      const step = await createTextToImageStep({ ...generateInput, user });
      const submitted = await submitWorkflow({
        token,
        body: { steps: [step], tags, currencies: BLOCK_CURRENCIES },
      });
      const snapshot = snapshotFromWorkflow(submitted);

      // Record the spend against the cumulative daily cap. Only on a real
      // submit (this line is reached only after submitWorkflow resolved). Use
      // the whatif estimate as the charged amount — it's what the per-call
      // check used and what the orchestrator bills against. Fire-and-forget so
      // a Redis blip can't poison the user-facing response, but await-able for
      // tests; a missed increment fails OPEN (under-counts) which is the safe
      // direction for a spend CAP only in that it never over-rejects — the
      // per-call ceiling still bounds each individual submit.
      await recordBlockBuzzSpend(userId, claims.appBlockId, cost).catch(() => {
        /* swallow — see note above */
      });

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
    .input(z.object({ modelVersionId: z.number().int().positive() }))
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
      return getModelShowcaseImages(input.modelVersionId);
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
    .use(enforceAppBlocksFlag)
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
