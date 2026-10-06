import * as z from 'zod';

export type FirstPublishCardInput = z.infer<typeof firstPublishCardSchema>;
export const firstPublishCardSchema = z.object({
  entityType: z.enum(['model', 'article']),
  id: z.number().int().positive(),
});
