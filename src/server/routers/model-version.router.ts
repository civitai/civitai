import {
  declineReviewHandler,
  deleteModelVersionHandler,
  getModelVersionHandler,
  getModelVersionRunStrategiesHandler,
  publishModelVersionHandler,
  requestReviewHandler,
  toggleNotifyEarlyAccessHandler,
  unpublishModelVersionHandler,
  upsertModelVersionHandler,
} from '~/server/controllers/model-version.controller';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  deleteExplorationPromptSchema,
  getModelVersionSchema,
  modelVersionUpsertSchema2,
  publishVersionSchema,
  upsertExplorationPromptSchema,
} from '~/server/schema/model-version.schema';
import { declineReviewSchema, unpublishModelSchema } from '~/server/schema/model.schema';
import {
  deleteExplorationPrompt,
  getExplorationPromptsById,
  getVersionById,
  upsertExplorationPrompt,
} from '~/server/services/model-version.service';
import { getModel } from '~/server/services/model.service';
import {
  isFlagProtected,
  middleware,
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

  const modelId = (await getVersionById({ id, select: { modelId: true } }))?.modelId ?? 0;
  const ownerId = (await getModel({ id: modelId, select: { userId: true } }))?.userId ?? -1;

  if (userId !== ownerId) throw throwAuthorizationError();

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
  upsert: protectedProcedure.input(modelVersionUpsertSchema2).mutation(upsertModelVersionHandler),
  delete: protectedProcedure
    .input(getByIdSchema)
    .use(isOwnerOrModerator)
    .mutation(deleteModelVersionHandler),
  publish: protectedProcedure
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
  declineReview: protectedProcedure.input(declineReviewSchema).mutation(declineReviewHandler),
});
