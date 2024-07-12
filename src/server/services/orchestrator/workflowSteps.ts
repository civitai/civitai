import { deepOmit } from '~/utils/object-helpers';
import {
  $OpenApiTs,
  getWorkflowStep as clientGetWorkflowStep,
  updateWorkflowStep,
} from '@civitai/client';

import { createOrchestratorClient } from '~/server/services/orchestrator/common';
import { UpdateWorkflowStepParams } from '~/server/services/orchestrator/orchestrator.schema';

export async function getWorkflowStep({
  token,
  path,
}: $OpenApiTs['/v2/consumer/workflows/{workflowId}/steps/{stepName}']['get']['req'] & {
  token: string;
}) {
  const client = createOrchestratorClient(token);
  const { data } = await clientGetWorkflowStep({ client, path });
  if (!data) throw new Error('failed to get workflow step');
  return data;
}

export async function updateWorkflowSteps({
  input,
  token,
}: {
  input: UpdateWorkflowStepParams[];
  token: string;
}) {
  const client = createOrchestratorClient(token);

  // console.dir(input, { depth: null });

  await Promise.all(
    input.map(async ({ workflowId, stepName, metadata }) => {
      // console.dir(
      //   {
      //     body: { metadata: deepOmit(metadata) },
      //     path: {
      //       workflowId,
      //       stepName,
      //     },
      //   },
      //   { depth: null }
      // );
      await updateWorkflowStep({
        client,
        body: { metadata: deepOmit(metadata) },
        path: {
          workflowId,
          stepName,
        },
      });
    })
  );
}
