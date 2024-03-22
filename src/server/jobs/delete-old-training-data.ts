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

type OldTrainingRow = {
  mf_id: number;
  history: NonNullable<FileMetadata['trainingResults']>['history'];
  job_id: NonNullable<FileMetadata['trainingResults']>['jobId'];
  submitted_at: Date;
  visibility: ModelFileVisibility;
  url: string;
};

export const deleteOldTrainingData = createJob(
  'delete-old-training-data',
  '5 13 * * *',
  async () => {
    const oldTraining = await dbWrite.$queryRaw<OldTrainingRow[]>`
      SELECT mf.id                                         as mf_id,
             mf.metadata -> 'trainingResults' -> 'history' as history,
             mf.metadata -> 'trainingResults' ->> 'jobId'  as job_id,
             COALESCE(COALESCE(mf.metadata -> 'trainingResults' ->> 'submittedAt',
                               mf.metadata -> 'trainingResults' -> 'history' -> 0 ->>
                               'time')::timestamp,
                      mv."updatedAt"
             )                                             as submitted_at,
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
    for (const { mf_id, history, job_id, submitted_at, visibility, url } of oldTraining) {
      let hasError = false;

      if (!!job_id) {
        try {
          const result = await deleteAssets(job_id, submitted_at);
          if (!result || !result.total) {
            hasError = true;
            logJob({
              message: `Delete assets result blank`,
              data: {
                jobId: job_id,
                modelFileId: mf_id,
                result: result,
              },
            });
          }
        } catch (e) {
          hasError = true;
          logJob({
            message: `Delete assets error`,
            data: {
              error: (e as Error)?.message,
              cause: (e as Error)?.cause,
              jobId: job_id,
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
                const result = await deleteAssets(histJobId, submitted_at);
                if (!result || !result.total) {
                  hasError = true;
                  logJob({
                    message: `Delete assets result blank`,
                    data: {
                      jobId: histJobId,
                      modelFileId: mf_id,
                      result: result,
                    },
                  });
                }
                seenJobs.push(histJobId);
              } catch (e) {
                hasError = true;
                logJob({
                  message: `Delete assets error`,
                  data: {
                    error: (e as Error)?.message,
                    cause: (e as Error)?.cause,
                    jobId: histJobId,
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
              jobId: job_id,
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
