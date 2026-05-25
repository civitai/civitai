import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { getOrchestratorToken } from '~/server/orchestrator/get-orchestrator-token';
import { parseSubjectUserId, verifyBlockToken } from '~/server/middleware/block-scope.middleware';
import {
  blockSettingsSchemaByBlockId,
  blockUserSettingsSchema,
} from '~/server/schema/blocks/settings.schema';
import {
  listAvailableSchema,
  subscriptionScopeSchema,
} from '~/server/schema/blocks/subscription.schema';
import { blockWorkflowBodySchema } from '~/server/schema/blocks/workflow.schema';
import { isAppBlocksEnabled } from '~/server/services/app-blocks-flag';
import { BlockRegistry } from '~/server/services/block-registry.service';
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
   * deleteSubscription instead. Settings are validated through the
   * per-block-id schema map (same path installOnModel uses) so the
   * subscription row carries the same shape as a per-model install.
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
      // Resolve the appBlock once for both status check and per-block-id
      // settings validation.
      const block = await dbRead.appBlock.findUnique({
        where: { id: input.appBlockId },
        select: { blockId: true, status: true },
      });
      if (!block) throw throwNotFoundError('App block not found');
      if (block.status !== 'approved') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'App block is not approved' });
      }
      // Per-block-id schema validation. Unknown blocks (third-party future)
      // fall back to the generic record — the router-level settingsSchema
      // already enforced the 4KB cap.
      const settingsSchemaForBlock = blockSettingsSchemaByBlockId[block.blockId];
      const validatedSettings = settingsSchemaForBlock
        ? (settingsSchemaForBlock.parse(input.settings) as Record<string, unknown>)
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

      const step = await createTextToImageStep({ ...generateInput, user });
      const submitted = await submitWorkflow({
        token,
        body: { steps: [step], tags, currencies: BLOCK_CURRENCIES },
      });
      return { snapshot: snapshotFromWorkflow(submitted) };
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
        settings: blockUserSettingsSchema,
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

      // Re-validate the checkpoint when set. Skip when explicitly clearing
      // (`null`) — that's just removing the override row's value.
      if (typeof input.settings.checkpoint_version_id === 'number') {
        const baseModel = await getRepresentativeBaseModel(ctxModelId);
        if (!baseModel) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'cannot determine base model for the bound install',
          });
        }
        await validateBlockCheckpoint({
          checkpointVersionId: input.settings.checkpoint_version_id,
          forBaseModel: baseModel,
          reason: 'viewer-override',
        });
      }

      await BlockRegistry.upsertUserSettings({
        blockInstanceId: claims.blockInstanceId,
        userId,
        settings: input.settings,
      });
      return { ok: true };
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
