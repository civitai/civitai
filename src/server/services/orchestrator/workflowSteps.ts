import { deepOmit } from '~/utils/object-helpers';
import { $OpenApiTs } from '@civitai/client';

import { OrchestratorClient } from '~/server/services/orchestrator/common';
import { UpdateWorkflowStepParams } from '~/server/services/orchestrator/orchestrator.schema';

export async function getWorkflowStep({
  token,
  ...params
}: $OpenApiTs['/v2/consumer/workflows/{workflowId}/steps/{stepName}']['get']['req'] & {
  token: string;
}) {
  const client = new OrchestratorClient(token);

  const step = await client.workflowSteps.getWorkflowStep(params);

  return step;
}

export async function updateWorkflowSteps({
  input,
  token,
}: {
  input: UpdateWorkflowStepParams[];
  token: string;
}) {
  const client = new OrchestratorClient(token);

  await Promise.all(
    input.map(({ workflowId, stepName, metadata }) =>
      client.workflowSteps.updateWorkflowStep({
        workflowId,
        stepName,
        requestBody: { metadata: deepOmit(metadata) },
      })
    )
  );
}
