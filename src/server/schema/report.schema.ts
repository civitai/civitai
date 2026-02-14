import type { MantineColor } from '@mantine/core';
import * as z from 'zod';
import { MAX_APPEAL_MESSAGE_LENGTH } from '~/server/common/constants';
import { ExternalModerationType } from '~/server/common/enums';
import { getAllQuerySchema } from '~/server/schema/base.schema';
import { AppealStatus, EntityType, ReportReason, ReportStatus } from '~/shared/utils/prisma/enums';

export enum ReportEntity {
  Model = 'model',
  Comment = 'comment',
  CommentV2 = 'commentV2',
  Image = 'image',
  ResourceReview = 'resourceReview',
  Article = 'article',
  Post = 'post',
  User = 'reportedUser',
  Collection = 'collection',
  Bounty = 'bounty',
  BountyEntry = 'bountyEntry',
  Chat = 'chat',
  ComicProject = 'comicProject',
}

// #region [report reason detail schemas]
const baseDetailSchema = z.object({ comment: z.string().optional() });

export const reportNsfwDetailsSchema = baseDetailSchema.extend({
  tags: z.string().array().optional(),
});

export const reportOwnershipDetailsSchema = baseDetailSchema.extend({
  name: z.string(),
  email: z.string().email(),
  phone: z.string().optional(),
  images: z.string().array(),
  establishInterest: z.boolean().optional(),
});

export const reportTosViolationDetailsSchema = baseDetailSchema.extend({
  violation: z.string(),
});

export const reportClaimDetailsSchema = baseDetailSchema.extend({
  email: z.string().email(),
});

export const reportAdminAttentionDetailsSchema = baseDetailSchema.extend({
  reason: z.string(),
});

export const reportAutomatedDetailsSchema = baseDetailSchema.extend({
  externalId: z.string(),
  externalType: z.enum(ExternalModerationType),
  entityId: z.number(),
  tags: z.array(z.string()),
  // tags: z.array(
  //   z.object({
  //     tag: z.string(),
  //     confidence: z.number(),
  //     outcome: z.string(), // z.enum(Outcome), // but this causes errors
  //     message: z.string().optional(),
  //   })
  // ),
  userId: z.number(),
  value: z.string().optional(),
});
// #endregion

// #region [report reason schemas]
const baseSchema = z.object({
  type: z.enum(ReportEntity),
  id: z.number(),
  details: baseDetailSchema.default({}),
});

export const reportNsfwSchema = baseSchema.extend({
  reason: z.literal(ReportReason.NSFW),
  details: reportNsfwDetailsSchema,
});

export const reportTOSViolationSchema = baseSchema.extend({
  reason: z.literal(ReportReason.TOSViolation),
  details: reportTosViolationDetailsSchema,
});

export const reportOwnershipSchema = baseSchema.extend({
  reason: z.literal(ReportReason.Ownership),
  details: reportOwnershipDetailsSchema,
});

export const reportClaimSchema = baseSchema.extend({
  reason: z.literal(ReportReason.Claim),
  details: reportClaimDetailsSchema,
});

export const reportAdminAttentionSchema = baseSchema.extend({
  reason: z.literal(ReportReason.AdminAttention),
  details: reportAdminAttentionDetailsSchema,
});

export const reportCsamSchema = baseSchema.extend({
  reason: z.literal(ReportReason.CSAM),
});

export const reportAutomatedSchema = baseSchema.extend({
  reason: z.literal(ReportReason.Automated),
  details: reportAutomatedDetailsSchema,
});

// #endregion

export type CreateReportInput = z.infer<typeof createReportInputSchema>;
export const createReportInputSchema = z.discriminatedUnion('reason', [
  reportNsfwSchema,
  reportTOSViolationSchema,
  reportOwnershipSchema,
  reportClaimSchema,
  reportAdminAttentionSchema,
  reportCsamSchema,
  reportAutomatedSchema,
]);

export type SetReportStatusInput = z.infer<typeof setReportStatusSchema>;
export const setReportStatusSchema = z.object({
  id: z.number(),
  status: z.enum(ReportStatus),
});

export type BulkUpdateReportStatusInput = z.infer<typeof bulkUpdateReportStatusSchema>;
export const bulkUpdateReportStatusSchema = z.object({
  ids: z.number().array(),
  status: z.enum(ReportStatus),
});

export type GetReportsInput = z.infer<typeof getReportsSchema>;
export const getReportsSchema = getAllQuerySchema.extend({
  type: z.enum(ReportEntity),
  filters: z
    .object({
      id: z.string(),
      value: z.unknown(),
    })
    .array()
    .optional(),
  sort: z
    .object({
      id: z.string(),
      desc: z.boolean(),
    })
    .array()
    .optional(),
});

export type GetReportCountInput = z.infer<typeof getReportCount>;
export const getReportCount = z.object({
  type: z.enum(ReportEntity),
  statuses: z.enum(ReportStatus).array(),
});

export const reportStatusColorScheme: Record<ReportStatus, MantineColor> = {
  [ReportStatus.Unactioned]: 'green',
  [ReportStatus.Actioned]: 'red',
  [ReportStatus.Processing]: 'orange',
  [ReportStatus.Pending]: 'yellow',
};

export type UpdateReportSchema = z.infer<typeof updateReportSchema>;
export const updateReportSchema = z.object({
  id: z.number(),
  status: z.enum(ReportStatus),
  internalNotes: z.string().nullish(),
});

export type CreateEntityAppealInput = z.output<typeof createEntityAppealSchema>;
export const createEntityAppealSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(EntityType),
  message: z.string().trim().min(1).max(MAX_APPEAL_MESSAGE_LENGTH),
});

export type GetRecentAppealsInput = z.output<typeof getRecentAppealsSchema>;
export const getRecentAppealsSchema = z.object({
  userId: z.number().optional(),
  startDate: z.date().optional(),
});

export type GetAppealDetailsInput = z.output<typeof getAppealDetailsSchema>;
export const getAppealDetailsSchema = z.object({
  entityId: z.number(),
  entityType: z.enum(EntityType),
  userId: z.number(),
});

export type ResolveAppealInput = z.output<typeof resolveAppealSchema>;
export const resolveAppealSchema = z.object({
  ids: z.number().array().min(1),
  entityType: z.enum(EntityType),
  status: z.enum(AppealStatus),
  resolvedMessage: z.string().trim().max(MAX_APPEAL_MESSAGE_LENGTH).optional(),
  internalNotes: z.string().trim().optional(),
});
