import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { refundTransaction } from '~/server/services/buzz.service';
import { withRetries } from '~/server/utils/errorHandling';
import { createJob } from './job';

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'handle-long-trainings', type: 'error', ...data }, 'webhooks').catch();
};

const _handleJob = async (
  jobId: string,
  mvId: number,
  mfId: number,
  transactionId: string | null
) => {
  const eventResp = await fetch(
    `${env.GENERATION_ENDPOINT}/v1/producer/jobs/${jobId}/events?descending=true&take=1`,
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
        jobId: jobId,
        modelFileId: mfId,
      },
    });
    return;
  }

  let eventData: { type?: string }[] = [];
  try {
    eventData = await eventResp.json();
  } catch (e) {
    logJob({
      message: `Couldn't parse JSON events for job`,
      data: {
        error: (e as Error)?.message,
        cause: (e as Error)?.cause,
        jobId: jobId,
        modelFileId: mfId,
      },
    });
    return;
  }

  if (!eventData.length) {
    logJob({
      message: `No event history for job`,
      data: {
        jobId: jobId,
        modelFileId: mfId,
      },
    });
    return;
  }

  const { type: jobType } = eventData[0];
  if (!jobType) {
    logJob({
      message: `Couldn't grab latest type for job`,
      data: {
        jobId: jobId,
        modelFileId: mfId,
      },
    });
    return;
  }

  // nb: we should really be updating the history too, but...it's annoying
  if (jobType === 'Succeeded') {
    await dbWrite.modelVersion.update({
      where: { id: mvId },
      data: {
        trainingStatus: 'InReview',
      },
    });
    return true;
  } else {
    if (!transactionId) {
      logJob({
        message: `ISSUE! No transaction ID - need to manually refund.`,
        data: {
          jobId: jobId,
          modelFileId: mfId,
        },
      });
      return;
    }
    await dbWrite.modelVersion.update({
      where: { id: mvId },
      data: {
        trainingStatus: 'Failed',
      },
    });
    await withRetries(async () =>
      refundTransaction(transactionId, 'Refund due to a long-running training job.')
    );

    return true;
  }
};

export const handleLongTrainings = createJob('handle-long-trainings', '15 * * * *', async () => {
  const oldTraining = await dbWrite.$queryRaw<
    {
      mf_id: number;
      mv_id: number;
      job_id: string;
      transaction_id: string | null;
    }[]
  >`
    SELECT
      "ModelFile".id as mf_id,
      "ModelVersion".id as mv_id,
      COALESCE("ModelFile"."metadata" -> 'trainingResults' ->> 'jobId', "ModelFile"."metadata" -> 'trainingResults' -> 'history' -> -1 ->> 'jobId') job_id,
      "ModelFile"."metadata" -> 'trainingResults' ->> 'transactionId' transaction_id
    FROM "ModelVersion"
    JOIN "ModelFile" ON "ModelVersion".id = "ModelFile"."modelVersionId"
    JOIN "Model" ON "Model".id="ModelVersion"."modelId"
    WHERE "ModelFile".type = 'Training Data' AND "Model"."uploadType" = 'Trained'
    AND "ModelVersion"."trainingStatus" = 'Processing'
    AND
      CASE
        WHEN ("ModelFile".metadata -> 'trainingResults' ->> 'start_time') IS NOT NULL THEN
          (("ModelFile".metadata -> 'trainingResults' -> 'start_time')::TEXT)::TIMESTAMP >= '10/16/2023'
          AND (("ModelFile".metadata -> 'trainingResults' -> 'start_time')::TEXT)::TIMESTAMP < (now() - interval '24 hours')
        ELSE FALSE
      END
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

  // for each row, query the transactionId in the system, check latest status
  // succeeded -> mark, failed/processing -> mark and refund

  let successes = 0;
  for (const { mf_id, mv_id, job_id, transaction_id } of oldTraining) {
    try {
      const success = await _handleJob(job_id, mv_id, mf_id, transaction_id);
      if (success === true) successes += 1;
    } catch (e) {
      logJob({
        message: `ISSUE! Error handling job`,
        data: {
          error: (e as Error)?.message,
          cause: (e as Error)?.cause,
          jobId: job_id,
          modelFileId: mf_id,
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
});
