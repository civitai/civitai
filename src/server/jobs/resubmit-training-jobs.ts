import { TrainingStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { createTrainingRequest } from '~/server/services/training.service';
import { createJob } from './job';

// this is actually 3, but it's 0 indexed
const MAX_ATTEMPTS = 2;

export const resubmitTrainingJobs = createJob(
  'resubmit-training-jobs',
  '20,50 * * * *',
  async () => {
    // Get the training jobs that are potentially stuck
    // --------------------------------------------
    const failedTrainingJobs = await dbWrite.$queryRaw<
      { id: number; metadata: FileMetadata | null; userId: number }[]
    >`
        SELECT mv.id,
               mf.metadata,
               m."userId"
        FROM "ModelVersion" mv
                 JOIN "Model" m ON m.id = mv."modelId"
                 JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
        WHERE mv."trainingStatus" in ('Processing', 'Submitted')
          AND m.status != 'Deleted';
    `;

    // Resubmit the training jobs
    // --------------------------------------------
    for (const { id, metadata, userId } of failedTrainingJobs) {
      const attempts = metadata?.trainingResults?.attempts;
      if (!!attempts && attempts > MAX_ATTEMPTS) {
        continue;
      }
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
          try {
            await createTrainingRequest({ modelVersionId: id, userId });
          } catch (error) {
            const message = error instanceof TRPCError ? error.message : `${error}`;
            console.error(`Failed to resubmit training job for model version ${id}: ${message}`);
            dbWrite.modelVersion.update({
              where: { id: id },
              data: {
                trainingStatus: TrainingStatus.Failed,
              },
            });
          }
        }
      }
    }
  }
);
