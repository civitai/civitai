import { ReportReason, ReportStatus } from '@prisma/client';
import { z } from 'zod';

const baseSchema = z.object({ id: z.number() });

export const reportNsfwSchema = baseSchema.extend({
  reason: z.literal(ReportReason.NSFW),
  status: z.nativeEnum(ReportStatus).default(ReportStatus.Valid),
});

export const reportTOSViolationSchema = baseSchema.extend({
  reason: z.literal(ReportReason.TOSViolation),
  status: z.nativeEnum(ReportStatus).default(ReportStatus.Pending),
});

export const reportOwnershipDetailsSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  phone: z.string().optional(),
  comment: z.string().optional(),
  images: z.string().array(),
  establishInterest: z.boolean().optional(),
});

export const reportOwnershipSchema = baseSchema.extend({
  reason: z.literal(ReportReason.Ownership),
  status: z.nativeEnum(ReportStatus).default(ReportStatus.Pending),
  details: reportOwnershipDetailsSchema,
});

export type ModelReportInput = z.infer<typeof modelReportInputSchema>;
export const modelReportInputSchema = z.discriminatedUnion('reason', [
  reportNsfwSchema,
  reportTOSViolationSchema,
  reportOwnershipSchema,
]);

export const reviewReportInputSchema = z.discriminatedUnion('reason', [
  reportNsfwSchema,
  reportTOSViolationSchema,
]);

export const commentReportInputSchema = z.discriminatedUnion('reason', [
  reportNsfwSchema,
  reportTOSViolationSchema,
]);
