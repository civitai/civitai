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

/**
 * Wall-clock span over which the caller's retries of ONE day's trigger can still arrive.
 *
 * The external scheduler holds the trigger request open under a client-side timeout and retries a
 * fixed number of times when that fires. Observed in production over several consecutive days: the
 * request is abandoned just under an hour in, three further attempts follow at roughly hourly
 * spacing, and the ladder is finished about four hours after the day's first trigger. The last
 * retry is therefore POSTed about three hours in — that POST is the latest moment at which a freed
 * lock can be claimed by a competing run of this job.
 *
 * Exported so the lock below is sized against something checkable instead of being a bare literal.
 *
 * 🔴 THIS IS A PROPERTY OF THE SCHEDULER'S CONFIGURATION, NOT OF THIS JOB. Raising that
 * client-side timeout or its retry count lengthens this ladder, and the lock has to be re-argued
 * rather than silently left behind.
 */
export const DELETE_OLD_TRAINING_DATA_RETRY_LADDER_SECONDS = 4 * 60 * 60;

/**
 * How long this job may hold its run lock, overriding `createJob`'s five-minute default.
 *
 * WHY AN OVERRIDE AT ALL. This job walks the whole outstanding set of expired training-data files
 * serially — one object delete plus one row update per file, each awaited — and no pass has been
 * observed to finish inside the caller's timeout. At the inherited 300s the lock lapses a few
 * minutes in, so each of the retries above acquires it and starts a second, third and fourth
 * concurrent pass over the same rows, re-issuing deletes the earlier passes are still working
 * through. That is not hypothetical: it is the steady state this constant was added to end.
 *
 * WHY IT DOES NOT WORK WITHOUT `keepLockOnDisconnect`. The run-jobs route's close handler releases
 * the lock the moment the caller hangs up (`createDisconnectHandler`). A pass that outlives the
 * caller's timeout loses its socket first and its lock with it, so the whole budget below is
 * discarded precisely in the case it was sized for. The two options are one mitigation; either one
 * alone leaves the duplicate passes exactly where they were.
 *
 * 🔴 AND DO NOT "COMPLETE" THIS BY WIRING `checkIfCanceled` INTO THE LOOP. The handler takes no
 * `jobContext` deliberately. A pass that outlives the caller's timeout finishes only because it
 * keeps running past the disconnect; a cancelling version would be killed at every attempt's
 * timeout and — on the evidence above, where no attempt has been seen to finish inside it — would
 * never complete a pass at all. Same reasoning as `process-csam.ts`.
 *
 * WHY THIS VALUE — BOTH DIRECTIONS.
 * The floor is the retry ladder: the lock has to still be held when the last retry POSTs, or that
 * retry starts the competing pass this exists to prevent. Six hours is 1.5× the ladder's full
 * wall-clock span, which is the least headroom the argument can be read as claiming.
 * The ceiling is the cron period. `keepLockOnDisconnect` makes a long hold a real cost — a run
 * that is alive but wedged now holds this lock for its full duration instead of losing it at the
 * disconnect — so the value stays a quarter of the 24h period, far enough below it that a wedged
 * run can never delay the next SCHEDULED run. (A pod that dies pays nothing either way: the redis
 * key carries a ~10s TTL refreshed by an in-process interval, so a dead pod's lock lapses within
 * seconds. See `JobOptions.keepLockOnDisconnect`.)
 *
 * 🔴 RESIDUAL, STATED SO IT IS NOT MISTAKEN FOR COVERED: a pass that outran the cron period would
 * overlap the NEXT day's run, and no value below that period can close that — a lock long enough
 * to cover it would also block legitimate daily runs. The fix for that case is bounding the work
 * done per pass, not growing this number.
 */
export const DELETE_OLD_TRAINING_DATA_LOCK_SECONDS = 6 * 60 * 60;

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
  },
  // Both of these, or neither: the lock has to be long enough to outlast the caller's retries AND
  // has to survive the disconnect that precedes them. See the two constants above for the sizing
  // argument and for what the held lock costs.
  {
    lockExpiration: DELETE_OLD_TRAINING_DATA_LOCK_SECONDS,
    keepLockOnDisconnect: true,
  }
);
