import { z } from 'zod';

export const workflowIdSchema = z.object({
  workflowId: z.string(),
});

export const workflowQuerySchema = z.object({
  take: z.number().default(10),
  cursor: z.string().optional(),
  jobType: z.string().array().optional(),
});
