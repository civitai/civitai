import * as z from 'zod';
import { env } from '~/env/server';
import { updateTrainingWorkflowRecords } from '~/server/services/training.service';
import { logToAxiom } from '~/server/logging/client';
import { getWorkflowIdFromModelVersion } from '~/server/services/model-version.service';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';

const schema = z.object({
  modelVersionId: z.coerce.number(),
});

const logWebhook = (data: MixedObject) => {
  logToAxiom(
    {
      name: 'resource-training-v2-api',
      type: 'error',
      ...data,
    },
    'webhooks'
  ).catch();
};

export default ModEndpoint(async (req, res) => {
  const bodyResults = schema.safeParse(req.query);
  if (!bodyResults.success) {
    logWebhook({
      message: 'Could not parse body',
      data: { error: bodyResults.error, body: JSON.stringify(req.query) },
    });
    return res.status(400).json({ ok: false, error: bodyResults.error });
  }

  const { modelVersionId } = bodyResults.data;
  const workflowId = await getWorkflowIdFromModelVersion({ id: modelVersionId });

  try {
    if (!workflowId) {
      throw new Error('Workflow not found');
    }

    const workflow = await getWorkflow({
      token: env.ORCHESTRATOR_ACCESS_TOKEN,
      path: { workflowId: workflowId as string },
    });

    await updateTrainingWorkflowRecords(workflow, workflow.status ?? 'preparing');
  } catch (e: unknown) {
    const err = e as Error | undefined;
    logWebhook({
      message: 'Failed to update record',
      data: {
        error: err?.message,
        cause: err?.cause,
        stack: err?.stack,
        modelVersionId,
        workflowId,
      },
    });
    return res.status(500).json({ ok: false, error: err?.message, workflowId, modelVersionId });
  }

  return res.status(200).json({ ok: true });
});
