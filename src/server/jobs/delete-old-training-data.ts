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
 * When the caller's FIRST retry of a day's trigger arrives — the only moment the lock below has to
 * survive.
 *
 * The external scheduler holds the trigger request open under a client-side timeout and retries a
 * fixed number of times when that fires. Observed in production over several consecutive days: the
 * request is abandoned just under an hour in, and the next attempt POSTs about a minute later.
 *
 * 🔴 WHY THE **FIRST** RETRY AND NOT THE LAST, WHICH IS THE INTUITIVE ANSWER AND IS WRONG. Today
 * four attempts run per trigger, so it is tempting to size against the whole ladder. But a retry
 * that finds the lock held gets `{ ok: true, error: 'Job already running' }` with status **200**,
 * and the caller treats a 2xx as success — so that retry does not fail, and a caller that did not
 * fail does not retry again. **The first suppressed retry ENDS the ladder.** Sizing against the
 * last of four is sizing against attempts that only exist while the bug does.
 *
 * Exported so the lock below is sized against something checkable instead of being a bare literal.
 *
 * 🔴 THIS IS A PROPERTY OF THE SCHEDULER'S CONFIGURATION, NOT OF THIS JOB. Raising that
 * client-side timeout moves this moment later, and the lock has to be re-argued rather than
 * silently left behind.
 */
export const DELETE_OLD_TRAINING_DATA_FIRST_RETRY_SECONDS = 60 * 60;

/**
 * How long this job may hold its run lock, overriding `createJob`'s five-minute default.
 *
 * WHY AN OVERRIDE AT ALL. This job walks the whole outstanding set of expired training-data files
 * serially — one object delete plus one row update per file, each awaited — and no pass has been
 * observed to finish inside the caller's timeout. At the inherited 300s the lock lapses a few
 * minutes in, so each of the caller's retries acquires it and starts a second, third and fourth
 * concurrent pass over the same rows, re-issuing deletes the earlier passes are still working
 * through. That is not hypothetical: it is the steady state this constant was added to end.
 *
 * 🔴 THE PROPERTY THIS FIX ACTUALLY RESTS ON, NAMED BECAUSE NO VALUE HERE CAN SUPPLY IT. The route
 * releases the lock in a `finally`, so the hold is `min(pass duration, this value, pod lifetime)` —
 * this number can shorten a hold, never extend one past the end of the run. The fix therefore works
 * only if THE PASS IS STILL RUNNING when the first retry POSTs. That is measured, not assumed:
 * every attempt observed ran the full timeout and was cut by the caller rather than finishing, and
 * the next attempt POSTs about a minute after the cut. If this job ever becomes fast enough to
 * finish inside the caller's timeout, the lock stops being the mitigation and stops being needed —
 * in that order. Do not read a large value here as covering that case; nothing here covers it.
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
 * WHY THIS VALUE. The floor is the first retry's POST, above: hold the lock through that one
 * moment and the ladder ends there. Six hours is six times it — deliberately far more than the
 * floor needs, for a reason worth stating plainly, because the obvious framing of "headroom
 * against uncertainty" would be false:
 *
 * 🔴 BETWEEN THE FLOOR AND THE CRON PERIOD THE COST OF A LONGER HOLD IS FLAT, NOT RISING. Once the
 * first retry has been answered 200 the caller is done for the day, so NOTHING POSTS again until
 * the next tick 24h later: a hold of two hours and a hold of six block exactly the same set of
 * requests, namely none. The only caller a longer hold can turn away is a human triggering the job
 * by hand, and `?noCheck=true` bypasses the lock outright. So the value is chosen at the top of the
 * flat region rather than the bottom — it absorbs a `WebhookTimeoutMinutes` raised several-fold
 * without anyone having to remember this file. ⚠ An earlier draft of this block asserted the
 * opposite — that a longer hold costs more because an alive-but-wedged run holds it longer. That is
 * false here for the same reason: the wedged run's day has no further caller to block. Do not
 * re-derive it.
 *
 * The ceiling is the cron period, and that one is real: stay well below 24h so a hold can never
 * reach the next SCHEDULED run. (A pod that dies pays nothing either way — the redis key carries a
 * ~10s TTL refreshed by an in-process interval, so a dead pod's lock lapses within seconds. Which
 * also means a jobs-pod roll inside the window frees the lock and re-enables the ladder for that
 * day; on a fleet shipping several releases a day, expect the occasional day of partial effect.
 * See `JobOptions.keepLockOnDisconnect`.)
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
