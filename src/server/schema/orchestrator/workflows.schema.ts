import { z } from 'zod';

export const workflowIdSchema = z.object({
  workflowId: z.string(),
});

export const workflowUpdateSchema = workflowIdSchema.extend({
  metadata: z.record(z.any()),
});

export const workflowQuerySchema = z.object({
  take: z.number().default(10),
  cursor: z.string().optional(),
  tags: z.string().array().optional(),
});

export const workflowResourceSchema = z.object({
  id: z.number(),
  strength: z.number().default(1),
});
