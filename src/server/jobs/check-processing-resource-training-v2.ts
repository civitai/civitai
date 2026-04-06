import { TrainingStatus } from '~/shared/utils/prisma/enums';
import { env } from 'process';
import { updateTrainingWorkflowRecords } from '~/server/services/training.service';
import { dbRead } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getWorkflowIdFromModelVersion } from '~/server/services/model-version.service';
import { getWorkflow } from '~/server/services/orchestrator/workflows';
import { createJob } from './job';
import { createLogger } from '~/utils/logging';
import { chunk } from 'lodash-es';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';

const log = createLogger('check-processing-resource-training');

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
    if (!env.ORCHESTRATOR_ACCESS_TOKEN) return;

    const processingVersions = await dbRead.modelVersion.findMany({
      where: {
        trainingStatus: {
          in: [TrainingStatus.Processing, TrainingStatus.Submitted],
        },
      },
      select: { id: true },
    });

    const tasks = chunk(processingVersions, 10).map((versions, i) => async () => {
      log(`Processing ${i + 1} of ${tasks.length}`);

      for (const modelVersion of versions) {
        const workflowId = await getWorkflowIdFromModelVersion({ id: modelVersion.id });
        if (!workflowId) continue;

        try {
          const workflow = await getWorkflow({
            token: env.ORCHESTRATOR_ACCESS_TOKEN as string,
            path: { workflowId },
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
              workflowId,
            },
          });
        }
      }

      log(`Updated ${i + 1} of ${tasks.length} :: done`);
    });
    await limitConcurrency(tasks, 5);
  }
);
