import { z } from 'zod';

export const addViewSchema = z.object({
  type: z.enum(['ProfileView', 'ImageView', 'PostView', 'ModelView', 'ModelVersionView']),
  entityType: z.enum(['User', 'Image', 'Post', 'Model', 'ModelVersion']),
  entityId: z.number(),
});

export type AddViewSchema = z.infer<typeof addViewSchema>;
