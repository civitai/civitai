import { z } from 'zod';
import { textToImageStepMetadataSchema } from '~/server/schema/orchestrator/textToImage.schema';

// #region [workflow steps]
export type WorkflowStepType = z.infer<typeof workflowStepType>;
export const workflowStepType = z.enum(['textToImage']);

export type WorkflowStepMetadata = z.infer<typeof workflowStepMetadataSchema>;
const workflowStepMetadataSchema = z.discriminatedUnion('$type', [textToImageStepMetadataSchema]);

export type UpdateWorkflowStepParams = z.infer<typeof updateWorkflowStepSchema>;
export const updateWorkflowStepSchema = z.object({
  workflowId: z.string(),
  stepName: z.string(),
  metadata: workflowStepMetadataSchema,
});
// #endregion
