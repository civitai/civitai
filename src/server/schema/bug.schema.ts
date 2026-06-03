import * as z from 'zod';
import { infiniteQuerySchema } from '~/server/schema/base.schema';
import { DomainColor } from '~/shared/utils/prisma/enums';

export const domainColorEnum = z.enum(DomainColor);

export type GetBugsInput = z.infer<typeof getBugsInput>;
export const getBugsInput = infiniteQuerySchema.extend({
  limit: z.number().min(1).max(200).optional().default(30),
  sortDir: z.enum(['asc', 'desc']).optional().default('desc'),
  search: z.string().optional(),
  statuses: z.string().array().optional(),
  includeClosed: z.boolean().optional().default(false),
  tags: z.string().array().optional(),
  domain: domainColorEnum.optional(),
});

export type CreateBugInput = z.infer<typeof createBugInput>;
export const createBugInput = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  content: z.string().optional(),
  status: z.string().min(1).default('Open'),
  clickupUrl: z.url().optional().or(z.literal('')),
  publishedAt: z.date().optional().nullable(),
  tags: z.string().array().optional(),
  disabled: z.boolean().optional().default(false),
  domain: z.array(domainColorEnum).nonempty().default([DomainColor.all]),
});

export type UpdateBugInput = z.infer<typeof updateBugInput>;
export const updateBugInput = createBugInput.partial().extend({
  id: z.number(),
});

export type DeleteBugInput = z.infer<typeof deleteBugInput>;
export const deleteBugInput = z.object({
  id: z.number(),
});

export type ReportBugInput = z.infer<typeof reportBugInput>;
export const reportBugInput = z.object({
  bugId: z.number(),
});

export type GetBugByIdInput = z.infer<typeof getBugByIdInput>;
export const getBugByIdInput = z.object({
  id: z.number(),
});

export type GetBugReportStatsInput = z.infer<typeof getBugReportStatsInput>;
export const getBugReportStatsInput = z.object({
  bugIds: z.number().int().positive().array().min(1).max(200),
});
