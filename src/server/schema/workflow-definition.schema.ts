import { z } from 'zod';

export type CreateWorkflowDefinitionSchema = z.infer<typeof createWorkflowDefinitionSchema>;
export const createWorkflowDefinitionSchema = z.object({
  type: z.enum(['image', 'video']),
  label: z.string(),
  description: z.string().optional(),
  index: z.number(),
  key: z.string(),
  toolId: z.number().optional(),
  disabled: z.boolean().optional(),
  message: z.string().optional(),
});

export type UpdateWorkflowDefinitionSchema = z.infer<typeof updateWorkflowDefinitionSchema>;
export const updateWorkflowDefinitionSchema = createWorkflowDefinitionSchema.partial().extend({
  id: z.number(),
});
