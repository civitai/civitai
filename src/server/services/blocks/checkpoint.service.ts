import { TRPCError } from '@trpc/server';
import { dbRead } from '~/server/db/client';
import {
  blockSettingsSchemaByBlockId,
  blockUserSettingsSchema,
  type GenerateFromModelSettings,
} from '~/server/schema/blocks/settings.schema';
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
}): Promise<ValidatedCheckpoint> {
  const { blockInstanceId, modelId, modelVersionId, baseModel, modelType, userId } = opts;

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
  // parallel — they're independent reads.
  const [install, viewerRow] = await Promise.all([
    dbRead.modelBlockInstall.findUnique({
      where: { blockInstanceId },
      select: { settings: true },
    }),
    dbRead.blockUserSettings.findUnique({
      where: { blockInstanceId_userId: { blockInstanceId, userId } },
      select: { settings: true },
    }),
  ]);

  // 2. Viewer override: try first. Re-parse via the schema so a stored
  // value that no longer matches (e.g. schema tightened in a later release)
  // is treated as absent rather than crashing the resolve.
  const viewerSettings = blockUserSettingsSchema.safeParse(viewerRow?.settings ?? {});
  const viewerCheckpointId = viewerSettings.success
    ? viewerSettings.data.checkpoint_version_id
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
  const publisherSchema = blockSettingsSchemaByBlockId['generate-from-model'];
  const publisherSettings = publisherSchema.safeParse(install?.settings ?? {});
  const publisherCheckpointId = publisherSettings.success
    ? (publisherSettings.data as GenerateFromModelSettings).default_checkpoint_version_id
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

  // 4. No fallback. The install needs a checkpoint configured.
  throw new TRPCError({
    code: 'BAD_REQUEST',
    message:
      'This block install does not have a default checkpoint configured. ' +
      'Ask the model owner to set one in the block settings.',
  });
}
