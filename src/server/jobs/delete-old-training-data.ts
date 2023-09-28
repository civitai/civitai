import { ModelFileVisibility } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { deleteAssets } from '~/server/services/training.service';
import { deleteObject, parseKey } from '~/utils/s3-utils';
import { createJob } from './job';

export const deleteOldTrainingData = createJob(
  'delete-old-training-data',
  '5 13 * * *',
  async () => {
    const oldTraining = await dbWrite.$queryRaw<
      {
        mf_id: number;
        history: NonNullable<FileMetadata['trainingResults']>['history'];
        visibility: ModelFileVisibility;
        url: string;
      }[]
    >`
        SELECT
          mf.id as mf_id,
          mf.metadata -> 'trainingResults' -> 'history' as history,
          mf.visibility,
          mf.url
      FROM "ModelVersion" mv
          JOIN "Model" m ON m.id = mv."modelId"
          JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
      WHERE
          m."uploadType" = 'Trained'
          AND mv."trainingStatus" in ('InReview', 'Approved')
          AND (timezone('utc', current_timestamp) - (mf.metadata -> 'trainingResults' ->> 'end_time')::timestamp) > '30 days'
          AND mf."dataPurged" is not true
    `;

    console.log(`DeleteOldTrainingData :: found ${oldTraining.length} jobs`);

    let goodJobs = 0;
    let errorJobs = 0;
    for (const { mf_id, history, visibility, url } of oldTraining) {
      let hasError = false;

      const seenJobs: string[] = [];
      if (history) {
        for (const h of history) {
          const { jobId } = h;
          if (!seenJobs.includes(jobId)) {
            try {
              const result = await deleteAssets(jobId);
              if (!result || !result.total) {
                hasError = true;
              }
              seenJobs.push(jobId);
            } catch (e) {
              hasError = true;
              console.error(e);
            }
          }
        }
      }

      if (visibility !== ModelFileVisibility.Public) {
        const { key, bucket } = parseKey(url);
        await deleteObject(bucket, key);
      }

      if (!hasError) {
        await dbWrite.modelFile.update({
          where: { id: mf_id },
          data: {
            dataPurged: true,
          },
        });
        goodJobs += 1;
      } else {
        errorJobs += 1;
      }
    }
    console.log(
      `DeleteOldTrainingData :: finished. successes: ${goodJobs}, failures: ${errorJobs}`
    );
    return { status: 'ok' };
  }
);
