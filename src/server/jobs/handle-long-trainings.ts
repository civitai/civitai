import { TrainingStatus } from '@prisma/client';
import { isEmpty } from 'lodash-es';
import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { refundTransaction } from '~/server/services/buzz.service';
import { withRetries } from '~/server/utils/errorHandling';
import { createJob } from './job';

const minutesPerRun = 10;

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'handle-long-trainings', type: 'error', ...data }, 'webhooks').catch();
};

const _handleJob = async (
  mf_id: number,
  mv_id: number,
  updated: string,
  status: TrainingStatus,
  job_id: string | null,
  transaction_id: string | null
) => {
  if (!job_id) {
    logJob({
      message: `No jobId present`,
      data: {
        jobId: job_id,
        modelFileId: mf_id,
        important: true,
      },
    });
    return;
  }

  const eventResp = await fetch(
    `${env.GENERATION_ENDPOINT}/v1/producer/jobs/${job_id}/events?descending=true&take=1`,
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.ORCHESTRATOR_TOKEN}`,
      },
    }
  );

  if (!eventResp.ok) {
    logJob({
      message: `Couldn't fetch events for job`,
      data: {
        jobId: job_id,
        modelFileId: mf_id,
        important: true,
      },
    });
    return;
  }

  let eventData: { type?: string; dateTime?: string }[] = [];
  try {
    eventData = await eventResp.json();
  } catch (e) {
    logJob({
      message: `Couldn't parse JSON events for job`,
      data: {
        error: (e as Error)?.message,
        cause: (e as Error)?.cause,
        jobId: job_id,
        modelFileId: mf_id,
        important: true,
      },
    });
    return;
  }

  if (!eventData.length) {
    logJob({
      message: `No event history for job`,
      data: {
        jobId: job_id,
        modelFileId: mf_id,
        important: true,
      },
    });
    return;
  }

  const { type: jobType, dateTime: jobDate } = eventData[0];

  if (!jobType || !jobDate) {
    // Q: should we consider this and the above checks as "failed"?
    logJob({
      message: `Couldn't grab latest type/date for job`,
      data: {
        jobId: job_id,
        modelFileId: mf_id,
        important: true,
      },
    });
    return;
  }

  // nb: we should really be updating the history too, but...it's annoying
  if (jobType === 'Succeeded') {
    await dbWrite.modelVersion.update({
      where: { id: mv_id },
      data: { trainingStatus: 'InReview' },
    });
    return true;
  } else if (['Failed', 'Deleted', 'Expired'].includes(jobType)) {
    await dbWrite.modelVersion.update({
      where: { id: mv_id },
      data: { trainingStatus: 'Failed' },
    });

    if (!transaction_id) {
      logJob({
        message: `No transaction ID - need to manually refund.`,
        data: {
          jobId: job_id,
          modelFileId: mf_id,
          important: true,
        },
      });
      return;
    }
    await withRetries(async () =>
      refundTransaction(transaction_id, 'Refund due to a long-running/failed training job.')
    );

    return true;
  } else {
    const jobUpdated = new Date(jobDate).getTime();
    const minsDiff = (new Date().getTime() - jobUpdated) / (1000 * 60);
    if (status === 'Submitted') {
      // - if it's not in the queue after 10 minutes, resubmit it
      if (minsDiff > 10) {
        const queueResponse = await fetch(`${env.GENERATION_ENDPOINT}/v1/consumer/jobs/${job_id}`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.ORCHESTRATOR_TOKEN}`,
          },
        });
        if (!queueResponse.ok) {
          logJob({
            message: `Could not fetch position in queue.`,
            data: {
              jobId: job_id,
              modelFileId: mf_id,
              important: true,
            },
          });
          return;
        }

        const queueData: MixedObject = await queueResponse.json();
        if (!queueData?.serviceProviders || isEmpty(queueData.serviceProviders)) {
          logJob({
            message: `Not in queue, needs resubmission.`,
            data: {
              jobId: job_id,
              modelFileId: mf_id,
              important: true,
            },
          });
          return;
        }
        return true;
      }
    } else if (status === 'Processing') {
      // - if it hasn't gotten an update in 20 minutes, mark failed
      if (minsDiff > 20) {
        await dbWrite.modelVersion.update({
          where: { id: mv_id },
          data: { trainingStatus: 'Failed' },
        });

        if (!transaction_id) {
          logJob({
            message: `No transaction ID - need to manually refund.`,
            data: {
              jobId: job_id,
              modelFileId: mf_id,
              important: true,
            },
          });
          return;
        }
        await withRetries(async () =>
          refundTransaction(transaction_id, 'Refund due to a long-running/failed training job.')
        );
        return true;
      }
    }
  }

  return true;
};

export const handleLongTrainings = createJob(
  'handle-long-trainings',
  `*/${minutesPerRun} * * * *`,
  async () => {
    const oldTraining = await dbWrite.$queryRaw<
      {
        mf_id: number;
        mv_id: number;
        updated: string;
        status: TrainingStatus;
        job_id: string | null;
        transaction_id: string | null;
      }[]
    >`
    SELECT
      "ModelFile".id as mf_id,
      "ModelVersion".id as mv_id,
      "ModelVersion"."updatedAt" as updated,
      "ModelVersion"."trainingStatus" as status,
      COALESCE("ModelFile"."metadata" -> 'trainingResults' ->> 'jobId', "ModelFile"."metadata" -> 'trainingResults' -> 'history' -> -1 ->> 'jobId') job_id,
      "ModelFile"."metadata" -> 'trainingResults' ->> 'transactionId' transaction_id
    FROM "ModelVersion"
    JOIN "ModelFile" ON "ModelVersion".id = "ModelFile"."modelVersionId"
    JOIN "Model" ON "Model".id="ModelVersion"."modelId"
    WHERE "ModelFile".type = 'Training Data' AND "Model"."uploadType" = 'Trained'
    AND "ModelVersion"."trainingStatus" in ('Processing', 'Submitted')
    AND "ModelVersion"."updatedAt" between '10/16/2023' and now() - interval '${
      minutesPerRun - 1
    } minutes'
--           AND (("ModelFile".metadata -> 'trainingResults' -> 'start_time')::TEXT)::TIMESTAMP < (now() - interval '24 hours')
    ORDER BY mf_id desc;
    `;

    if (oldTraining.length === 0) {
      logJob({
        type: 'info',
        message: `No long running jobs to process.`,
      });
      return { status: 'ok' };
    }

    logJob({
      type: 'info',
      message: `Found long running jobs to process`,
      data: { count: oldTraining.length },
    });

    let successes = 0;
    for (const { mf_id, mv_id, updated, status, job_id, transaction_id } of oldTraining) {
      try {
        const success = await _handleJob(mf_id, mv_id, updated, status, job_id, transaction_id);
        if (success === true) successes += 1;
      } catch (e) {
        logJob({
          message: `Error handling job`,
          data: {
            error: (e as Error)?.message,
            cause: (e as Error)?.cause,
            jobId: job_id,
            modelFileId: mf_id,
            important: true,
          },
        });
      }
    }

    logJob({
      type: 'info',
      message: `Finished`,
      data: { successes, total: oldTraining.length },
    });

    return { status: 'ok', successes, total: oldTraining.length };
  }
);
