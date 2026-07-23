import { TRPCError } from '@trpc/server';
import { selectLiveLinkedComponents } from '~/server/utils/model-helpers';
import type { BaseModelType } from '~/server/common/constants';
import { type BaseModel, DEPRECATED_BASE_MODELS } from '~/shared/constants/basemodel.constants';
import { baseModelLicenses, constants } from '~/server/common/constants';
import type { Context, ProtectedContext } from '~/server/createContext';
import { eventEngine } from '~/server/events';
import { dataForModelsCache } from '~/server/redis/caches';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { pickBestTrainingFile, type TrainingResultsV2 } from '~/server/schema/model-file.schema';
import type {
  EarlyAccessModelVersionsOnTimeframeSchema,
  GetModelVersionSchema,
  LinkedComponentSettings,
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
import type { DeclineReviewSchema, UnpublishModelSchema } from '~/server/schema/model.schema';
import type { ModelFileModel } from '~/server/selectors/modelFile.selector';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import { getStaticContent } from '~/server/services/content.service';
import { resolveCanGenerateForVersions } from '~/server/services/generation/generation.service';
import {
  addAdditionalLicensePermissions,
  createModelVersionPostFromTraining,
  deleteVersionById,
  earlyAccessModelVersionsOnTimeframe,
  earlyAccessPurchase,
  getModelVersionRunStrategies,
  getUserEarlyAccessModelVersions,
  getVersionById,
  getWorkflowIdFromModelVersion,
  modelVersionDonationGoals,
  modelVersionGeneratedImagesOnTimeframe,
  publishModelVersionById,
  queryModelVersions,
  toggleNotifyModelVersion,
  unpublishModelVersionById,
  updateModelVersionById,
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
import {
  Availability,
  LicensingFeeSettlementCurrency,
  LicensingFeeType,
  ModelStatus,
  ModelUsageControl,
  TrainingStatus,
} from '~/shared/utils/prisma/enums';
import { removeNulls } from '~/utils/object-helpers';
import { dbRead, dbWrite } from '../db/client';
import { modelFileSelect } from '../selectors/modelFile.selector';
import { getFilesByEntity } from '../services/file.service';
import { createFile } from '../services/model-file.service';
import { getResourceData } from './../services/generation/generation.service';
import { env } from '~/env/server';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { updateTrainingWorkflowRecords } from '~/server/services/training.service';
import { getAllowedAccountTypes } from '~/server/utils/buzz-helpers';
import { isDefined } from '~/utils/type-guards';

export const getModelVersionRunStrategiesHandler = ({ input: { id } }: { input: GetByIdInput }) => {
  try {
    return getModelVersionRunStrategies({ modelVersionId: id });
  } catch (e) {
    throw throwDbError(e);
  }
};

export type ModelVersionById = AsyncReturnType<typeof getModelVersionHandler>;

// Internal: shared body for the public `getById` and the owner-only
// `getByIdForEdit`. The `forceWriteDb` flag is set by the caller (controller-
// level), never by tRPC input â€” keeping it server-side prevents a public
// flag from being used to redirect read load onto the primary DB.
const loadModelVersion = async ({
  input,
  ctx,
  forceWriteDb,
}: {
  input: GetModelVersionSchema;
  ctx: Context;
  forceWriteDb: boolean;
}) => {
  const { id, withFiles } = input;

  try {
    const version = await getVersionById({
      id,
      forceWriteDb,
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
        trainingDetails: true,
        trainingStatus: true,
        uploadType: true,
        usageControl: true,
        availability: true,
        licensingFee: true,
        licensingFeeType: true,
        licensingFeeSettlementCurrency: true,
        licensingSourceVersionId: true,
        flags: true,
        meta: true,
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
            availability: true,
          },
        },
        files: withFiles ? { select: modelFileSelect, where: { replacedAt: null } } : false,
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

    // Separate linked components from regular recommended resources
    const isLinkedComponent = (settings: unknown): settings is LinkedComponentSettings =>
      (settings as LinkedComponentSettings)?.isLinkedComponent === true;

    const allResources = version?.recommendedResources ?? [];
    const linkedComponentResources = allResources.filter((r) => isLinkedComponent(r.settings));
    const regularResources = allResources.filter((r) => !isLinkedComponent(r.settings));

    // Batch-fetch file data for linked components to enrich sizeKB/fileName at read time
    const linkedFileIds = [
      ...new Set(
        linkedComponentResources.map((r) => (r.settings as LinkedComponentSettings).fileId)
      ),
    ].filter(Boolean);
    const linkedFileDataMap = new Map<
      number,
      { name: string; sizeKB: number; type: string; metadata: Record<string, unknown> | null }
    >();
    if (linkedFileIds.length > 0) {
      const fileData = await dbRead.modelFile.findMany({
        where: { id: { in: linkedFileIds } },
        select: { id: true, name: true, sizeKB: true, type: true, metadata: true },
      });
      for (const f of fileData)
        linkedFileDataMap.set(f.id, {
          name: f.name,
          sizeKB: f.sizeKB,
          type: f.type,
          metadata: f.metadata as Record<string, unknown> | null,
        });
    }

    const linkedComponents = selectLiveLinkedComponents(
      linkedComponentResources.map((r) => {
        const s = r.settings as LinkedComponentSettings;
        const fileData = linkedFileDataMap.get(s.fileId);
        return {
          recommendedResourceId: r.id,
          componentType: s.componentType,
          modelId: s.modelId,
          modelName: s.modelName,
          versionId: r.resource?.id ?? 0,
          versionName: s.versionName,
          fileId: s.fileId,
          fileName: fileData?.name ?? s.fileName,
          sizeKB: fileData?.sizeKB,
          fileType: fileData?.type,
          fileMetadata: fileData?.metadata as
            | { format?: string | null; size?: string | null; fp?: string | null }
            | undefined,
          isRequired: s.isRequired,
        };
      }),
      new Set(linkedFileDataMap.keys())
    );

    const recommendedResourceIds = regularResources.map((x) => x.resource.id);
    const generationResources = await getResourceData(recommendedResourceIds, {
      user: ctx?.user,
    }).then((data) =>
      data.map((item) => {
        const settings = (regularResources.find((x) => x.resource.id === item.id)?.settings ??
          {}) as RecommendedSettingsSchema;
        return { ...item, ...removeNulls(settings) };
      })
    );

    if (!version) throw throwNotFoundError(`No version with id ${input.id}`);

    const genStates = await resolveCanGenerateForVersions(
      [
        {
          id: version.id,
          status: version.status,
          availability: version.availability,
          usageControl: version.usageControl,
          baseModel: version.baseModel,
          covered: version.generationCoverage?.covered ?? false,
          modelUserId: version.model.user.id,
          modelType: version.model.type,
          flags: version.flags,
          modelVersionAlias: (version.meta as ModelVersionMeta | null)?.generationAlias,
        },
      ],
      {
        user: { id: ctx?.user?.id, isModerator: ctx?.user?.isModerator },
        sfwOnly: ctx?.domain === 'green',
        wildcardsEnabled: !!ctx?.features.wildcards,
      }
    );
    const versionState = genStates.get(version.id);
    const canGenerate = versionState?.canGenerate ?? false;
    const wildcardSetId = versionState?.wildcardSetId;

    return {
      ...version,
      licensingFee: version.licensingFee != null ? Number(version.licensingFee) : null,
      canGenerate,
      wildcardSetId,
      earlyAccessConfig: version.earlyAccessConfig as ModelVersionEarlyAccessConfig | null,
      baseModel: version.baseModel as BaseModel,
      baseModelType: version.baseModelType as BaseModelType,
      trainingDetails: version.trainingDetails as TrainingDetailsObj | undefined,
      files: version.files as unknown as Array<
        Omit<ModelFileModel, 'metadata'> & { metadata: FileMetadata }
      >,
      settings: version.settings as RecommendedSettingsSchema | undefined,
      recommendedResources: generationResources,
      linkedComponents,
    };
  } catch (e) {
    if (e instanceof TRPCError) throw e;
    else throw throwDbError(e);
  }
};

export const getModelVersionHandler = async (params: {
  input: GetModelVersionSchema;
  ctx: Context;
}) => loadModelVersion({ ...params, forceWriteDb: false });

// Owner-only entry point. Always reads from the primary DB so freshly-mutated
// files / linked components are visible regardless of replication lag. The
// router gates this behind `protectedProcedure.use(isOwnerOrModerator)` so
// only owners and moderators can hit it.
export const getModelVersionForEditHandler = async (params: {
  input: GetModelVersionSchema;
  ctx: Context;
}) => loadModelVersion({ ...params, forceWriteDb: true });

export const toggleNotifyEarlyAccessHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: ProtectedContext;
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
  ctx: ProtectedContext;
}) => {
  try {
    const { id: userId } = ctx.user;

    // Check if using deprecated base model
    if (input.baseModel && DEPRECATED_BASE_MODELS.includes(input.baseModel as any)) {
      throw throwBadRequestError(
        `Cannot create or update model versions using deprecated base models: ${DEPRECATED_BASE_MODELS.join(
          ', '
        )}`
      );
    }

    if (!ctx.features.generationOnlyModels && input.usageControl !== ModelUsageControl.Download) {
      // People without access to thje generationOnlyModels feature can only create download models
      input.usageControl = ModelUsageControl.Download;
    }

    if (input.usageControl === ModelUsageControl.InternalGeneration && !ctx.user.isModerator) {
      throw throwBadRequestError('Only moderators can manage internal generation models');
    }

    if (input.usageControl === ModelUsageControl.ExternalGeneration && !ctx.user.isModerator) {
      throw throwBadRequestError('Only moderators can manage external generation models');
    }

    if (input.trainingDetails === null) {
      input.trainingDetails = undefined;
    }

    if (!!input.earlyAccessConfig?.timeframe) {
      const maxDays = getMaxEarlyAccessDays({ userMeta: ctx.user.meta, features: ctx.features });

      if (!ctx.user.isModerator && input.earlyAccessConfig?.timeframe > maxDays) {
        throw throwBadRequestError('Early access days exceeds user limit');
      }
    }

    if (input?.earlyAccessConfig?.timeframe) {
      // Confirm the user doesn't have any other early access models that are still active.
      const activeEarlyAccess = await getUserEarlyAccessModelVersions({ userId: ctx.user.id });

      if (
        !ctx.user.isModerator &&
        activeEarlyAccess.length >=
          getMaxEarlyAccessModels({ userMeta: ctx.user.meta, features: ctx.features }) &&
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

    if (input.licensingFee != null && input.licensingFee > 0) {
      const existing = input.id
        ? await dbRead.modelVersion.findUnique({
            where: { id: input.id },
            select: { licensingFee: true, licensingFeeSettlementCurrency: true },
          })
        : null;
      const hadExistingFee = existing?.licensingFee != null && Number(existing.licensingFee) > 0;
      if (!ctx.features.licensingFee && !ctx.user.isModerator && !hadExistingFee) {
        throw throwBadRequestError('License fees are not enabled for your account.');
      }
      if (
        input.licensingFeeSettlementCurrency === LicensingFeeSettlementCurrency.Cash &&
        !ctx.user.isModerator &&
        existing?.licensingFeeSettlementCurrency !== LicensingFeeSettlementCurrency.Cash
      ) {
        throw throwBadRequestError('Cash settlement is restricted; please contact support.');
      }
      if (!input.licensingFeeType) input.licensingFeeType = LicensingFeeType.PerImageBuzz;
      if (!input.licensingFeeSettlementCurrency)
        input.licensingFeeSettlementCurrency = LicensingFeeSettlementCurrency.Buzz;
    }

    // Licensing lineage: the chosen source must be a registered LicensingRoot for
    // the same base model. Guards against pointing at an arbitrary version to
    // dodge the base-model rule.
    if (input.licensingSourceVersionId != null) {
      const source = await dbRead.licensingRoot.findUnique({
        where: { modelVersionId: input.licensingSourceVersionId },
        select: { baseModel: true },
      });
      if (!source)
        throw throwBadRequestError('Invalid licensing source: not a licensing lineage root.');
      if (source.baseModel !== input.baseModel)
        throw throwBadRequestError('Licensing source must share the same base model.');
    }

    const version = await upsertModelVersion({
      ...input,
      trainingDetails: input.trainingDetails,
    });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id as number}`);

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
        // ctx.track.modelVersionEvent({
        //   type: 'Create',
        //   modelId: version.modelId,
        //   modelVersionId: version.id,
        //   nsfw: model.nsfw,
        // });
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

    await dataForModelsCache.refresh(version.modelId);

    // The service returns a full Prisma row; devalue (TRPC_WRITE_DEVALUE pools)
    // throws on a raw `Decimal`, so convert before it hits the wire.
    return {
      ...version,
      licensingFee: version.licensingFee != null ? Number(version.licensingFee) : null,
    };
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const deleteModelVersionHandler = async ({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: ProtectedContext;
}) => {
  try {
    const version = await deleteVersionById({ ...input, isModerator: ctx.user.isModerator });
    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    await updateModelEarlyAccessDeadline({ id: version.modelId }).catch((e) => {
      console.error('Unable to update model early access deadline');
      console.error(e);
    });

    await dataForModelsCache.refresh(version.modelId);

    // `deleteVersionById` returns the full deleted row — same Decimal hazard as upsert above.
    return {
      ...version,
      licensingFee: version.licensingFee != null ? Number(version.licensingFee) : null,
    };
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
  ctx: ProtectedContext;
}) => {
  try {
    const version = await getVersionById({
      id: input.id,
      select: {
        meta: true,
        status: true,
        modelId: true,
        baseModel: true,
        earlyAccessConfig: true,
        model: { select: { userId: true, nsfw: true } },
      },
    });

    if (!version) throw throwNotFoundError(`No model version with id ${input.id}`);

    // Check if using deprecated base model
    if (DEPRECATED_BASE_MODELS.includes(version.baseModel as any)) {
      throw throwBadRequestError(
        `Cannot publish model versions using deprecated base models: ${DEPRECATED_BASE_MODELS.join(
          ', '
        )}`
      );
    }

    const versionMeta = version.meta as ModelVersionMeta | null;

    // Prevent non-moderators from re-publishing versions unpublished for violations
    if (!ctx.user.isModerator && constants.modPublishOnlyStatuses.includes(version.status)) {
      throw throwAuthorizationError('You are not authorized to publish this model version');
    }

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

    await dataForModelsCache.refresh(version.modelId);

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
  ctx: ProtectedContext;
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

    await dataForModelsCache.refresh(version.modelId);

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
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const declineReviewHandler = async ({
  input,
  ctx,
}: {
  input: DeclineReviewSchema;
  ctx: ProtectedContext;
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
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const earlyAccessModelVersionsOnTimeframeHandler = async ({
  input,
  ctx,
}: {
  input: EarlyAccessModelVersionsOnTimeframeSchema;
  ctx: ProtectedContext;
}) => {
  try {
    return earlyAccessModelVersionsOnTimeframe({
      ...input,
      userId: ctx.user.id,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    else throw throwDbError(error);
  }
};

export const modelVersionGeneratedImagesOnTimeframeHandler = async ({
  input,
  ctx,
}: {
  input: ModelVersionsGeneratedImagesOnTimeframeSchema;
  ctx: ProtectedContext;
}) => {
  try {
    return modelVersionGeneratedImagesOnTimeframe({
      ...input,
      userId: ctx.user.id,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
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
  ctx: ProtectedContext;
}) => {
  try {
    return earlyAccessPurchase({
      ...input,
      userId: ctx.user.id,
      buzzType: getAllowedAccountTypes(ctx.features)[0],
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
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
    // `await` is load-bearing: without it the rejected promise escapes this
    // try/catch (so a Prisma error bypassed the P2025→NOT_FOUND mapping in
    // throwDbError and surfaced as INTERNAL_SERVER_ERROR). The service now also
    // throws NOT_FOUND at the source, so this is belt-and-suspenders.
    return await modelVersionDonationGoals({
      ...input,
      userId: ctx.user?.id,
      isModerator: ctx.user?.isModerator,
    });
  } catch (error) {
    if (error instanceof TRPCError) throw error;
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
      files: {
        select: { metadata: true },
        where: { type: 'Training Data' },
        take: 1,
      },
    },
  });

  const workflowIds: string[] = [];
  const mappedItems = items.map(({ files, meta, ...version }) => {
    const trainingFile = pickBestTrainingFile(files);
    const trainingResults = (trainingFile?.metadata as FileMetadata)
      ?.trainingResults as TrainingResultsV2;

    if (trainingResults?.workflowId) workflowIds.push(trainingResults.workflowId);

    return {
      ...version,
      meta: meta as ModelVersionMeta | null,
      workflowId: trainingResults?.workflowId,
    };
  });

  /*
    querying the workflows here may seem pointless, but querying the workflow can cause the orchestrator to take action on a workflow with failed/expired jobs.

    Perhaps we need to move this to a method that can be called from the client to refresh the list as needed
  */
  const workflows = await Promise.all(
    workflowIds.map((workflowId) =>
      getWorkflow({ token: env.ORCHESTRATOR_ACCESS_TOKEN, path: { workflowId } }).catch(() => null)
    )
  );

  return {
    nextCursor,
    items: mappedItems
      .map((item) => ({
        ...item,
        workflow: workflows.find((x) => x && x.id === item.workflowId),
      }))
      .filter((x) => x.workflow),
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
      model: { select: { id: true, user: { select: userWithCosmeticsSelect } } },
      files: {
        select: { id: true, metadata: true },
        where: { type: 'Training Data' },
      },
    },
  });
  if (!version) throw throwNotFoundError();

  const trainingFile = pickBestTrainingFile(version.files);
  // TODO(replica-toast): overlay is a workaround for data-packet logical subscriber dropping TOASTed jsonb. Remove once replication is fixed.
  const fresh = trainingFile
    ? await dbWrite.modelFile.findUnique({
        where: { id: trainingFile.id },
        select: { metadata: true },
      })
    : null;
  const metadata = (fresh?.metadata ?? trainingFile?.metadata) as FileMetadata | undefined;
  const trainingResults = (metadata?.trainingResults ?? {}) as TrainingResultsV2;

  return {
    modelId: version.model.id,
    user: version.model.user,
    workflowId: trainingResults?.workflowId,
    jobId: trainingResults?.jobId as string | null,
    trainingResults,
  };
}

export async function recheckModelVersionTrainingStatusHandler({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: ProtectedContext;
}) {
  const { id: userId, isModerator } = ctx.user;

  const version = await getVersionById({
    ...input,
    select: {
      id: true,
      name: true,
      baseModel: true,
      model: { select: { id: true, userId: true } },
    },
  });
  if (!version) throw throwNotFoundError();
  if (version.model.userId !== userId && !isModerator) throw throwAuthorizationError();

  const workflowId = await getWorkflowIdFromModelVersion({ id: version.id });
  if (!workflowId) throw throwBadRequestError('No workflowId found for this model version');

  const workflow = await getWorkflow({
    token: env.ORCHESTRATOR_ACCESS_TOKEN,
    path: { workflowId },
  });

  if (!workflow.status) throw throwBadRequestError('No workflow status found');

  // Use the same update logic as the webhook to ensure consistency
  const result = await updateTrainingWorkflowRecords(workflow, workflow.status);

  // Return the updated model version
  const updatedVersion = await getVersionById({
    id: result.modelVersionId,
    select: {
      id: true,
      name: true,
      trainingStatus: true,
    },
  });

  return updatedVersion;
}

export async function publishPrivateModelVersionHandler({
  input,
  ctx,
}: {
  input: GetByIdInput;
  ctx: ProtectedContext;
}) {
  const version = await getVersionById({
    ...input,
    select: {
      id: true,
      uploadType: true,
      model: { select: { id: true, publishedAt: true, availability: true, userId: true } },
      files: {
        select: {
          id: true,
          metadata: true,
        },
      },
      posts: {
        select: {
          id: true,
        },
        take: 1,
      },
    },
  });

  if (!version) throw throwNotFoundError();

  if (version.model.userId !== ctx.user.id && !ctx.user?.isModerator) {
    throw throwAuthorizationError();
  }

  if (version.model.availability !== Availability.Private) {
    throw throwBadRequestError('Model is not private');
  }

  // TODO(replica-toast): overlay is a workaround for data-packet logical subscriber dropping TOASTed jsonb. Remove once replication is fixed.
  const fileIds = version.files.map((f) => f.id);
  const freshFiles = fileIds.length
    ? await dbWrite.modelFile.findMany({
        where: { id: { in: fileIds } },
        select: { id: true, metadata: true },
      })
    : [];
  const selectedEpochUrl = freshFiles.some((f) => (f?.metadata as FileMetadata)?.selectedEpochUrl);

  if (!selectedEpochUrl) {
    throw throwBadRequestError('No selected epoch found');
  }

  if (!version.posts.length) {
    const post = await createModelVersionPostFromTraining({
      modelVersionId: version.id,
      user: ctx.user,
    });
    // createPost (service) doesn't emit the post-create ClickHouse event, so do it
    // here, tagged 'training' to mark the origin. nsfw is hardcoded false rather
    // than derived from nsfwLevel (as other track.post calls do): the sample
    // images were just uploaded and aren't scanned yet, so the post's nsfwLevel
    // is still 0 and !getIsSafeBrowsingLevel(0) would flag every training post as
    // NSFW. The scan pipeline sets the real level later.
    if (post) {
      await ctx.track.post({ type: 'Create', postId: post.id, nsfw: false, tags: ['training'] });
    }
  }

  const modelVersion = await updateModelVersionById({
    id: version.id,
    data: {
      status: ModelStatus.Published,
      publishedAt: new Date(),
      availability: Availability.Private,
    },
  });

  await dataForModelsCache.refresh(version.model.id);

  return modelVersion;
}
