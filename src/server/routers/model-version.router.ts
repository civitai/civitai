import {
  declineReviewHandler,
  deleteModelVersionHandler,
  earlyAccessModelVersionsOnTimeframeHandler,
  getModelVersionHandler,
  getModelVersionRunStrategiesHandler,
  modelVersionGeneratedImagesOnTimeframeHandler,
  publishModelVersionHandler,
  requestReviewHandler,
  toggleNotifyEarlyAccessHandler,
  unpublishModelVersionHandler,
  upsertModelVersionHandler,
  getVersionLicenseHandler,
} from '~/server/controllers/model-version.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteExplorationPromptSchema,
  earlyAccessModelVersionsOnTimeframeSchema,
  getModelVersionByModelTypeSchema,
  getModelVersionSchema,
  modelVersionUpsertSchema2,
  modelVersionsGeneratedImagesOnTimeframeSchema,
  publishVersionSchema,
  upsertExplorationPromptSchema,
} from '~/server/schema/model-version.schema';
import { declineReviewSchema, unpublishModelSchema } from '~/server/schema/model.schema';
import {
  deleteExplorationPrompt,
  getExplorationPromptsById,
  getModelVersionsByModelType,
  getVersionById,
  upsertExplorationPrompt,
} from '~/server/services/model-version.service';
import { getModel } from '~/server/services/model.service';
import {
  guardedProcedure,
  isFlagProtected,
  middleware,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';
import { throwAuthorizationError } from '~/server/utils/errorHandling';

const isOwnerOrModerator = middleware(async ({ ctx, input, next }) => {
  if (!ctx.user) throw throwAuthorizationError();
  if (ctx.user.isModerator) return next({ ctx: { user: ctx.user } });

  const { id: userId } = ctx.user;
  const { id } = input as { id: number };

  if (id) {
    const modelId = (await getVersionById({ id, select: { modelId: true } }))?.modelId ?? 0;
    const ownerId = (await getModel({ id: modelId, select: { userId: true } }))?.userId ?? -1;

    if (userId !== ownerId) throw throwAuthorizationError();
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const modelVersionRouter = router({
  getById: publicProcedure.input(getModelVersionSchema).query(getModelVersionHandler),
  getRunStrategies: publicProcedure.input(getByIdSchema).query(getModelVersionRunStrategiesHandler),
  getExplorationPromptsById: publicProcedure
    .input(getByIdSchema)
    .query(({ input }) => getExplorationPromptsById(input)),
  toggleNotifyEarlyAccess: protectedProcedure
    .input(getByIdSchema)
    .use(isFlagProtected('earlyAccessModel'))
    .mutation(toggleNotifyEarlyAccessHandler),
  upsert: guardedProcedure
    .input(modelVersionUpsertSchema2)
    .use(isOwnerOrModerator)
    .mutation(upsertModelVersionHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteModelVersionHandler),
  publish: guardedProcedure
    .input(publishVersionSchema)
    .use(isOwnerOrModerator)
    .mutation(publishModelVersionHandler),
  unpublish: protectedProcedure
    .input(unpublishModelSchema)
    .use(isOwnerOrModerator)
    .mutation(unpublishModelVersionHandler),
  upsertExplorationPrompt: protectedProcedure
    .input(upsertExplorationPromptSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => upsertExplorationPrompt(input)),
  deleteExplorationPrompt: protectedProcedure
    .input(deleteExplorationPromptSchema)
    .use(isOwnerOrModerator)
    .mutation(({ input }) => deleteExplorationPrompt(input)),
  requestReview: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(requestReviewHandler),
  declineReview: moderatorProcedure.input(declineReviewSchema).mutation(declineReviewHandler),
  getModelVersionsByModelType: protectedProcedure
    .input(getModelVersionByModelTypeSchema)
    .query(({ input }) => getModelVersionsByModelType(input)),
  earlyAccessModelVersionsOnTimeframe: protectedProcedure
    .input(earlyAccessModelVersionsOnTimeframeSchema)
    .query(earlyAccessModelVersionsOnTimeframeHandler),
  modelVersionsGeneratedImagesOnTimeframe: protectedProcedure
    .input(modelVersionsGeneratedImagesOnTimeframeSchema)
    .query(modelVersionGeneratedImagesOnTimeframeHandler),
  getLicense: publicProcedure.input(getByIdSchema).query(getVersionLicenseHandler),
});
