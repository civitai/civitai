import { ModelStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';

import { BaseModel, BaseModelType, baseModelLicenses, constants } from '~/server/common/constants';
import { Context } from '~/server/createContext';
import { eventEngine } from '~/server/events';
import { GetByIdInput } from '~/server/schema/base.schema';
import {
  EarlyAccessModelVersionsOnTimeframeSchema,
  GetModelVersionSchema,
  ModelVersionMeta,
  ModelVersionUpsertInput,
  ModelVersionsGeneratedImagesOnTimeframeSchema,
  PublishVersionInput,
  RecommendedSettingsSchema,
} from '~/server/schema/model-version.schema';
import { DeclineReviewSchema, UnpublishModelSchema } from '~/server/schema/model.schema';
import { ModelFileModel } from '~/server/selectors/modelFile.selector';
import {
  addAdditionalLicensePermissions,
  deleteVersionById,
  earlyAccessModelVersionsOnTimeframe,
  getModelVersionRunStrategies,
  getVersionById,
  modelVersionGeneratedImagesOnTimeframe,
  publishModelVersionById,
  toggleNotifyModelVersion,
  unpublishModelVersionById,
  upsertModelVersion,
} from '~/server/services/model-version.service';
import { getModel, updateModelEarlyAccessDeadline } from '~/server/services/model.service';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { modelFileSelect } from '../selectors/modelFile.selector';
import { dbRead } from '../db/client';
import { getFilesByEntity } from '../services/file.service';
import { createFile } from '../services/model-file.service';
import { getStaticContent } from '~/server/services/content.service';

export const getModelVersionRunStrategiesHandler = ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return getModelVersionRunStrategies({ modelVersionId: id });
  } catch (e) {
    throw throwDbError(e);
  }
};

export type ModelVersionById = AsyncReturnType<typeof getModelVersionHandler>;
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
            nsfw: true,
            user: { select: { id: true } },
          },
        },
        files: withFiles ? { select: modelFileSelect } : false,
        posts: withFiles ? { select: { id: true } } : false,
        requireAuth: true,
        settings: true,
        recommendedResources: {
          select: {
            id: true,
            resource: {
              select: {
                id: true,
                name: true,
                trainedWords: true,
                baseModel: true,
                model: { select: { id: true, name: true, type: true } },
              },
            },
            settings: true,
          },
        },
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

    return {
      ...version,
      baseModel: version.baseModel as BaseModel,
      baseModelType: version.baseModelType as BaseModelType,
      files: version.files as unknown as Array<
        Omit<ModelFileModel, 'metadata'> & { metadata: FileMetadata }
      >,
      settings: version.settings as RecommendedSettingsSchema | undefined,
      recommendedResources: version.recommendedResources.map(({ resource, settings }) => ({
        id: resource.id,
        name: resource.name,
        baseModel: resource.baseModel,
        modelId: resource.model.id,
        modelName: resource.model.name,
        modelType: resource.model.type,
        trainedWords: resource.trainedWords,
        strength: (settings as any)?.strength,
      })),
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
  input: { bountyId, ...input },
  ctx,
}: {
  input: ModelVersionUpsertInput;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    const { id: userId } = ctx.user;

    if (input.trainingDetails === null) {
      input.trainingDetails = undefined;
    }
    const version = await upsertModelVersion({
      ...input,
      trainingDetails: input.trainingDetails,
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

      if (bountyId) {
        // Create model version files from the bounty.
        const awardedEntry = await dbRead.bountyEntry.findFirst({
          where: { bountyId, benefactors: { some: { userId } } },
          select: { id: true, bounty: true },
        });

        if (
          awardedEntry &&
          constants.bounties.supportedBountyToModels.some((t) => t === awardedEntry?.bounty.type)
        ) {
          const files = await getFilesByEntity({ id: awardedEntry.id, type: 'BountyEntry' });

          if (files.length) {
            await Promise.all(
              files.map((f) =>
                createFile({
                  modelVersionId: version.id,
                  sizeKB: f.sizeKB,
                  url: f.url,
                  type: 'Model',
                  metadata: {
                    ...f.metadata,
                    bountyId: awardedEntry.bounty.id,
                    bountyEntryId: awardedEntry.id,
                  },
                  userId: ctx.user.id,
                  name: f.name,
                  select: {
                    id: true,
                  },
                })
              )
            );
          }
        }
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
    const version = await getVersionById({ id: input.id, select: { meta: true, status: true } });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    const versionMeta = version.meta as ModelVersionMeta | null;
    const republishing =
      version.status !== ModelStatus.Draft && version.status !== ModelStatus.Scheduled;
    const { needsReview, unpublishedReason, unpublishedAt, customMessage, ...meta } =
      versionMeta || {};
    const updatedVersion = await publishModelVersionById({ ...input, meta, republishing });

    await updateModelEarlyAccessDeadline({ id: updatedVersion.modelId }).catch((e) => {
      console.error('Unable to update model early access deadline');
      console.error(e);
    });

    // Send event in background
    ctx.track
      .modelVersionEvent({
        type: 'Publish',
        modelId: updatedVersion.modelId,
        modelVersionId: updatedVersion.id,
        nsfw: updatedVersion.model.nsfw,
      })
      .catch(handleLogError);

    if (!input.publishedAt || input.publishedAt <= new Date()) {
      await eventEngine.processEngagement({
        userId: updatedVersion.model.userId,
        type: 'published',
        entityType: 'modelVersion',
        entityId: updatedVersion.id,
      });
    }

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

export const earlyAccessModelVersionsOnTimeframeHandler = async ({
  input,
  ctx,
}: {
  input: EarlyAccessModelVersionsOnTimeframeSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return earlyAccessModelVersionsOnTimeframe({
      ...input,
      userId: ctx.user.id,
    });
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

export const modelVersionGeneratedImagesOnTimeframeHandler = async ({
  input,
  ctx,
}: {
  input: ModelVersionsGeneratedImagesOnTimeframeSchema;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return modelVersionGeneratedImagesOnTimeframe({
      ...input,
      userId: ctx.user.id,
    });
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

// Only available for SD 1.5 and SDXL 1.0 models for now
export async function getVersionLicenseHandler({ input }: { input: GetByIdInput }) {
  try {
    const version = await getVersionById({
      id: input.id,
      select: {
        id: true,
        name: true,
        baseModel: true,
        status: true,
        model: {
          select: {
            id: true,
            name: true,
            status: true,
            allowCommercialUse: true,
            allowDerivatives: true,
            allowDifferentLicense: true,
            allowNoCredit: true,
            user: { select: { username: true } },
          },
        },
      },
    });
    if (!version || version.status !== 'Published' || version.model.status !== 'Published')
      throw throwNotFoundError(`No version with id ${input.id}`);

    if (!constants.supportedBaseModelAddendums.includes(version.baseModel as 'SD 1.5' | 'SDXL 1.0'))
      return throwBadRequestError('License not available for this model');

    const hasAdditionalPermissions =
      !version.model.allowCommercialUse.length ||
      version.model.allowCommercialUse.some((permission) =>
        ['None', 'Image', 'RentCivit', 'Rent', 'Sell'].includes(permission)
      ) ||
      !version.model.allowNoCredit ||
      !version.model.allowDerivatives ||
      version.model.allowDifferentLicense;

    if (!hasAdditionalPermissions) throw throwBadRequestError('No additional permissions');

    const licenseSlug = baseModelLicenses[version.baseModel as BaseModel]?.name ?? '';
    const license = await getStaticContent({ slug: ['licenses', licenseSlug] });

    license.content = addAdditionalLicensePermissions(license.content, {
      modelId: version.model.id,
      modelName: version.model.name,
      versionId: version.id,
      username: version.model.user.username,
      allowCommercialUse: version.model.allowCommercialUse,
      allowNoCredit: version.model.allowNoCredit,
      allowDerivatives: version.model.allowDerivatives,
      allowDifferentLicense: version.model.allowDifferentLicense,
    });

    return { ...version, license };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
}
