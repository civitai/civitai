import { TrainingStatus } from '@prisma/client';
import { isEmpty } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { trainingCompleteEmail } from '~/server/email/templates';
import { trainingFailEmail } from '~/server/email/templates/trainingFail.email';
import { logToAxiom } from '~/server/logging/client';
import { refundTransaction } from '~/server/services/buzz.service';
import { createTrainingRequest } from '~/server/services/training.service';
import { withRetries } from '~/server/utils/errorHandling';
import { getOrchestratorCaller } from '../http/orchestrator/orchestrator.caller';
import { createJob, getJobDate } from './job';

const SUBMITTED_CHECK_INTERVAL = 10;
const PROCESSING_CHECK_INTERVAL = 45;
const REJECTED_CHECK_INTERVAL = 4 * 60;

const logJob = (data: MixedObject) => {
  logToAxiom({ name: 'handle-long-trainings', type: 'error', ...data }, 'webhooks').catch();
};

type JobStatus =
  | { status: 'Failed' }
  | {
      status: 'Succeeded' | 'Deleted' | 'Canceled' | 'Expired' | 'Processing' | 'Rejected';
      date: Date;
    };
const failedState: JobStatus = { status: 'Failed' };

async function getJobStatus(jobId: string, submittedAt: Date, log: (message: string) => void) {
  function fail(message: string) {
    log(message);
    return failedState;
  }

  const eventResp = await getOrchestratorCaller(submittedAt).getEventById({
    id: jobId,
    descending: true,
    take: 1,
  });
  if (!eventResp.ok) return fail(`Couldn't fetch events for job`);

  const eventData = eventResp.data;
  if (!eventData) return fail(`Couldn't parse JSON events for job`);
  if (!eventData.length) return fail(`No event history for job`);

  const { type: status, dateTime: date } = eventData[0];
  if (!status || !date) return fail(`Couldn't grab latest type/date for job`);

  return { status, date: new Date(date) } as JobStatus;
}

async function handleJob({
  modelFileId,
  modelVersionId,
  modelId,
  modelName,
  userEmail,
  userUsername,
  status,
  jobId,
  transactionId,
  submittedAt,
}: TrainingRunResult) {
  if (!jobId) {
    log(`No job ID`);
    return await requeueTraining();
  }

  const job = await getJobStatus(jobId, submittedAt, log);
  if (job.status === 'Succeeded') {
    // Ensure we have our epochs...
    const ready = await hasEpochs();
    if (ready) {
      log(`Job status is ${job.status} - succeeding.`);
      await updateStatus('InReview');
      await trainingCompleteEmail.send({
        model: { id: modelId, name: modelName },
        user: { email: userEmail, username: userUsername },
      });
      return true;
    }

    // If we don't have epochs, we need to fail...
    log(`No epochs`);
    (job as JobStatus).status = 'Failed';
  }

  if (
    job.status === 'Failed' ||
    job.status === 'Deleted' ||
    job.status === 'Canceled' ||
    job.status === 'Expired'
  ) {
    log(`Job status is ${job.status} - failing.`);
    await updateStatus('Failed');
    return await refund();
  }

  const jobUpdated = job.date.getTime();
  const minsDiff = (new Date().getTime() - jobUpdated) / (1000 * 60);

  if (job.status === 'Rejected') {
    if (minsDiff > REJECTED_CHECK_INTERVAL) {
      log(`Job stuck in Rejected status - failing`);
      await updateStatus('Failed');
      return await refund();
    }
  }

  // we could put || status === 'Processing' here, but let's leave it out for now
  if (status === 'Submitted') {
    // - if it's not in the queue after 10 minutes, resubmit it
    if (minsDiff > SUBMITTED_CHECK_INTERVAL) {
      const queueResponse = await getOrchestratorCaller(submittedAt).getJobById({ id: jobId });
      // If we found it in the queue, we're good
      if (
        queueResponse.ok &&
        queueResponse.data?.serviceProviders &&
        !isEmpty(queueResponse.data?.serviceProviders)
      )
        return true;

      // Otherwise, resubmit it
      log(`Could not fetch position in queue - resubmitting.`);
      getOrchestratorCaller(submittedAt).deleteJobById({ id: jobId }).catch();
      await requeueTraining();
    }
  }

  if (status === 'Processing') {
    // - if it hasn't gotten an update in a while, mark failed
    if (minsDiff > PROCESSING_CHECK_INTERVAL) {
      log(`Have not received an update in allotted time (${minsDiff} mins) - failing.`);
      await updateStatus('Failed');
      return await refund();
    }
  }

  return true;

  //#region helper functions
  function log(message: string) {
    logJob({
      message,
      data: {
        jobId,
        modelFileId,
        important: true,
      },
    });
  }

  async function requeueTraining() {
    try {
      log(`Resubmitting training request`);
      // TODO need userId here?
      await createTrainingRequest({ modelVersionId });
      log(`Resubmitted training request`);
      return true;
    } catch (e) {
      return log(`Error resubmitting training request`);
    }
  }

  async function refund() {
    try {
      await trainingFailEmail.send({
        model: { id: modelId, name: modelName },
        user: { email: userEmail, username: userUsername },
      });
    } catch {
      log('Could not send failure email.');
    }

    if (!transactionId) {
      log(`No transaction ID - need to manually refund.`);
      return;
    }

    log(`Refunding transaction`);
    try {
      await withRetries(async () =>
        refundTransaction(transactionId, 'Refund due to a long-running/failed training job.')
      );
    } catch (e) {
      log(`Error refunding transaction - need to manually refund.`);
      return;
    }
    log(`Refunded transaction`);

    return true;
  }

  async function hasEpochs() {
    const [{ requested, last }] = await dbWrite.$queryRaw<
      {
        requested: number | null;
        last: number | null;
      }[]
    >`
      SELECT (mv."trainingDetails" -> 'params' ->> 'maxTrainEpochs')::int                 requested,
             (mf.metadata -> 'trainingResults' -> 'epochs' -> -1 ->> 'epoch_number')::int last
      FROM "ModelFile" mf
             JOIN "ModelVersion" mv on mf."modelVersionId" = mv.id
      WHERE mf.id = ${modelFileId};
    `;
    return requested === last && !!requested;
  }

  async function updateStatus(status: TrainingStatus) {
    await dbWrite.modelVersion.update({
      where: { id: modelVersionId },
      data: { trainingStatus: status, updatedAt: new Date() },
    });
    log(`Updated training status to ${status}`);
  }

  //#endregion
}

type TrainingRunResult = {
  modelFileId: number;
  modelVersionId: number;
  modelId: number;
  modelName: string;
  userEmail: string;
  userUsername: string;
  updated: string;
  status: TrainingStatus;
  jobId: string | null;
  transactionId: string | null;
  submittedAt: Date;
};

export const handleLongTrainings = createJob('handle-long-trainings', `*/10 * * * *`, async () => {
  const [lastRun, setLastRun] = await getJobDate('handle-long-trainings');
  const oldTraining = await dbWrite.$queryRaw<TrainingRunResult[]>`
    SELECT mf.id               as                                                      "modelFileId",
           mv.id               as                                                      "modelVersionId",
           m.id                as                                                      "modelId",
           m.name              as                                                      "modelName",
           u.email             as                                                      "userEmail",
           u.username          as                                                      "userUsername",
           mv."trainingStatus" as                                                      status,
           COALESCE(mf."metadata" -> 'trainingResults' ->> 'jobId',
                    mf."metadata" -> 'trainingResults' -> 'history' -> -1 ->> 'jobId') "jobId",
           mf."metadata" -> 'trainingResults' ->> 'transactionId'                      "transactionId",
           COALESCE(COALESCE(mf."metadata" -> 'trainingResults' ->> 'submittedAt',
                             mf."metadata" -> 'trainingResults' -> 'history' -> 0 ->>
                             'time')::timestamp,
                    mv."updatedAt"
           )                                                                           "submittedAt"
    FROM "ModelVersion" mv
           JOIN "ModelFile" mf ON mv.id = mf."modelVersionId"
           JOIN "Model" m ON m.id = mv."modelId"
           JOIN "User" u ON m."userId" = u.id
    WHERE mf.type = 'Training Data'
      AND m."uploadType" = 'Trained'
      AND mv."trainingStatus" in ('Processing', 'Submitted')
      -- Hasn't had a recent update
      AND mv."updatedAt" between '10/16/2023' and ${lastRun}
    --  AND ((mf.metadata -> 'trainingResults' -> 'start_time')::TEXT)::TIMESTAMP < (now() - interval '24 hours')
    ORDER BY 1 desc;
  `;

  if (oldTraining.length === 0) {
    logJob({
      type: 'info',
      message: `No long running jobs to process.`,
    });
    await setLastRun();
    return { status: 'ok' };
  }

  logJob({
    type: 'info',
    message: `Found long running jobs to process`,
    data: { count: oldTraining.length },
  });

  let successes = 0;
  for (const training of oldTraining) {
    try {
      const success = await handleJob(training);
      if (success === true) successes += 1;
    } catch (e) {
      logJob({
        message: `Error handling job`,
        data: {
          error: (e as Error)?.message,
          cause: (e as Error)?.cause,
          jobId: training.jobId,
          modelFileId: training.modelFileId,
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

  await setLastRun();
  return { status: 'ok', successes, total: oldTraining.length };
});
