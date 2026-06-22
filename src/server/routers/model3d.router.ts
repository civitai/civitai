import {
  router,
  publicProcedure,
  protectedProcedure,
  moderatorProcedure,
  guardedProcedure,
  isFlagProtected,
} from '~/server/trpc';
import {
  upsertModel3DSchema,
  ensureModel3DFromWorkflowSchema,
  getModel3DByIdSchema,
  getModel3DByPostIdSchema,
  getModel3DByThumbnailImageIdSchema,
  getModel3DByWorkflowIdSchema,
  getModel3DsInfiniteSchema,
  getModel3DTagsSchema,
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
  setModel3DNsfwLevelSchema,
  toggleModel3DFlagSchema,
  restoreModel3DSchema,
  updateModel3DGallerySettingsSchema,
} from '~/server/schema/model3d.schema';
import {
  upsertModel3D,
  ensureModel3DFromWorkflow,
  getModel3DLicenses,
  getModel3DById,
  getModel3DByPostId,
  getModel3DByThumbnailImageId,
  getModel3DByWorkflowId,
  getModel3DGallerySettings,
  getModel3DsInfinite,
  getModel3DTags,
  publishModel3D,
  unpublishModel3D,
  deleteModel3D,
  getModel3DFiles,
  getModel3DRelatedPosts,
  getModel3DReviewSummary,
  setModel3DNsfwLevel,
  toggleModel3DFlag,
  restoreModel3D,
  updateModel3DGallerySettings,
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

// All model3d procedures are gated by the `model3dFeed` flag. The feed flag
// controls viewing + commenting + reviewing the Model3D entity itself; the
// generator flag (`model3dGenerator`) lives on the generation surfaces added
// by workstream F.
const reviewsRouter = router({
  upsert: guardedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(upsertModel3DReviewSchema)
    .mutation(({ input, ctx }) => upsertModel3DReview({ input, user: ctx.user })),
  getInfinite: publicProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(getModel3DReviewsSchema)
    .query(({ input, ctx }) => getModel3DReviews({ input, user: ctx.user })),
  getSummary: publicProcedure
    .input(getModel3DReviewSummarySchema)
    .query(({ input }) => getModel3DReviewSummary({ input })),
  delete: protectedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(deleteModel3DReviewSchema)
    .mutation(({ input, ctx }) => deleteModel3DReview({ input, user: ctx.user })),
});

// Mod content-actioning endpoints (workstream O / plan §M2 Phase 3). NOT
// flag-gated — mods always have access regardless of `model3dFeed` rollout.
const moderationRouter = router({
  setNsfwLevel: moderatorProcedure
    .input(setModel3DNsfwLevelSchema)
    .mutation(({ input, ctx }) => setModel3DNsfwLevel({ ...input, user: ctx.user })),
  toggleFlag: moderatorProcedure
    .input(toggleModel3DFlagSchema)
    .mutation(({ input, ctx }) => toggleModel3DFlag({ ...input, user: ctx.user })),
  restore: moderatorProcedure
    .input(restoreModel3DSchema)
    .mutation(({ input, ctx }) => restoreModel3D({ ...input, user: ctx.user })),
});

const reportsRouter = router({
  // Reports on a Model3D.
  createForModel: guardedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(createModel3DReportSchema)
    .mutation(({ input, ctx }) => createModel3DReport({ input, user: ctx.user })),
  // Reports on a Model3DReview.
  createForReview: guardedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(createModel3DReviewReportSchema)
    .mutation(({ input, ctx }) => createModel3DReviewReport({ input, user: ctx.user })),
});

export const model3dRouter = router({
  // Core CRUD
  getById: publicProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(getModel3DByIdSchema)
    .query(({ input, ctx }) => getModel3DById({ ...input, user: ctx.user })),
  // Look up a Model3D by orchestrator workflowId — used by the queue-card
  // "Post from Generation" flow. Requires login + ownership (or mod); the
  // service returns null instead of throwing when the draft hasn't landed yet
  // so the UI can render a "still processing" state without a red banner.
  getByWorkflowId: protectedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(getModel3DByWorkflowIdSchema)
    .query(({ input, ctx }) => getModel3DByWorkflowId({ input, user: ctx.user })),
  // Public lookup used by the image viewers' "Posted to 3D Model" chip.
  // Returns the linked Model3D's card payload (id, name, thumbnail) or null
  // when the post isn't tied to one — the chip stays hidden on null.
  getByPostId: publicProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(getModel3DByPostIdSchema)
    .query(({ input, ctx }) =>
      getModel3DByPostId({
        ...input,
        userId: ctx.user?.id,
        isModerator: !!ctx.user?.isModerator,
      })
    ),
  // Lazy materialization for the "Post from Generation" CTA. The webhook
  // that runs `handlePolyGenWorkflowResult` after a PolyGen workflow
  // completes isn't wired up yet — this mutation closes that gap on
  // demand and is idempotent on `Model3D.workflowId`.
  ensureFromWorkflow: protectedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(ensureModel3DFromWorkflowSchema)
    .mutation(({ input, ctx }) =>
      ensureModel3DFromWorkflow({ input, user: ctx.user, ctx })
    ),
  getLicenses: publicProcedure
    .use(isFlagProtected('model3dFeed'))
    .query(() => getModel3DLicenses()),
  // Distinct tags actually attached to Model3Ds, ranked by usage count. Used
  // by the chip row above the /3d-models feed.
  getTags: publicProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(getModel3DTagsSchema)
    .query(({ input }) => getModel3DTags(input)),
  getInfinite: publicProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(getModel3DsInfiniteSchema)
    .query(({ input, ctx }) => getModel3DsInfinite({ ...input, user: ctx.user })),
  upsert: guardedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(upsertModel3DSchema)
    .mutation(({ input, ctx }) => upsertModel3D({ input, user: ctx.user })),
  publish: protectedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(publishModel3DSchema)
    .mutation(({ input, ctx }) => publishModel3D({ input, user: ctx.user })),
  unpublish: protectedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(unpublishModel3DSchema)
    .mutation(({ input, ctx }) => unpublishModel3D({ input, user: ctx.user })),
  delete: protectedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(deleteModel3DSchema)
    .mutation(({ input, ctx }) => deleteModel3D({ input, user: ctx.user })),
  getFiles: publicProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(getModel3DFilesSchema)
    .query(({ input, ctx }) => getModel3DFiles({ input, user: ctx.user })),
  getRelatedPosts: publicProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(getModel3DRelatedPostsSchema)
    .query(({ input, ctx }) => getModel3DRelatedPosts({ input, user: ctx.user })),

  // Mod-only — used by the image-mod surface to surface a thumbnail-driven
  // affordance against the linked Model3D. Returns ownership info, so guard
  // with `moderatorProcedure` (not feature-flagged — mods always have access).
  getByThumbnailImageId: moderatorProcedure
    .input(getModel3DByThumbnailImageIdSchema)
    .query(({ input }) => getModel3DByThumbnailImageId(input)),

  // Per-Model3D gallery moderation. Public read (the masonry needs hidden
  // ids before it can apply them via `useApplyHiddenPreferences`); update is
  // owner-or-mod gated inside the service.
  getGallerySettings: publicProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(getModel3DByIdSchema)
    .query(({ input }) => getModel3DGallerySettings({ id: input.id })),
  updateGallerySettings: guardedProcedure
    .use(isFlagProtected('model3dFeed'))
    .input(updateModel3DGallerySettingsSchema)
    .mutation(({ input, ctx }) =>
      updateModel3DGallerySettings({
        input,
        userId: ctx.user.id,
        isModerator: !!ctx.user.isModerator,
      })
    ),

  // Sub-routers
  reviews: reviewsRouter,
  reports: reportsRouter,
  moderation: moderationRouter,
});
