import { router, publicProcedure, protectedProcedure, guardedProcedure } from '~/server/trpc';
import {
  upsertModel3DSchema,
  getModel3DByIdSchema,
  getModel3DsInfiniteSchema,
  publishModel3DSchema,
  unpublishModel3DSchema,
  deleteModel3DSchema,
  getModel3DFilesSchema,
  getModel3DRelatedPostsSchema,
  getModel3DReviewSummarySchema,
  upsertModel3DReviewSchema,
  getModel3DReviewsSchema,
  deleteModel3DReviewSchema,
  createModel3DReportSchema,
  createModel3DReviewReportSchema,
} from '~/server/schema/model3d.schema';
import {
  upsertModel3D,
  getModel3DById,
  getModel3DsInfinite,
  publishModel3D,
  unpublishModel3D,
  deleteModel3D,
  getModel3DFiles,
  getModel3DRelatedPosts,
  getModel3DReviewSummary,
} from '~/server/services/model3d.service';
import {
  upsertModel3DReview,
  getModel3DReviews,
  deleteModel3DReview,
} from '~/server/services/model3d-review.service';
import {
  createModel3DReport,
  createModel3DReviewReport,
} from '~/server/services/model3d-report.service';

const reviewsRouter = router({
  upsert: guardedProcedure
    .input(upsertModel3DReviewSchema)
    .mutation(({ input, ctx }) => upsertModel3DReview({ input, user: ctx.user })),
  getInfinite: publicProcedure
    .input(getModel3DReviewsSchema)
    .query(({ input, ctx }) => getModel3DReviews({ input, user: ctx.user })),
  getSummary: publicProcedure
    .input(getModel3DReviewSummarySchema)
    .query(({ input }) => getModel3DReviewSummary({ input })),
  delete: protectedProcedure
    .input(deleteModel3DReviewSchema)
    .mutation(({ input, ctx }) => deleteModel3DReview({ input, user: ctx.user })),
});

const reportsRouter = router({
  // Reports on a Model3D.
  createForModel: guardedProcedure
    .input(createModel3DReportSchema)
    .mutation(({ input, ctx }) => createModel3DReport({ input, user: ctx.user })),
  // Reports on a Model3DReview.
  createForReview: guardedProcedure
    .input(createModel3DReviewReportSchema)
    .mutation(({ input, ctx }) => createModel3DReviewReport({ input, user: ctx.user })),
});

export const model3dRouter = router({
  // Core CRUD
  getById: publicProcedure
    .input(getModel3DByIdSchema)
    .query(({ input, ctx }) => getModel3DById({ ...input, user: ctx.user })),
  getInfinite: publicProcedure
    .input(getModel3DsInfiniteSchema)
    .query(({ input, ctx }) => getModel3DsInfinite({ ...input, user: ctx.user })),
  upsert: guardedProcedure
    .input(upsertModel3DSchema)
    .mutation(({ input, ctx }) => upsertModel3D({ input, user: ctx.user })),
  publish: protectedProcedure
    .input(publishModel3DSchema)
    .mutation(({ input, ctx }) => publishModel3D({ input, user: ctx.user })),
  unpublish: protectedProcedure
    .input(unpublishModel3DSchema)
    .mutation(({ input, ctx }) => unpublishModel3D({ input, user: ctx.user })),
  delete: protectedProcedure
    .input(deleteModel3DSchema)
    .mutation(({ input, ctx }) => deleteModel3D({ input, user: ctx.user })),
  getFiles: publicProcedure
    .input(getModel3DFilesSchema)
    .query(({ input, ctx }) => getModel3DFiles({ input, user: ctx.user })),
  getRelatedPosts: publicProcedure
    .input(getModel3DRelatedPostsSchema)
    .query(({ input, ctx }) => getModel3DRelatedPosts({ input, user: ctx.user })),

  // Sub-routers
  reviews: reviewsRouter,
  reports: reportsRouter,
});
