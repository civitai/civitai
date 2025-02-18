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
  epochNumber: z.number().optional(),
});

export const jsonPatchSchema = z.object({
  op: z.enum(['add', 'remove', 'replace', 'move', 'copy', 'test']),
  path: z.string(),
  from: z.string().optional(),
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.record(z.unknown()),
      z.unknown().array(),
      z.null(),
    ])
    .optional(),
});

export type TagsPatchSchema = z.infer<typeof tagsPatchSchema>;
export const tagsPatchSchema = z.object({
  workflowId: z.string(),
  tag: z.string(),
  op: z.enum(['add', 'remove']),
});

export type PatchWorkflowParams = z.infer<typeof patchWorkflowSchema>;
export const patchWorkflowSchema = z.object({
  workflowId: z.string(),
  patches: jsonPatchSchema.array(),
});

export type PatchWorkflowStepParams = z.infer<typeof patchWorkflowStepSchema>;
export const patchWorkflowStepSchema = patchWorkflowSchema.extend({
  stepName: z.string(),
});

// export const deleteSchema = z.object({
//   workflowId: z.string(),
//   stepName: z.string().optional(),
// });

export const patchSchema = z.object({
  workflows: patchWorkflowSchema.array().optional(),
  steps: patchWorkflowStepSchema.array().optional(),
  tags: tagsPatchSchema.array().optional(),
  remove: z.string().array().optional(),
});
