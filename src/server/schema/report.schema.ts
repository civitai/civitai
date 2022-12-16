import { Prisma, ReportReason } from '@prisma/client';
import { z } from 'zod';

export const ownershipReportInputSchema = z.object({
  name: z.string(),
  email: z.string().email(),
  phone: z.string().optional(),
  comment: z.string().optional(),
  images: z.string().array().optional(),
  establishInterest: z.boolean().optional(),
});

// TODO - figure out if it's possible to do a merge (duplicate props)
export const modelReportInputSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal(ReportReason.NSFW), id: z.number() }),
  z.object({ reason: z.literal(ReportReason.TOSViolation), id: z.number() }),
  z.object({
    reason: z.literal(ReportReason.Ownership),
    id: z.number(),
    details: ownershipReportInputSchema,
    // .transform((arg) => arg as Prisma.JsonObject),
  }),
]);
export type ModelReportInput = z.input<typeof modelReportInputSchema>;
export type ModelReportOutput = z.infer<typeof modelReportInputSchema>;
