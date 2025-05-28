import type { InfiniteData } from '@tanstack/react-query';
import { z } from 'zod';
import { generatedImageStepMetadataSchema } from '~/server/schema/orchestrator/textToImage.schema';

// #region [interfaces]
export interface IWorkflowStep {
  name: string;
  metadata?: Record<string, unknown>;
}

export interface IWorkflow {
  id: string;
  steps: IWorkflowStep[];
  tags: string[];
}

export type IWorkflowsInfinite = InfiniteData<{ items: IWorkflow[] }>;
// #endregion

// #region [workflow steps]
export type WorkflowStepType = z.infer<typeof workflowStepType>;
export const workflowStepType = z.enum(['textToImage']);

const baseUpdateWorkflowSchema = z.object({
  workflowId: z.string(),
  stepName: z.string(),
});

export type UpdateWorkflowStepParams = z.infer<typeof updateWorkflowStepSchema>;
export const updateWorkflowStepSchema = z.discriminatedUnion('$type', [
  baseUpdateWorkflowSchema.extend({
    $type: z.literal('textToImage'),
    metadata: generatedImageStepMetadataSchema,
  }),
  baseUpdateWorkflowSchema.extend({
    $type: z.literal('imageTraining'),
    metadata: z.record(z.any()),
  }),
]);
// #endregion
