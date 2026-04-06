import * as z from 'zod';

export const workflowIdSchema = z.object({
  workflowId: z.string(),
});

export type WorkflowUpdateSchema = z.infer<typeof workflowUpdateSchema>;
export const workflowUpdateSchema = workflowIdSchema.extend({
  metadata: z.record(z.string(), z.any()).optional(),
  allowMatureContent: z.boolean().optional(),
});

export type WorkflowQuerySchema = z.input<typeof workflowQuerySchema>;
export const workflowQuerySchema = z.object({
  take: z.number().default(20),
  cursor: z.string().optional(),
  tags: z.string().array().default([]),
  ascending: z.boolean().optional(),
  fromDate: z.date().optional(),
  toDate: z.date().optional(),
  excludeFailed: z.boolean().optional(),
});

export const workflowResourceSchema = z.object({
  id: z.number(),
  strength: z.number().default(1),
  epochNumber: z.number().optional(),
  air: z.string().optional(),
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
      z.record(z.string(), z.unknown()),
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
