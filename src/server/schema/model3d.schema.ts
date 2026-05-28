import * as z from 'zod';
import { Model3DStatus, ReportReason } from '~/shared/utils/prisma/enums';
import {
  baseQuerySchema,
  infiniteQuerySchema,
  paginationSchema,
} from '~/server/schema/base.schema';
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
  })
  .merge(baseQuerySchema);

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

export type GetModel3DFilesInput = z.infer<typeof getModel3DFilesSchema>;
export const getModel3DFilesSchema = z.object({
  id: z.number().int().positive(),
});

export type GetModel3DByThumbnailImageIdInput = z.infer<typeof getModel3DByThumbnailImageIdSchema>;
export const getModel3DByThumbnailImageIdSchema = z.object({
  imageId: z.number().int().positive(),
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

// ---------------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------------

export type UpsertModel3DReviewInput = z.infer<typeof upsertModel3DReviewSchema>;
export const upsertModel3DReviewSchema = z.object({
  id: z.number().int().positive().optional(),
  model3dId: z.number().int().positive(),
  rating: z.number().int().min(1).max(5),
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
