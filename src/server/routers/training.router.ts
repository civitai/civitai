import { z } from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { getModelData } from '~/server/controllers/training.controller';
import { dbKV } from '~/server/db/db-helpers';
import { edgeCacheIt } from '~/server/middleware.trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  autoCaptionInput,
  autoTagInput,
  createTrainingRequestDryRunSchema,
  createTrainingRequestSchema,
  moveAssetInput,
} from '~/server/schema/training.schema';
import {
  autoCaptionHandler,
  autoTagHandler,
  createTrainingRequest,
  createTrainingRequestDryRun,
  getAutoLabelJobStatusHandler,
  getJobEstStartsHandler,
  getTrainingServiceStatus,
  moveAsset,
} from '~/server/services/training.service';
import {
  guardedProcedure,
  isFlagProtected,
  moderatorProcedure,
  protectedProcedure,
  publicProcedure,
  router,
} from '~/server/trpc';

const TRAINING_ANNOUNCEMENT_KEY = 'training-announcement';
const announcementColors = ['yellow', 'red', 'blue', 'green', 'gray'] as const;
const trainingAnnouncementSchema = z.object({
  message: z.string().max(2000),
  color: z.enum(announcementColors).default('yellow'),
});
type TrainingAnnouncement = z.infer<typeof trainingAnnouncementSchema>;

export const trainingRouter = router({
  /**
   * @deprecated for orchestrator v2
   */
  createRequest: guardedProcedure
    .input(createTrainingRequestSchema)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => createTrainingRequest({ ...input, userId: ctx.user.id })),
  /**
   * @deprecated for orchestrator v2
   */
  createRequestDryRun: protectedProcedure
    .input(createTrainingRequestDryRunSchema)
    .use(isFlagProtected('imageTraining'))
    .query(({ input }) => createTrainingRequestDryRun({ ...input })),

  moveAsset: protectedProcedure
    .input(moveAssetInput)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => moveAsset({ ...input, userId: ctx.user.id })),
  getModelBasic: publicProcedure.input(getByIdSchema).query(getModelData),
  autoTag: guardedProcedure
    .input(autoTagInput)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => autoTagHandler({ ...input, userId: ctx.user.id })),
  autoCaption: guardedProcedure
    .input(autoCaptionInput)
    .use(isFlagProtected('imageTraining'))
    .mutation(({ input, ctx }) => autoCaptionHandler({ ...input, userId: ctx.user.id })),
  getAutoLabelJobStatus: protectedProcedure
    .input(z.object({ token: z.string() }))
    .use(isFlagProtected('imageTraining'))
    .query(({ input }) => getAutoLabelJobStatusHandler(input)),
  getStatus: publicProcedure
    .use(isFlagProtected('imageTraining'))
    .use(edgeCacheIt({ ttl: CacheTTL.xs }))
    .query(() => getTrainingServiceStatus()),
  /**
   * @deprecated for orchestrator v2
   */
  getJobEstStarts: protectedProcedure
    .use(isFlagProtected('imageTraining'))
    .query(({ ctx }) => getJobEstStartsHandler({ userId: ctx.user.id })),

  // Training page announcement (moderator-editable)
  getAnnouncement: publicProcedure.query(async () => {
    const announcement = await dbKV.get<TrainingAnnouncement>(TRAINING_ANNOUNCEMENT_KEY);
    return announcement ?? null;
  }),

  setAnnouncement: moderatorProcedure
    .input(trainingAnnouncementSchema)
    .mutation(async ({ input }) => {
      await dbKV.set(TRAINING_ANNOUNCEMENT_KEY, input);
      return { success: true };
    }),
});
