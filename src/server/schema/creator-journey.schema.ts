import * as z from 'zod';

export type LegendStatusInput = z.infer<typeof legendStatusSchema>;
export const legendStatusSchema = z.object({ userId: z.number().int().positive() });

export type FirstPublishCardInput = z.infer<typeof firstPublishCardSchema>;
export const firstPublishCardSchema = z.object({
  entityType: z.enum(['model', 'article']),
  id: z.number().int().positive(),
});
