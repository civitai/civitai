import * as z from 'zod';

export const workflowIdSchema = z.object({
  workflowId: z.string(),
});

export type WorkflowUpdateSchema = z.infer<typeof workflowUpdateSchema>;
export const workflowUpdateSchema = workflowIdSchema.extend({
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

// The orchestrator charges for some top-level fields (`/allowMatureContent` is the yellow-Buzz
// unlock, which must go through `updateWorkflow`'s guards), and it matches field names
// case-insensitively.
const workflowMetadataPointer = z
  .string()
  .regex(/^\/metadata(\/|$)/i, 'Workflow patches may only change /metadata');

export type PatchWorkflowParams = z.infer<typeof patchWorkflowSchema>;
export const patchWorkflowSchema = z.object({
  workflowId: z.string(),
  patches: jsonPatchSchema
    .extend({ path: workflowMetadataPointer, from: workflowMetadataPointer.optional() })
    .array(),
});

// Step patch paths are relative; the router roots them under the step's /metadata.
export type PatchWorkflowStepParams = z.infer<typeof patchWorkflowStepSchema>;
export const patchWorkflowStepSchema = z.object({
  workflowId: z.string(),
  stepName: z.string(),
  patches: jsonPatchSchema.array(),
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
