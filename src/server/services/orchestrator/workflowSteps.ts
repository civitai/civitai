import type { GetWorkflowStepData, Options } from '@civitai/client';
import { getWorkflowStep as clientGetWorkflowStep, patchWorkflowStep } from '@civitai/client';

import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import type { PatchWorkflowStepParams } from '~/server/schema/orchestrator/workflows.schema';

export async function getWorkflowStep({
  token,
  path,
}: Options<GetWorkflowStepData> & {
  token: string;
}) {
  const client = createOrchestratorClient(token);
  const { data } = await clientGetWorkflowStep({ client, path });
  if (!data) throw new Error('failed to get workflow step');
  return data;
}

export async function patchWorkflowSteps({
  input,
  token,
}: {
  input: PatchWorkflowStepParams[];
  token: string;
}) {
  const client = createOrchestratorClient(token);
  await Promise.all(
    input.map(async ({ workflowId, stepName, patches }) => {
      await patchWorkflowStep({ client, body: patches, path: { stepName, workflowId } });
    })
  );
}
