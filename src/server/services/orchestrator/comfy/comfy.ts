import { ComfyStepTemplate } from '@civitai/client';
import { SessionUser } from 'next-auth';
import { z } from 'zod';
import { textToImageCreateSchema } from '~/server/schema/orchestrator/textToImage.schema';

export async function createComfyStep({
  resources,
  user,
  token,
  workflowKey,
  ...params
}: z.infer<typeof textToImageCreateSchema> & { user: SessionUser; token: string }) {
  const step: ComfyStepTemplate = { $type: 'comfy', input: { comfyWorkflow: {} } };
}
