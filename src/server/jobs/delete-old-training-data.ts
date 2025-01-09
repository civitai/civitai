import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { deleteObject, parseKey } from '~/utils/s3-utils';
import { createJob } from './job';

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'delete-old-training-data', type: 'error', ...data }, 'webhooks').catch();
};

type OldTrainingRow = {
  mf_id: number;
  job_id: string | null;
  url: string;
};

export const deleteOldTrainingData = createJob(
  'delete-old-training-data',
  '5 11 * * *',
  async () => {
    const oldTraining = await dbWrite.$queryRaw<OldTrainingRow[]>`
      SELECT mf.id                                        as mf_id,
             mf.metadata -> 'trainingResults' ->> 'jobId' as job_id,
             mf.url
      FROM "ModelVersion" mv
             JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
      WHERE mv."uploadType" = 'Trained'
        AND mv."trainingStatus" in ('InReview', 'Approved')
        AND (timezone('utc', current_timestamp) -
             (mf.metadata -> 'trainingResults' ->> 'completedAt')::timestamp) > '30 days'
        AND mf."dataPurged" is not true
        AND mf.visibility != 'Public'
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

    for (const { mf_id, job_id, url } of oldTraining) {
      const { key, bucket } = parseKey(url);
      if (bucket) {
        try {
          await deleteObject(bucket, key);

          try {
            await dbWrite.modelFile.update({
              where: { id: mf_id },
              data: {
                dataPurged: true,
              },
            });
            goodJobs += 1;
          } catch (e) {
            errorJobs += 1;
            logJob({
              message: `Update model file error`,
              data: {
                error: (e as Error)?.message,
                cause: (e as Error)?.cause,
                jobId: job_id,
                modelFileId: mf_id,
              },
            });
          }
        } catch (e) {
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
          errorJobs += 1;
        }
      } else {
        logJob({
          message: `Missing bucket`,
          data: {
            jobId: job_id,
            modelFileId: mf_id,
            key,
          },
        });
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
