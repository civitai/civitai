import { MantineColor } from '@mantine/core';
import { ReportReason, ReportStatus } from '@prisma/client';
import { z } from 'zod';
import { getAllQuerySchema } from '~/server/schema/base.schema';

export enum ReportEntity {
  Model = 'model',
  Review = 'review',
  Comment = 'comment',
  Image = 'image',
}

// #region [report reason detail schemas]
const baseDetailSchema = z.object({ comment: z.string().optional() });

export const reportNsfwDetailsSchema = baseDetailSchema;

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
// #endregion

// #region [report reason schemas]
const baseSchema = z.object({
  type: z.nativeEnum(ReportEntity),
  id: z.number(),
  details: baseDetailSchema,
});

export const reportNsfwSchema = baseSchema.extend({
  reason: z.literal(ReportReason.NSFW),
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
// #endregion

export type CreateReportInput = z.infer<typeof createReportInputSchema>;
export const createReportInputSchema = z.discriminatedUnion('reason', [
  reportNsfwSchema,
  reportTOSViolationSchema,
  reportOwnershipSchema,
  reportClaimSchema,
  reportAdminAttentionSchema,
]);

export type SetReportStatusInput = z.infer<typeof setReportStatusSchema>;
export const setReportStatusSchema = z.object({
  id: z.number(),
  status: z.nativeEnum(ReportStatus),
});

export type GetReportsInput = z.infer<typeof getReportsSchema>;
export const getReportsSchema = getAllQuerySchema.extend({
  type: z.nativeEnum(ReportEntity),
});

export type GetReportCountInput = z.infer<typeof getReportCount>;
export const getReportCount = z.object({
  type: z.nativeEnum(ReportEntity),
  statuses: z.nativeEnum(ReportStatus).array(),
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
  status: z.nativeEnum(ReportStatus),
  internalNotes: z.string().nullish(),
});
