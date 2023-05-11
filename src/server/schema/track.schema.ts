import { z } from 'zod';

export const addViewSchema = z.object({
  type: z.enum([
    'ProfileView',
    'ImageView',
    'PostView',
    'ModelView',
    'ModelVersionView',
    'ArticleView',
  ]),
  entityType: z.enum(['User', 'Image', 'Post', 'Model', 'ModelVersion', 'Article']),
  entityId: z.number(),
});

export type AddViewSchema = z.infer<typeof addViewSchema>;
