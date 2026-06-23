import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { BlockRegistry } from '~/server/services/block-registry.service';
import { getBaseModelsByGroup } from '~/shared/constants/basemodel.constants';
import { getBaseModelSetType } from '~/shared/constants/generation.constants';

/**
 * The shape we want both the publisher install path and the viewer override
 * path to share. UI consumers parse `cause.reason` to render inline form
 * errors rather than a generic "Bad Request" toast.
 */
export type CheckpointValidationReason =
  | 'not-found'
  | 'not-published'
  | 'not-a-checkpoint'
  | 'wrong-ecosystem';

export interface ValidatedCheckpoint {
  versionId: number;
  modelId: number;
  baseModel: string;
  modelName: string;
  versionName: string;
}

/**
 * Validate a checkpoint pick against the LoRA (or Checkpoint) it'll anchor.
 * Returns the resolved fields needed for BLOCK_INIT.context.checkpoint;
 * throws TRPCError(BAD_REQUEST) with a `cause.reason` discriminator on any
 * failure mode so callers can surface specific UI messages.
 *
 * Called from three places:
 *   1. `blocks.installOnModel` / `updateSettings` at publisher write-time
 *   2. `blocks.updateUserSettings` at viewer write-time
 *   3. `resolveBlockCheckpoint` at submit-time (defends against the
 *      checkpoint being unpublished between selection and use)
 *
 * `forBaseModel` is the bound model's baseModel string (e.g. 'Flux.1 D' for
 * a Flux LoRA). The ecosystem match collapses both sides through
 * `getBaseModelSetType` so 'Flux.1 D' and 'Flux.1 S' are treated as same
 * family — matching the platform-wide grouping.
 */
export async function validateBlockCheckpoint(opts: {
  checkpointVersionId: number;
  forBaseModel: string;
  reason: 'publisher-default' | 'viewer-override' | 'resolve-submit';
}): Promise<ValidatedCheckpoint> {
  const { checkpointVersionId, forBaseModel } = opts;

  const version = await dbRead.modelVersion.findUnique({
    where: { id: checkpointVersionId },
    select: {
      id: true,
      name: true,
      baseModel: true,
      status: true,
      modelId: true,
      model: { select: { id: true, name: true, type: true } },
    },
  });

  if (!version) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Checkpoint version ${checkpointVersionId} not found`,
      cause: { reason: 'not-found' satisfies CheckpointValidationReason },
    });
  }
  if (version.status !== 'Published') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Checkpoint "${version.model.name}" is not published`,
      cause: { reason: 'not-published' satisfies CheckpointValidationReason },
    });
  }
  if (version.model.type !== 'Checkpoint') {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `"${version.model.name}" is a ${version.model.type}, not a Checkpoint`,
      cause: { reason: 'not-a-checkpoint' satisfies CheckpointValidationReason },
    });
  }
  // Group-level comparison rather than exact baseModel string match — within
  // a family (e.g. Flux1) different baseModel strings like 'Flux.1 D' and
  // 'Flux.1 S' need to be interoperable.
  const targetFamily = getBaseModelSetType(forBaseModel);
  const checkpointFamily = getBaseModelSetType(version.baseModel);
  if (targetFamily !== checkpointFamily) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message:
        `Checkpoint "${version.model.name}" (${version.baseModel}) is not compatible ` +
        `with this model's base family (${forBaseModel})`,
      cause: { reason: 'wrong-ecosystem' satisfies CheckpointValidationReason },
    });
  }

  return {
    versionId: version.id,
    modelId: version.modelId,
    baseModel: version.baseModel,
    modelName: version.model.name,
    versionName: version.name,
  };
}

/**
 * Resolves the bound model's representative baseModel — needed by callers
 * that have `modelId` but not the LoRA's version (e.g. `installOnModel`,
 * which doesn't store `modelVersionId` for every install). Picks the most
 * recent Published version, falling back to any version if none are
 * Published yet (publisher just created the model).
 */
export async function getRepresentativeBaseModel(modelId: number): Promise<string | null> {
  const version = await dbRead.modelVersion.findFirst({
    where: { modelId, status: 'Published' },
    orderBy: { createdAt: 'desc' },
    select: { baseModel: true },
  });
  if (version) return version.baseModel;
  const any = await dbRead.modelVersion.findFirst({
    where: { modelId },
    orderBy: { createdAt: 'desc' },
    select: { baseModel: true },
  });
  return any?.baseModel ?? null;
}

const POPULAR_CHECKPOINT_TTL_SECONDS = 60 * 60; // 1h

/**
 * Resolve the most-popular Checkpoint Model in the given ecosystem family.
 * Used as the platform-wide fallback when neither the viewer nor publisher
 * has configured a checkpoint for a LoRA install — so a fresh demo install
 * Just Works without manual configuration.
 *
 * "Most popular" = highest `ModelMetric.thumbsUpCount` among published
 * Checkpoint models that have at least one Published version in the
 * ecosystem. Picks the latest Published version of that Model as the
 * actual anchor.
 *
 * Cached in Redis for 1h. The result is small (one JSON object), and
 * popularity changes on rolling-window scales — paying for a multi-join
 * query on every block submit isn't worth it. Cache invalidation is
 * passive: a hot top-Checkpoint will refresh in ≤1h.
 *
 * Returns `null` only when the ecosystem has no Published Checkpoints —
 * the caller surfaces that as BAD_REQUEST.
 */
export async function getPopularCheckpointForEcosystem(
  baseModel: string
): Promise<ValidatedCheckpoint | null> {
  const ecosystemKey = getBaseModelSetType(baseModel);
  const baseModelsInFamily = getBaseModelsByGroup(ecosystemKey);
  if (baseModelsInFamily.length === 0) return null;

  const cacheKey: `${typeof REDIS_KEYS.BLOCKS.POPULAR_CHECKPOINT}:${string}` = `${REDIS_KEYS.BLOCKS.POPULAR_CHECKPOINT}:${ecosystemKey}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      // Cached value is a ValidatedCheckpoint JSON. Parse failure on a
      // schema migration → treat as miss, repopulate below.
      try {
        return JSON.parse(cached) as ValidatedCheckpoint;
      } catch {
        // fall through to recompute
      }
    }
  } catch {
    // Redis unreachable — fall through to direct DB. Don't fail closed
    // on a cache outage; the DB query is the source of truth anyway.
  }

  // Pick the top Checkpoint by thumbsUpCount among Models with at least
  // one Published version in the ecosystem family. Start the query from
  // ModelMetric so we can orderBy the scalar directly — Prisma can't
  // orderBy through a 1:many relation (Model.metrics is declared as
  // ModelMetric[], though @@id([modelId]) makes it 1:1 in practice).
  // ModelMetric carries its own `status` mirror of the model so we can
  // filter Published without a join just for that.
  const topMetric = await dbRead.modelMetric.findFirst({
    where: {
      status: 'Published',
      model: {
        type: 'Checkpoint',
        deletedAt: null,
        modelVersions: {
          some: {
            status: 'Published',
            baseModel: { in: baseModelsInFamily },
          },
        },
      },
    },
    orderBy: { thumbsUpCount: 'desc' },
    select: {
      modelId: true,
      model: {
        select: {
          id: true,
          name: true,
          modelVersions: {
            where: {
              status: 'Published',
              baseModel: { in: baseModelsInFamily },
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, name: true, baseModel: true },
          },
        },
      },
    },
  });
  const topModel = topMetric?.model;
  const topVersion = topModel?.modelVersions?.[0];
  if (!topModel || !topVersion) return null;

  const resolved: ValidatedCheckpoint = {
    versionId: topVersion.id,
    modelId: topModel.id,
    baseModel: topVersion.baseModel,
    modelName: topModel.name,
    versionName: topVersion.name,
  };
  try {
    await redis.set(cacheKey, JSON.stringify(resolved), { EX: POPULAR_CHECKPOINT_TTL_SECONDS });
  } catch {
    // fail open — next call recomputes
  }
  return resolved;
}

/**
 * Resolve the effective checkpoint for a single workflow submission.
 *
 * Precedence chain — fail-closed at the end (no platform fallback):
 *   1. The bound model is a Checkpoint → it's its own anchor. Return
 *      immediately, skip override path entirely (matches the v1 product
 *      decision to keep Checkpoint installs atomic).
 *   2. Viewer override from block_user_settings, if set and still passes
 *      validation. A previously-valid override that no longer validates
 *      (checkpoint unpublished, removed from ecosystem) is dropped — fall
 *      through to publisher default rather than throw, so the user isn't
 *      blocked by something they can't fix.
 *   3. Publisher default from model_block_installs.settings, if set and
 *      still passes validation. Same drop-on-invalid behavior.
 *   4. Throw BAD_REQUEST with a clear "ask the model owner" message. No
 *      platform-wide checkpoint table — the install is misconfigured and
 *      the product decision is to surface that to the publisher, not
 *      paper over it with a default that may not even match the LoRA's
 *      ecosystem.
 *
 * Re-validation at submit time (vs. trusting write-time validation only)
 * defends against the checkpoint being unpublished or moved out of the
 * ecosystem between selection and the next generate.
 */
export async function resolveBlockCheckpoint(opts: {
  blockInstanceId: string;
  modelId: number;
  modelVersionId: number;
  baseModel: string;
  modelType: string;
  userId: number;
  /**
   * Slot id from the JWT ctx. Required so the resolver can re-validate
   * synthetic ids (pdb_*, bus_*) — the source row carries publisher
   * settings (e.g. default_checkpoint_version_id) that we still need to
   * read through the publisher-default path below.
   */
  slotId: string;
}): Promise<ValidatedCheckpoint> {
  const { blockInstanceId, modelId, modelVersionId, baseModel, modelType, userId, slotId } = opts;

  // 1. Checkpoint-bound install → the model IS the anchor.
  if (modelType === 'Checkpoint') {
    return {
      versionId: modelVersionId,
      modelId,
      baseModel,
      // Names omitted here: the caller doesn't display them for the
      // Checkpoint-self case (the model header already shows the name).
      modelName: '',
      versionName: '',
    };
  }

  // Pull both the publisher install settings and the viewer override row in
  // parallel — they're independent reads. The publisher path goes through
  // BlockRegistry.resolveBlockInstance so synthetic blockInstanceIds
  // (subscriptions, platform defaults) read their settings from the source
  // row rather than 404-ing on the missing model_block_installs row.
  const [install, viewerRow] = await Promise.all([
    BlockRegistry.resolveBlockInstance({
      blockInstanceId,
      modelId,
      slotId,
      viewerUserId: userId,
      db: 'read',
    }),
    dbRead.blockUserSettings.findUnique({
      where: { blockInstanceId_userId: { blockInstanceId, userId } },
      select: { settings: true },
    }),
  ]);

  // 2. Viewer override: try first. W3 v0 — settings keys are validated
  // against the app's manifest at write-time, so reading the raw value
  // with a typeof guard here is sufficient. A stored value that no
  // longer matches (manifest tightened in a later release) is treated as
  // absent rather than crashing the resolve.
  const viewerRaw = (viewerRow?.settings ?? {}) as { checkpoint_version_id?: unknown };
  const viewerCheckpointId =
    typeof viewerRaw.checkpoint_version_id === 'number'
      ? viewerRaw.checkpoint_version_id
      : undefined;
  if (typeof viewerCheckpointId === 'number') {
    try {
      return await validateBlockCheckpoint({
        checkpointVersionId: viewerCheckpointId,
        forBaseModel: baseModel,
        reason: 'viewer-override',
      });
    } catch {
      // Drop the invalid override and fall through to publisher default.
      // The user can re-pick from the UI — no point hard-failing on a
      // stale row they didn't know was broken.
    }
  }

  // 3. Publisher default.
  const publisherRaw = (install?.settings ?? {}) as { default_checkpoint_version_id?: unknown };
  const publisherCheckpointId =
    typeof publisherRaw.default_checkpoint_version_id === 'number'
      ? publisherRaw.default_checkpoint_version_id
      : undefined;
  if (typeof publisherCheckpointId === 'number') {
    try {
      return await validateBlockCheckpoint({
        checkpointVersionId: publisherCheckpointId,
        forBaseModel: baseModel,
        reason: 'resolve-submit',
      });
    } catch (err) {
      // Publisher default broke after install — surface this rather than
      // fall through to BAD_REQUEST below, so the error message can name
      // the actual reason. Re-throw with publisher-default reason.
      throw err;
    }
  }

  // 4. Platform per-ecosystem fallback: most-popular Checkpoint in the
  // LoRA's family. Makes the demo work without manual install
  // configuration; publishers can still pin a specific Checkpoint via
  // settings.default_checkpoint_version_id if they want a different one.
  const popular = await getPopularCheckpointForEcosystem(baseModel);
  if (popular) return popular;

  // 5. Ecosystem has no published Checkpoints at all (e.g. a brand-new
  // base model with only LoRAs). Surface as BAD_REQUEST — the block
  // can't generate without an anchor and there's nothing on-platform to
  // fall back to.
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      'This block install has no checkpoint configured and the platform ' +
      'has no popular checkpoint in this ecosystem yet. Ask the model ' +
      'owner to set one in the block settings.',
  });
}
