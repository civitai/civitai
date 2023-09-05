import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { createTrainingRequest } from '~/server/services/training.service';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

export const resubmitTrainingJobs = createJob(
  'resubmit-training-jobs',
  UNRUNNABLE_JOB_CRON,
  async () => {
    // Get the training jobs that have failed
    // --------------------------------------------
    const failedTrainingJobs = await dbWrite.$queryRaw<
      { id: number; trainingStatus: string; metadata: FileMetadata | null; userId: number }[]
    >`
      SELECT
        mv.id,
        mv."trainingStatus",
        mf.metadata,
        m."userId"
      FROM "ModelVersion" mv
      JOIN "Model" m ON m.id = mv."modelId"
      JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
      WHERE mv."trainingStatus" in ('Failed', 'Processing', 'Submitted')
      AND m.status != 'Deleted';
    `;

    // Resubmit the training jobs
    // --------------------------------------------
    for (const { id, trainingStatus, metadata, userId } of failedTrainingJobs) {
      if (trainingStatus === 'Failed') {
        const attempts = metadata?.trainingResults?.attempts;
        if (!!attempts && attempts < 3) {
          await createTrainingRequest({ modelVersionId: id, userId });
        }
      } else {
        const jobHistory = metadata?.trainingResults?.history?.slice(-1);
        if (jobHistory && jobHistory.length) {
          const jobToken = jobHistory[0].jobToken;
          const response = await fetch(`${env.GENERATION_ENDPOINT}/v1/consumer/jobs/${jobToken}`, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${env.ORCHESTRATOR_TOKEN}`,
            },
          });
          if (response.status === 404) {
            await createTrainingRequest({ modelVersionId: id, userId });
          }
        }
      }
    }
  }
);
