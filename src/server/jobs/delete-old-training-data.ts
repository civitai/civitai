import { ModelFileVisibility } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { deleteAssets } from '~/server/services/training.service';
import { deleteObject, parseKey } from '~/utils/s3-utils';
import { createJob } from './job';

//  TODO [bw] this is handling two different schemas, new and old, for job.
//    all the history references can be taken out ~11/26/23

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'delete-old-training-data', type: 'error', ...data }, 'webhooks').catch();
};

export const deleteOldTrainingData = createJob(
  'delete-old-training-data',
  '5 13 * * *',
  async () => {
    const oldTraining = await dbWrite.$queryRaw<
      {
        mf_id: number;
        history: NonNullable<FileMetadata['trainingResults']>['history'];
        jobId: NonNullable<FileMetadata['trainingResults']>['jobId'];
        visibility: ModelFileVisibility;
        url: string;
      }[]
    >`
      SELECT mf.id                                         as mf_id,
             mf.metadata -> 'trainingResults' -> 'history' as history,
             mf.metadata -> 'trainingResults' -> 'jobId'   as jobId,
             mf.visibility,
             mf.url
      FROM "ModelVersion" mv
             JOIN "Model" m ON m.id = mv."modelId"
             JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
      WHERE m."uploadType" = 'Trained'
        AND mv."trainingStatus" in ('InReview', 'Approved')
        AND (timezone('utc', current_timestamp) -
             (mf.metadata -> 'trainingResults' ->> 'end_time')::timestamp) > '30 days'
        AND mf."dataPurged" is not true
    `;

    if (oldTraining.length === 0) {
      logJob({
        type: 'info',
        message: `No job assets to delete`,
      });
      return { status: 'ok' };
    }

    logJob({
      type: 'info',
      message: `Found jobs`,
      data: { count: oldTraining.length },
    });

    let goodJobs = 0;
    let errorJobs = 0;
    for (const { mf_id, history, jobId, visibility, url } of oldTraining) {
      let hasError = false;

      if (!!jobId) {
        try {
          const result = await deleteAssets(jobId);
          if (!result || !result.total) {
            hasError = true;
          }
        } catch (e) {
          hasError = true;
          logJob({
            message: `Delete assets error`,
            data: {
              error: (e as Error)?.message,
              cause: (e as Error)?.cause,
              jobId: jobId,
              modelFileId: mf_id,
            },
          });
        }
      } else {
        const seenJobs: string[] = [];
        if (history) {
          for (const h of history) {
            const { jobId: histJobId } = h;
            if (!histJobId) continue;
            if (!seenJobs.includes(histJobId)) {
              try {
                const result = await deleteAssets(histJobId);
                if (!result || !result.total) {
                  hasError = true;
                }
                seenJobs.push(histJobId);
              } catch (e) {
                hasError = true;
                logJob({
                  message: `Delete assets error`,
                  data: {
                    error: (e as Error)?.message,
                    cause: (e as Error)?.cause,
                    jobId: jobId,
                    modelFileId: mf_id,
                  },
                });
              }
            }
          }
        }
      }

      if (visibility !== ModelFileVisibility.Public) {
        const { key, bucket } = parseKey(url);
        try {
          await deleteObject(bucket, key);
        } catch (e) {
          hasError = true;
          logJob({
            message: `Delete object error`,
            data: {
              error: (e as Error)?.message,
              cause: (e as Error)?.cause,
              jobId: jobId,
              modelFileId: mf_id,
              key,
              bucket,
            },
          });
        }
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
    logJob({
      type: 'info',
      message: `Finished`,
      data: { successes: goodJobs, failures: errorJobs },
    });

    return { status: 'ok' };
  }
);
