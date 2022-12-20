import { ReportReason } from '@prisma/client';
import { z } from 'zod';

export enum ReportEntity {
  Model,
  Review,
  Comment,
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
  violation: z.string().array(),
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

export type ReportInput = z.infer<typeof reportInputSchema>;
export const reportInputSchema = z.discriminatedUnion('reason', [
  reportNsfwSchema,
  reportTOSViolationSchema,
  reportOwnershipSchema,
  reportClaimSchema,
  reportAdminAttentionSchema,
]);
