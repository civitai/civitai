import { ModelStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { BaseModel, BaseModelType } from '~/server/common/constants';

import { Context } from '~/server/createContext';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  GetModelVersionSchema,
  ModelVersionMeta,
  ModelVersionUpsertInput,
  PublishVersionInput,
} from '~/server/schema/model-version.schema';
import { DeclineReviewSchema, ModelMeta, UnpublishModelSchema } from '~/server/schema/model.schema';
import {
  deleteVersionById,
  getModelVersionRunStrategies,
  getVersionById,
  publishModelVersionById,
  toggleNotifyModelVersion,
  unpublishModelVersionById,
  upsertModelVersion,
} from '~/server/services/model-version.service';
import { getModel, updateModelEarlyAccessDeadline } from '~/server/services/model.service';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';

export const getModelVersionRunStrategiesHandler = ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return getModelVersionRunStrategies({ modelVersionId: id });
  } catch (e) {
    throw throwDbError(e);
  }
};

export const getModelVersionHandler = async ({ input }: { input: GetModelVersionSchema }) => {
  const { id, withFiles } = input;

  try {
    const version = await getVersionById({
      id,
      select: {
        id: true,
        name: true,
        description: true,
        baseModel: true,
        baseModelType: true,
        earlyAccessTimeFrame: true,
        trainedWords: true,
        epochs: true,
        steps: true,
        clipSkip: true,
        status: true,
        createdAt: true,
        vaeId: true,
        model: {
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            publishedAt: true,
            user: { select: { id: true } },
          },
        },
        files: withFiles
          ? {
              select: {
                name: true,
                id: true,
                sizeKB: true,
                type: true,
                metadata: true,
                pickleScanResult: true,
                pickleScanMessage: true,
                virusScanResult: true,
                scannedAt: true,
                visibility: true,
                hashes: {
                  select: {
                    type: true,
                    hash: true,
                  },
                },
              },
            }
          : false,
        posts: withFiles ? { select: { id: true } } : false,
        monetization: {
          select: {
            id: true,
            type: true,
            unitAmount: true,
            currency: true,
            sponsorshipSettings: {
              select: {
                id: true,
                unitAmount: true,
                type: true,
                currency: true,
              },
            },
          },
        },
      },
    });
    if (!version) throw throwNotFoundError(`No version with id ${input.id}`);
    console.log(version.monetization?.unitAmount);

    return {
      ...version,
      baseModel: version.baseModel as BaseModel,
      baseModelType: version.baseModelType as BaseModelType,
      files: version.files as Array<
        Omit<(typeof version.files)[number], 'metadata'> & { metadata: FileMetadata }
      >,
    };
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    else throw throwDbError(e);
  }
};

export const toggleNotifyEarlyAccessHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;
    const version = await getVersionById({ ...input, select: { id: true } });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    return toggleNotifyModelVersion({ ...input, userId });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const upsertModelVersionHandler = async ({
  input,
  ctx,
}: {
  input: ModelVersionUpsertInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const version = await upsertModelVersion({
      ...input,
      trainingDetails: input.trainingDetails as any,
    });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    // Just update early access deadline if updating the model version
    if (input.id)
      await updateModelEarlyAccessDeadline({ id: version.modelId }).catch((e) => {
        console.error('Unable to update model early access deadline');
        console.error(e);
      });

    if (!input.id) {
      const model = await getModel({
        id: version.modelId,
        select: {
          nsfw: true,
        },
      });

      if (model) {
        ctx.track.modelVersionEvent({
          type: 'Create',
          modelId: version.modelId,
          modelVersionId: version.id,
          nsfw: model.nsfw,
        });
      }
    }

    return version;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const deleteModelVersionHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const version = await deleteVersionById(input);
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    await updateModelEarlyAccessDeadline({ id: version.modelId }).catch((e) => {
      console.error('Unable to update model early access deadline');
      console.error(e);
    });

    return version;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const publishModelVersionHandler = async ({
  input,
  ctx,
}: {
  input: PublishVersionInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const version = await getVersionById({ id: input.id, select: { meta: true } });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    const { needsReview, unpublishedReason, unpublishedAt, customMessage, ...meta } =
      (version.meta as ModelMeta | null) || {};
    const updatedVersion = await publishModelVersionById({ ...input, meta });

    await updateModelEarlyAccessDeadline({ id: updatedVersion.modelId }).catch((e) => {
      console.error('Unable to update model early access deadline');
      console.error(e);
    });

    // Send event in background
    ctx.track.modelVersionEvent({
      type: 'Publish',
      modelId: updatedVersion.modelId,
      modelVersionId: updatedVersion.id,
      nsfw: updatedVersion.model.nsfw,
    });

    return updatedVersion;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const unpublishModelVersionHandler = async ({
  input,
  ctx,
}: {
  input: UnpublishModelSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id } = input;
    const modelVersion = await getVersionById({ id, select: { meta: true } });
    if (!modelVersion) throw throwNotFoundError(`No model version with id ${input.id}`);

    const meta = (modelVersion.meta as ModelVersionMeta | null) || {};
    const updatedVersion = await unpublishModelVersionById({ ...input, meta, user: ctx.user });

    // Send event in background
    ctx.track.modelVersionEvent({
      type: 'Unpublish',
      modelVersionId: id,
      modelId: updatedVersion.model.id,
      nsfw: updatedVersion.model.nsfw,
    });

    return updatedVersion;
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throwDbError(error);
  }
};

export const requestReviewHandler = async ({ input }: { input: GetByIdInput }) => {
  try {
    const version = await getVersionById({
      id: input.id,
      select: {
        id: true,
        name: true,
        status: true,
        meta: true,
        modelId: true,
        baseModel: true,
        trainedWords: true,
      },
    });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);
    if (version.status !== ModelStatus.UnpublishedViolation)
      throw throwBadRequestError(
        'Cannot request a review for this version because it is not in the correct status'
      );

    const meta = (version.meta as ModelVersionMeta | null) || {};
    const updatedModel = await upsertModelVersion({
      ...version,
      baseModel: version.baseModel as BaseModel,
      meta: { ...meta, needsReview: true },
    });

    return updatedModel;
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

export const declineReviewHandler = async ({
  input,
  ctx,
}: {
  input: DeclineReviewSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    if (!ctx.user.isModerator) throw throwAuthorizationError();

    const version = await getVersionById({
      id: input.id,
      select: {
        id: true,
        name: true,
        status: true,
        meta: true,
        modelId: true,
        baseModel: true,
        trainedWords: true,
      },
    });
    if (!version) throw throwNotFoundError(`No version with id ${input.id}`);

    const meta = (version.meta as ModelVersionMeta | null) || {};
    if (version.status !== ModelStatus.UnpublishedViolation && !meta?.needsReview)
      throw throwBadRequestError(
        'Cannot decline a review for this version because it is not in the correct status'
      );

    const updatedModel = await upsertModelVersion({
      ...version,
      baseModel: version.baseModel as BaseModel,
      meta: {
        ...meta,
        declinedReason: input.reason,
        decliendAt: new Date().toISOString(),
        needsReview: false,
      },
    });
    await trackModActivity(ctx.user.id, {
      entityType: 'modelVersion',
      entityId: version.id,
      activity: 'review',
    });

    return updatedModel;
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};
