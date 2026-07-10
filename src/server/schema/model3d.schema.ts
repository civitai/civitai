import * as z from 'zod';
import { MetricTimeframe, Model3DStatus, ReportReason } from '~/shared/utils/prisma/enums';
import {
  baseQuerySchema,
  infiniteQuerySchema,
  paginationSchema,
} from '~/server/schema/base.schema';

/**
 * Sort options for the 3D models feed. Mirrors `ModelSort` shape (label-as-value
 * so the dropdown can render the enum directly), but limited to keys we can
 * actually compute against Model3D + Model3DMetric.
 */
export const Model3DSort = {
  Newest: 'Newest',
  MostDownloaded: 'Most Downloaded',
  // "Most Liked" = thumbs-up (recommend) count. There is no separate
  // "Highest Rated" — with only a thumbs-up signal it duplicated Most Liked.
  MostLiked: 'Most Liked',
} as const;
export type Model3DSort = (typeof Model3DSort)[keyof typeof Model3DSort];
import {
  reportAdminAttentionDetailsSchema,
  reportAutomatedDetailsSchema,
  reportClaimDetailsSchema,
  reportNsfwDetailsSchema,
  reportOwnershipDetailsSchema,
  reportSpamDetailsSchema,
  reportTosViolationDetailsSchema,
} from '~/server/schema/report.schema';

// ---------------------------------------------------------------------------
// Model3D core
// ---------------------------------------------------------------------------

export type UpsertModel3DInput = z.infer<typeof upsertModel3DSchema>;
export const upsertModel3DSchema = z.object({
  id: z.number().optional(),
  name: z.string().trim().min(1).max(150),
  description: z.string().nullish(),
  licenseId: z.number().int().positive(),
  licenseDetails: z.string().nullish(),
  thumbnailImageId: z.number().int().positive().nullish(),
  // Generation provenance — set by the workflow result handler. Surfaced here
  // so the upsert can carry them through when a Draft is being completed.
  workflowId: z.string().nullish(),
  sourceImageId: z.number().int().positive().nullish(),
  generationParams: z.unknown().nullish(),
  status: z.enum(Model3DStatus).optional(),
  nsfw: z.boolean().optional(),
  unlisted: z.boolean().optional(),
  tagIds: z.array(z.number().int().positive()).optional(),
  // Free-form tag names — created on the fly server-side under
  // TagTarget.Model3D and attached. Mirrors article upsert tag handling.
  tagNames: z.array(z.string().trim().min(1).max(50)).optional(),
  lockedProperties: z.array(z.string()).optional(),
  meta: z.unknown().nullish(),
});

export type GetModel3DByIdInput = z.infer<typeof getModel3DByIdSchema>;
export const getModel3DByIdSchema = z.object({
  id: z.number().int().positive(),
});

export type GetModel3DByWorkflowIdInput = z.infer<typeof getModel3DByWorkflowIdSchema>;
export const getModel3DByWorkflowIdSchema = z.object({
  workflowId: z.string().min(1),
});

export type EnsureModel3DFromWorkflowInput = z.infer<typeof ensureModel3DFromWorkflowSchema>;
export const ensureModel3DFromWorkflowSchema = z.object({
  workflowId: z.string().min(1),
});

export type GetModel3DsInfiniteInput = z.infer<typeof getModel3DsInfiniteSchema>;
export const getModel3DsInfiniteSchema = infiniteQuerySchema
  .extend({
    query: z.string().optional(),
    userId: z.number().int().positive().optional(),
    username: z.string().optional(),
    status: z.enum(Model3DStatus).optional(),
    statuses: z.array(z.enum(Model3DStatus)).optional(),
    tagIds: z.array(z.number().int().positive()).optional(),
    includeDrafts: z.boolean().optional(),
    sort: z
      .enum(Object.values(Model3DSort) as [Model3DSort, ...Model3DSort[]])
      .optional(),
    period: z.enum(MetricTimeframe).optional(),
    // PolyGen `enableAnimation` toggle — JSON check on `Model3D.generationParams`.
    // The Meshy API binds rigging to animation, so the previous standalone
    // `rigged` filter is gone (any leftover `?rigged=` in the URL is ignored).
    animated: z.boolean().optional(),
    // Mod/owner-only: show only not-yet-rated (nsfwLevel 0) models so mods can
    // find and rate them. Ignored for viewers who can't see unrated content.
    unrated: z.boolean().optional(),
  })
  .merge(baseQuerySchema);

export type GetModel3DTagsInput = z.infer<typeof getModel3DTagsSchema>;
export const getModel3DTagsSchema = z.object({
  // Optional filter to narrow the dropdown of "popular Model3D tags".
  query: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
});

export type PublishModel3DInput = z.infer<typeof publishModel3DSchema>;
export const publishModel3DSchema = z.object({
  id: z.number().int().positive(),
});

export type UnpublishModel3DInput = z.infer<typeof unpublishModel3DSchema>;
export const unpublishModel3DSchema = z.object({
  id: z.number().int().positive(),
});

export type DeleteModel3DInput = z.infer<typeof deleteModel3DSchema>;
export const deleteModel3DSchema = z.object({
  id: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

export type SetModel3DNsfwLevelInput = z.infer<typeof setModel3DNsfwLevelSchema>;
export const setModel3DNsfwLevelSchema = z.object({
  id: z.number().int().positive(),
  nsfwLevel: z.number().int().min(0),
  // When true, also append `'nsfwLevel'` to lockedProperties so the batch
  // nsfwLevel recompute job skips this row.
  lock: z.boolean().optional(),
});

export type ToggleModel3DFlagInput = z.infer<typeof toggleModel3DFlagSchema>;
export const toggleModel3DFlagSchema = z.object({
  id: z.number().int().positive(),
  field: z.enum(['tosViolation', 'poi', 'minor', 'nsfw', 'unlisted']),
});

export type RestoreModel3DInput = z.infer<typeof restoreModel3DSchema>;
export const restoreModel3DSchema = z.object({
  id: z.number().int().positive(),
});

export type GetModel3DFilesInput = z.infer<typeof getModel3DFilesSchema>;
export const getModel3DFilesSchema = z.object({
  id: z.number().int().positive(),
});

export type TrackModel3DDownloadInput = z.infer<typeof trackModel3DDownloadSchema>;
export const trackModel3DDownloadSchema = z.object({
  id: z.number().int().positive(),
});

// Public lookup used by the image viewers to surface the "Posted to 3D
// Model" chip — given an image's postId, returns the linked `model3dId` (or
// null when the post isn't tied to a Model3D). Cheap single-column read.
export type GetModel3DByPostIdInput = z.infer<typeof getModel3DByPostIdSchema>;
export const getModel3DByPostIdSchema = z.object({
  postId: z.number().int().positive(),
});

export type GetModel3DRelatedPostsInput = z.infer<typeof getModel3DRelatedPostsSchema>;
export const getModel3DRelatedPostsSchema = z.object({
  model3dId: z.number().int().positive(),
  limit: z.number().int().min(1).max(50).default(12),
  cursor: z.number().int().positive().optional(),
});

export type GetModel3DReviewSummaryInput = z.infer<typeof getModel3DReviewSummarySchema>;
export const getModel3DReviewSummarySchema = z.object({
  model3dId: z.number().int().positive(),
});

// Gallery moderation — creator/mod hide images, users, tags from the
// per-Model3D community gallery. Shape mirrors `model.updateGallerySettings`
// but without a version dimension.
export type Model3DGallerySettingsSchema = {
  users?: number[] | undefined;
  tags?: number[] | undefined;
  images?: number[] | undefined;
};

export type UpdateModel3DGallerySettingsInput = z.infer<
  typeof updateModel3DGallerySettingsSchema
>;
export const updateModel3DGallerySettingsSchema = z.object({
  id: z.number().int().positive(),
  gallerySettings: z
    .object({
      hiddenUsers: z
        .object({ id: z.number(), username: z.string().nullable() })
        .array(),
      hiddenTags: z.object({ id: z.number(), name: z.string() }).array(),
      hiddenImages: z.number().int().positive().array(),
    })
    .nullable(),
});

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export type UpsertModel3DReviewInput = z.infer<typeof upsertModel3DReviewSchema>;
export const upsertModel3DReviewSchema = z.object({
  id: z.number().int().positive().optional(),
  model3dId: z.number().int().positive(),
  recommended: z.boolean().default(true),
  details: z.string().nullish(),
  // Optional Post for image attachments — Post.model3dReviewId @unique.
  postId: z.number().int().positive().nullish(),
});

export type GetModel3DReviewsInput = z.infer<typeof getModel3DReviewsSchema>;
export const getModel3DReviewsSchema = paginationSchema.extend({
  model3dId: z.number().int().positive(),
  username: z.string().optional(),
  hasDetails: z.boolean().optional(),
});

export type DeleteModel3DReviewInput = z.infer<typeof deleteModel3DReviewSchema>;
export const deleteModel3DReviewSchema = z.object({
  id: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

// Local copy of the report discriminated union, omitting the `type` field —
// the service routes to the right child table directly via the Prisma relation
// so workstream C's `ReportEntity` enum extension is not required to land
// reports against `Model3DReport` / `Model3DReviewReport`.
const reportBase = z.object({
  id: z.number().int().positive(),
});

export const createModel3DReportSchema = z.discriminatedUnion('reason', [
  reportBase.extend({
    reason: z.literal(ReportReason.NSFW),
    details: reportNsfwDetailsSchema,
  }),
  reportBase.extend({
    reason: z.literal(ReportReason.TOSViolation),
    details: reportTosViolationDetailsSchema,
  }),
  reportBase.extend({
    reason: z.literal(ReportReason.Ownership),
    details: reportOwnershipDetailsSchema,
  }),
  reportBase.extend({
    reason: z.literal(ReportReason.Claim),
    details: reportClaimDetailsSchema,
  }),
  reportBase.extend({
    reason: z.literal(ReportReason.AdminAttention),
    details: reportAdminAttentionDetailsSchema,
  }),
  reportBase.extend({
    reason: z.literal(ReportReason.CSAM),
    details: z.object({ comment: z.string().optional() }).default({}),
  }),
  reportBase.extend({
    reason: z.literal(ReportReason.Spam),
    details: reportSpamDetailsSchema,
  }),
  reportBase.extend({
    reason: z.literal(ReportReason.Automated),
    details: reportAutomatedDetailsSchema,
  }),
]);
export type CreateModel3DReportInput = z.infer<typeof createModel3DReportSchema>;

// Same shape, distinct type — semantically different "id" target.
export const createModel3DReviewReportSchema = createModel3DReportSchema;
export type CreateModel3DReviewReportInput = z.infer<typeof createModel3DReviewReportSchema>;
