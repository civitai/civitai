import { ReportReason } from '@prisma/client';
import { z } from 'zod';

export const getByIdSchema = z.object({ id: z.number() });
export type GetByIdInput = z.infer<typeof getByIdSchema>;

export const reportInputSchema = z.object({
  id: z.number(),
  reason: z.nativeEnum(ReportReason),
});
export type ReportInput = z.infer<typeof reportInputSchema>;

export const getAllQuerySchema = z.object({
  limit: z.number(),
  query: z.string(),
});
