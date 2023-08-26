import { createJob, UNRUNNABLE_JOB_CRON } from './job';
import { dbWrite } from '~/server/db/client';
import { createTrainingRequestSecure } from '~/server/services/training.service';

export const resubmitTrainingJobs = createJob(
  'resubmit-training-jobs',
  UNRUNNABLE_JOB_CRON,
  async () => {
    // Get the training jobs that have failed
    // --------------------------------------------
    const failedTrainingJobs = await dbWrite.$queryRaw<{ id: number; userId: number }[]>`
    SELECT
      mv.id,
      m."userId"
    FROM "ModelVersion" mv
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE mv."trainingStatus" IN ('Submitted', 'Failed')
  `;

    // Resubmit the training jobs
    // --------------------------------------------
    for (const { id, userId } of failedTrainingJobs) {
      await createTrainingRequestSecure({ modelVersionId: id, userId });
    }
  }
);
