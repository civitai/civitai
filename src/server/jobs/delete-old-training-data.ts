import { TrainingStatus } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { createTrainingRequest } from '~/server/services/training.service';
import { createJob } from './job';

export const deleteOldTrainingData = createJob(
  'delete-old-training-data',
  '5 13 * * *',
  async () => {
    const oldTraining = await dbWrite.$queryRaw<
      { id: number; metadata: FileMetadata | null; userId: number }[]
    >`
        SELECT mv.id,
               mf.metadata,
               m."userId"
        FROM "ModelVersion" mv
          JOIN "Model" m ON m.id = mv."modelId"
          JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
        WHERE mv."trainingStatus" in ('InReview', 'Approved')
          AND mf.metadata -> 'trainingResults' ->> 'end_time'
    `;

    for (const { id, metadata, userId } of oldTraining) {
      const endTime = metadata?.trainingResults?.end_time;

      if (endTime) {
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
