import { TRPCError } from '@trpc/server';
import { BaseModel, baseModelLicenses, BaseModelType, constants } from '~/server/common/constants';
import { Context } from '~/server/createContext';
import { eventEngine } from '~/server/events';
import { dataForModelsCache } from '~/server/redis/caches';
import { GetByIdInput } from '~/server/schema/base.schema';
import { TrainingResultsV2 } from '~/server/schema/model-file.schema';
import {
  EarlyAccessModelVersionsOnTimeframeSchema,
  GetModelVersionSchema,
  ModelVersionEarlyAccessConfig,
  ModelVersionEarlyAccessPurchase,
  ModelVersionMeta,
  ModelVersionsGeneratedImagesOnTimeframeSchema,
  ModelVersionUpsertInput,
  PublishVersionInput,
  QueryModelVersionSchema,
  RecommendedSettingsSchema,
  TrainingDetailsObj,
} from '~/server/schema/model-version.schema';
import { DeclineReviewSchema, UnpublishModelSchema } from '~/server/schema/model.schema';
import { ModelFileModel } from '~/server/selectors/modelFile.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getStaticContent } from '~/server/services/content.service';
import { getUnavailableResources } from '~/server/services/generation/generation.service';
import {
  addAdditionalLicensePermissions,
  deleteVersionById,
  earlyAccessModelVersionsOnTimeframe,
  earlyAccessPurchase,
  getModelVersionRunStrategies,
  getUserEarlyAccessModelVersions,
  getVersionById,
  modelVersionDonationGoals,
  modelVersionGeneratedImagesOnTimeframe,
  publishModelVersionById,
  queryModelVersions,
  toggleNotifyModelVersion,
  unpublishModelVersionById,
  upsertModelVersion,
} from '~/server/services/model-version.service';
import { getModel, updateModelEarlyAccessDeadline } from '~/server/services/model.service';
import { trackModActivity } from '~/server/services/moderator.service';
import {
  getMaxEarlyAccessDays,
  getMaxEarlyAccessModels,
} from '~/server/utils/early-access-helpers';
import {
  handleLogError,
  throwAuthorizationError,
  throwBadRequestError,
  throwDbError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import { ModelStatus, ModelUsageControl } from '~/shared/utils/prisma/enums';
import { removeNulls } from '~/utils/object-helpers';
import { dbRead } from '../db/client';
import { modelFileSelect } from '../selectors/modelFile.selector';
import { getFilesByEntity } from '../services/file.service';
import { createFile } from '../services/model-file.service';
import { getResourceData } from './../services/generation/generation.service';

export const getModelVersionRunStrategiesHandler = ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return getModelVersionRunStrategies({ modelVersionId: id });
  } catch (e) {
    throw throwDbError(e);
  }
};

export type ModelVersionById = AsyncReturnType<typeof getModelVersionHandler>;
export const getModelVersionHandler = async ({
  input,
  ctx,
}: {
  input: GetModelVersionSchema;
  ctx: Context;
}) => {
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
        earlyAccessConfig: true,
        earlyAccessEndsAt: true,
        trainedWords: true,
        epochs: true,
        steps: true,
        clipSkip: true,
        status: true,
        createdAt: true,
        vaeId: true,
        trainingDetails: true,
        trainingStatus: true,
        uploadType: true,
        usageControl: true,
        model: {
          select: {
            id: true,
            name: true,
            type: true,
            status: true,
            publishedAt: true,
            nsfw: true,
            uploadType: true,
            user: { select: { id: true } },
          },
        },
        files: withFiles ? { select: modelFileSelect } : false,
        posts: withFiles ? { select: { id: true, userId: true } } : false,
        requireAuth: true,
        settings: true,
        recommendedResources: {
          select: {
            id: true,
            resource: {
              select: {
                id: true,
                // name: true,
                // trainedWords: true,
                // baseModel: true,
                // model: { select: { id: true, name: true, type: true } },
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
        generationCoverage: { select: { covered: true } },
      },
    });

    const recommendedResourceIds = version?.recommendedResources.map((x) => x.id) ?? [];
    const generationResources = await getResourceData({
      ids: recommendedResourceIds,
      user: ctx?.user,
    }).then((data) =>
      data.map((item) => {
        const settings = (version?.recommendedResources.find((x) => x.resource.id === item.id)
          ?.settings ?? {}) as RecommendedSettingsSchema;
        return { ...item, ...removeNulls(settings) };
      })
    );

    if (!version) throw throwNotFoundError(`No version with id ${input.id}`);

    const unavailableGenResources = await getUnavailableResources();
    const canGenerate =
      !!version.generationCoverage?.covered && !unavailableGenResources.includes(version.id);

    return {
      ...version,
      canGenerate,
      earlyAccessConfig: version.earlyAccessConfig as ModelVersionEarlyAccessConfig | null,
      baseModel: version.baseModel as BaseModel,
      baseModelType: version.baseModelType as BaseModelType,
      trainingDetails: version.trainingDetails as TrainingDetailsObj | undefined,
      files: version.files as unknown as Array<
        Omit<ModelFileModel, 'metadata'> & { metadata: FileMetadata }
      >,
      settings: version.settings as RecommendedSettingsSchema | undefined,
      recommendedResources: generationResources,
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

    if (!ctx.features.generationOnlyModels && input.usageControl !== ModelUsageControl.Download) {
      // People without access to thje generationOnlyModels feature can only create download models
      input.usageControl = ModelUsageControl.Download;
    }

    if (input.usageControl === ModelUsageControl.InternalGeneration && !ctx.user.isModerator) {
      throw throwBadRequestError('Only moderators can manage internal generation models');
    }

    if (input.trainingDetails === null) {
      input.trainingDetails = undefined;
    }

    if (!!input.earlyAccessConfig?.timeframe) {
      const maxDays = getMaxEarlyAccessDays({ userMeta: ctx.user.meta });

      if (!ctx.user.isModerator && input.earlyAccessConfig?.timeframe > maxDays) {
        throw throwBadRequestError('Early access days exceeds user limit');
      }
    }

    if (input?.earlyAccessConfig?.timeframe) {
      // Confirm the user doesn't have any other early access models that are still active.
      const activeEarlyAccess = await getUserEarlyAccessModelVersions({ userId: ctx.user.id });

      if (
        !ctx.user.isModerator &&
        activeEarlyAccess.length >= getMaxEarlyAccessModels({ userMeta: ctx.user.meta }) &&
        (!input.id || !activeEarlyAccess.some((v) => v.id === input.id))
      ) {
        throw throwBadRequestError(
          'Sorry, you have exceeded the maximum number of early access models you can have at the time.'
        );
      }
    }

    if (
      input?.usageControl !== ModelUsageControl.Download &&
      input?.earlyAccessConfig?.chargeForDownload
    ) {
      throw throwBadRequestError(
        'Cannot charge for download if downloads are disabled for this model version'
      );
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

    await dataForModelsCache.bust(version.modelId);

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

    await dataForModelsCache.bust(version.modelId);

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
    const version = await getVersionById({
      id: input.id,
      select: {
        meta: true,
        status: true,
        modelId: true,
        earlyAccessConfig: true,
        model: { select: { userId: true } },
      },
    });

    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    const versionMeta = version.meta as ModelVersionMeta | null;
    const republishing =
      version.status !== ModelStatus.Draft && version.status !== ModelStatus.Scheduled;
    const { needsReview, unpublishedReason, unpublishedAt, customMessage, ...meta } =
      versionMeta || {};
    const updatedVersion = await publishModelVersionById({
      ...input,
      meta,
      republishing,
    });

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

    await dataForModelsCache.bust(version.modelId);

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
    const version = await getVersionById({ id, select: { meta: true, modelId: true } });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    const meta = (version.meta as ModelVersionMeta | null) || {};
    const updatedVersion = await unpublishModelVersionById({ ...input, meta, user: ctx.user });

    // Send event in background
    ctx.track.modelVersionEvent({
      type: 'Unpublish',
      modelVersionId: id,
      modelId: updatedVersion.model.id,
      nsfw: updatedVersion.model.nsfw,
    });

    await dataForModelsCache.bust(version.modelId);

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

export const modelVersionEarlyAccessPurchaseHandler = async ({
  input,
  ctx,
}: {
  input: ModelVersionEarlyAccessPurchase;
  ctx: DeepNonNullable<Context>;
}) => {
  try {
    return earlyAccessPurchase({
      ...input,
      userId: ctx.user.id,
    });
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

export const modelVersionDonationGoalsHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: Context;
}) => {
  try {
    return modelVersionDonationGoals({
      ...input,
      userId: ctx.user?.id,
      isModerator: ctx.user?.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) error;
    else throw throwDbError(error);
  }
};

export async function queryModelVersionsForModeratorHandler({
  input,
  ctx,
}: {
  input: QueryModelVersionSchema;
  ctx: Context;
}) {
  const { nextCursor, items } = await queryModelVersions({
    user: ctx.user,
    query: input,
    select: {
      id: true,
      name: true,
      meta: true,
      trainingStatus: true,
      createdAt: true,
      model: {
        select: {
          id: true,
          name: true,
          userId: true,
        },
      },
    },
  });

  return {
    nextCursor,
    items: items as Array<Omit<(typeof items)[number], 'meta'> & { meta: ModelVersionMeta }>,
  };
}

export async function getModelVersionOwnerHandler({ input }: { input: GetByIdInput }) {
  const version = await getVersionById({
    ...input,
    select: { model: { select: { user: { select: userWithCosmeticsSelect } } } },
  });
  if (!version) throw throwNotFoundError();
  return version.model.user;
}

export async function getModelVersionForTrainingReviewHandler({ input }: { input: GetByIdInput }) {
  const version = await getVersionById({
    ...input,
    select: {
      model: { select: { user: { select: userWithCosmeticsSelect } } },
      files: {
        select: {
          metadata: true,
        },
        where: {
          type: 'Training Data',
        },
      },
    },
  });
  if (!version) throw throwNotFoundError();

  const trainingFile = version.files[0];
  const trainingResults = (trainingFile?.metadata as FileMetadata)
    ?.trainingResults as TrainingResultsV2;

  return {
    user: version.model.user,
    workflowId: trainingResults?.workflowId,
    jobId: trainingResults?.jobId as string | null,
    trainingResults,
  };
}
