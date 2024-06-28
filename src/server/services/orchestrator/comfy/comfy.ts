import { ComfyStepTemplate } from '@civitai/client';

export async function createComfyStep() {
  const step: ComfyStepTemplate = { $type: 'comfy', input: { comfyWorkflow: {} } };
}
