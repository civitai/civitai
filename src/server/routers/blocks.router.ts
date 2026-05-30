import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { parseSubjectUserId, verifyBlockToken } from '~/server/middleware/block-scope.middleware';
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
import { getWorkflow, submitWorkflow } from '~/server/services/orchestrator/workflows';
import { createTextToImageStep } from '~/server/services/orchestrator/textToImage/textToImage';
import { getUserById } from '~/server/services/user.service';
import { guardedProcedure, middleware, publicProcedure, router } from '~/server/trpc';
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
  // updateSettings is publisher-only and only ever operates on real install
  // rows. Synthetic ids (pdb_*, bus_*) don't have settings writable via this
  // route — subscription settings use blocks.upsertSubscription, platform
  // defaults aren't settings-writable at all. A synthetic id reaching this
  // path is a client bug; the findUnique below returns null and we 404.
  const row = await dbWrite.modelBlockInstall.findUnique({
    where: { blockInstanceId },
    select: { modelId: true },
  });
  if (!row) throw throwNotFoundError('Block install not found');
  return row.modelId;
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
      return BlockRegistry.listForModel({
        ...input,
        viewerUserId: ctx.user?.id ?? null,
      });
    }),

  installOnModel: guardedProcedure
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

  updateSettings: guardedProcedure
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
  toggleEnabled: guardedProcedure
    .use(enforceAppBlocksFlag)
    .input(
      z.object({
        blockInstanceId: z.string().min(1).max(64),
        enabled: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const row = await dbWrite.modelBlockInstall.findUnique({
        where: { blockInstanceId: input.blockInstanceId },
        select: { modelId: true, appBlockId: true, slotId: true },
      });
      if (!row) throw throwNotFoundError('Block install not found');
      await assertCanManageBlocks(ctx, row.modelId);
      await BlockRegistry.toggleEnabled({
        modelId: row.modelId,
        appBlockId: row.appBlockId,
        slotId: row.slotId,
        enabled: input.enabled,
      });
      return { ok: true };
    }),

  /**
   * Removes the install row entirely. Different from toggleEnabled(false):
   * uninstall re-enables platform defaults for this (model, slot) pair;
   * toggleEnabled(false) keeps the opt-out row in place.
   */
  uninstallFromModel: guardedProcedure
    .use(enforceAppBlocksFlag)
    .input(z.object({ blockInstanceId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const row = await dbWrite.modelBlockInstall.findUnique({
        where: { blockInstanceId: input.blockInstanceId },
        select: { modelId: true, appBlockId: true, slotId: true },
      });
      if (!row) throw throwNotFoundError('Block install not found');
      await assertCanManageBlocks(ctx, row.modelId);
      await BlockRegistry.uninstallFromModel({
        modelId: row.modelId,
        appBlockId: row.appBlockId,
        slotId: row.slotId,
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
  submitVersion: guardedProcedure
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
  withdrawPublishRequest: guardedProcedure
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
  getMyPendingForSlug: guardedProcedure
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
  listPendingRequests: guardedProcedure
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
  listApprovedRequests: guardedProcedure
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
  listRejectedRequests: guardedProcedure
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
  approveRequest: guardedProcedure
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
  backfillPublishRequest: guardedProcedure
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
  rejectRequest: guardedProcedure
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
  listMyPublishRequests: guardedProcedure
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
              _count: { select: { modelInstalls: true, userSubscriptions: true } },
            },
          },
        },
      });
      // Flatten _count onto each row so the UI doesn't have to dig through
      // the relation. Pending-first-version + withdrawn-first-version rows
      // have no appBlock (FK is set on approve) — surface null so the UI
      // can render "—".
      type RowWithCount = (typeof rows)[number];
      return rows.map((r: RowWithCount) => {
        const counts = r.appBlock?._count;
        const { appBlock: _drop, ...rest } = r;
        return {
          ...rest,
          modelInstallCount: counts?.modelInstalls ?? null,
          userSubscriptionCount: counts?.userSubscriptions ?? null,
        };
      });
    }),

  /**
   * W5 v0 — reflection surface for /apps/installed. One row per app the
   * current user has either installed on a model OR subscribed to. Counts
   * + scope intersections derived from existing tables (no grant schema
   * yet — that's W5 v1). See user-app-surface.service.ts for shape.
   */
  listMyScopeGrants: guardedProcedure
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
  listMyAppActivity: guardedProcedure
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
   * Lists every user-subscription row (both scopes) for the current viewer.
   * Used by the management UI at /apps/installed. The app_block row is
   * denormalised onto each subscription so the UI can render block name,
   * icon, and target slot without a second round-trip.
   */
  listMySubscriptions: guardedProcedure
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
  upsertSubscription: guardedProcedure
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
  deleteSubscription: guardedProcedure
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
      const token = await getOrchestratorToken(userId, ctx);
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
            workflowId: '',
            status: 'failed' as const,
            cost: { total: cost },
            error: `insufficient buzz budget: estimate ${cost} exceeds budget ${claims.buzzBudget}`,
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
    .query(({ input }) => getModelShowcaseImages(input.modelVersionId)),

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
      const userId = ctx.user?.id ?? null;
      const checkpoint = await BlockRegistry.getEffectiveCheckpoint({
        blockInstanceId: input.blockInstanceId,
        modelId: input.modelId,
        slotId: input.slotId,
        userId,
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
      return { ok: true };
    }),

  /**
   * Publisher revenue summary. Caller must be the app owner — the
   * service filters by `app_owner_user_id` so even if the request
   * carries a different appBlockId, the rows are scoped to the caller.
   * Auth check is enforced by guardedProcedure; no need to also assert
   * ownership of the requested appBlockId (the join filter does it).
   */
  getMyRevenue: guardedProcedure
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
  getMyApps: guardedProcedure
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
