import { TrainingStatus } from '@prisma/client';
import { env } from 'process';
import { updateRecords } from '~/pages/api/webhooks/resource-training-v2';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getWorkflowIdFromModelVersion } from '~/server/services/model-version.service';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { createJob } from './job';

const logWebhook = (data: MixedObject) => {
  logToAxiom(
    {
      name: 'resource-training-v2-cron',
      type: 'error',
      ...data,
    },
    'webhooks'
  ).catch();
};

export const checkProcessingResourceTrainingV2 = createJob(
  'check-processing-resource-training-v2',
  '3 * * * *',
  async () => {
    if (!env.ORCHESTRATOR_ACCESS_TOKEN) {
      return;
    }

    const processingVersions = await dbRead.modelVersion.findMany({
      where: {
        trainingStatus: {
          in: [TrainingStatus.Processing, TrainingStatus.Paused, TrainingStatus.Submitted],
        },
      },
      select: {
        id: true,
      },
    });

    for (const modelVersion of processingVersions) {
      const workflowId = await getWorkflowIdFromModelVersion({ id: modelVersion.id });

      if (!workflowId) {
        continue;
      }

      try {
        const workflow = await getWorkflow({
          token: env.ORCHESTRATOR_ACCESS_TOKEN,
          path: { workflowId },
        });

        await updateRecords(workflow);
      } catch (e: unknown) {
        const err = e as Error | undefined;
        logWebhook({
          message: 'Failed to update record',
          data: {
            error: err?.message,
            cause: err?.cause,
            stack: err?.stack,
            workflowId,
          },
        });
      }
    }
  }
);
