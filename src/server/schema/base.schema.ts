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
  limit: z.preprocess((val) => Number(val), z.number().min(0).max(200).default(20)),
  page: z.preprocess((val) => Number(val), z.number().min(1)),
  query: z.string(),
});
export type GetAllSchema = z.infer<typeof getAllQuerySchema>;
