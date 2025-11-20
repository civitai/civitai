import { deepOmit } from '~/utils/object-helpers';
import type { GetWorkflowStepData, Options } from '@civitai/client';
import {
  getWorkflowStep as clientGetWorkflowStep,
  patchWorkflowStep,
  updateWorkflowStep,
} from '@civitai/client';

import { createOrchestratorClient } from '~/server/services/orchestrator/client';
import type { UpdateWorkflowStepParams } from '~/server/services/orchestrator/orchestrator.schema';
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

export async function updateWorkflowSteps({
  input,
  token,
}: {
  input: UpdateWorkflowStepParams[];
  token: string;
}) {
  const client = createOrchestratorClient(token);
  await Promise.all(
    input.map(async ({ workflowId, stepName, metadata }) => {
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
      // console.dir(JSON.stringify({ body: patches, path: { stepName, workflowId } }), {
      //   depth: null,
      // });
      await patchWorkflowStep({ client, body: patches, path: { stepName, workflowId } });
    })
  );
}
