import { z } from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { getModelData } from '~/server/controllers/training.controller';
import { dbKV } from '~/server/db/db-helpers';
import { edgeCacheIt, purgeOnSuccess, rateLimit  } from '~/server/middleware.trpc';
import { getByIdSchema } from '~/server/schema/base.schema';
import {
  autoCaptionInput,
  autoTagInput,
  createTrainingRequestDryRunSchema,
  createTrainingRequestSchema,
  getAutoLabelWorkflowSchema,
  moveAssetInput,
  submitAutoLabelWorkflowSchema,
} from '~/server/schema/training.schema';
import {
  autoCaptionHandler,
  autoTagHandler,
  createTrainingRequest,
  createTrainingRequestDryRun,
  getAutoLabelUploadUrl,
  getAutoLabelWorkflow,
  getJobEstStartsHandler,
  getTrainingServiceStatus,
  moveAsset,
  submitAutoLabelWorkflow,
  setTrainingServiceStatus,
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

  // Auto-label v2 — orchestrator workflows. The frontend calls these in sequence:
  //   1) getAutoLabelUploadUrl (per image) → POST blob directly to the presigned URL
  //   2) submitAutoLabelWorkflow with the resulting blob URLs (≤16 per call)
  //   3) getAutoLabelWorkflow on a poll loop until each step is succeeded/failed
  //
  // Tagging/captioning is free; the orchestrator work is billed to the system token
  // and not the user, so each endpoint needs a per-user rate cap to prevent abuse.
  getAutoLabelUploadUrl: guardedProcedure
    .use(isFlagProtected('imageTraining'))
    .use(isFlagProtected('trainingAutoLabelOrchestrator'))
    // Per-image: ~1000 images/min is the soft ceiling we want to allow for legitimate
    // use, so the cap matches that 1:1 (each image needs one presign).
    .use(rateLimit({ limit: 1000, period: 60 }))
    .mutation(() => getAutoLabelUploadUrl()),
  submitAutoLabelWorkflow: guardedProcedure
    .input(submitAutoLabelWorkflowSchema)
    .use(isFlagProtected('imageTraining'))
    .use(isFlagProtected('trainingAutoLabelOrchestrator'))
    // Per-batch (≤16 images): 100/min covers ~1600 images/min in flight, leaving a
    // little headroom above the 1000/min upload ceiling.
    .use(rateLimit({ limit: 100, period: 60 }))
    .mutation(({ input, ctx }) => submitAutoLabelWorkflow({ ...input, userId: ctx.user.id })),
  getAutoLabelWorkflow: guardedProcedure
    .input(getAutoLabelWorkflowSchema)
    .use(isFlagProtected('imageTraining'))
    .use(isFlagProtected('trainingAutoLabelOrchestrator'))
    // Polling — at 5s cadence each workflow eats ~12 polls/min. A 1000-image run
    // chunked at 16 = ~63 workflows; if a third are in flight at peak that's ~250
    // polls/min. 1500/min keeps polling from being the bottleneck.
    .use(rateLimit({ limit: 1500, period: 60 }))
    .query(({ input, ctx }) => getAutoLabelWorkflow({ ...input, userId: ctx.user.id })),
  getStatus: publicProcedure
    .use(isFlagProtected('imageTraining'))
    .use(edgeCacheIt({ ttl: CacheTTL.xs, tags: () => ['training-status'] }))
    .query(() => getTrainingServiceStatus()),
  setStatus: moderatorProcedure
    .input(
      z.object({
        available: z.boolean(),
        message: z.string().max(2000).nullish(),
      })
    )
    .use(purgeOnSuccess(['training-status']))
    .mutation(({ input }) => setTrainingServiceStatus(input)),
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
