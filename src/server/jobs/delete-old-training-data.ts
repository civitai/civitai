import { dbWrite } from '~/server/db/client';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { logToAxiom } from '~/server/logging/client';
import { deleteModelFileObject } from '~/utils/s3-utils';
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
 * When the caller ABANDONS the trigger request — the client-side timeout itself.
 *
 * The external scheduler holds the trigger request open under that timeout and retries a fixed
 * number of times when it fires. Observed in production over several consecutive days: the request
 * is abandoned just under an hour in, and the next attempt POSTs about a minute later.
 *
 * 🔴 THIS IS THE CUT, NOT THE RETRY'S POST, AND THE DIFFERENCE IS WHY THE FLOOR BELOW IS A MULTIPLE
 * RATHER THAN A BARE `>`. The moment that actually matters is the retry's POST, which lands at the
 * cut plus the caller's own retry backoff. That backoff is RANDOMISED, not fixed: about a minute
 * is what has been observed, and the band's low end is shorter. No literal is given for it here on
 * purpose — the floor below does not need one, and inventing one is how the last two drafts of
 * that argument went wrong.
 *
 * ⚠ THE CUT IS AN **UNDER**-ESTIMATE OF THAT MOMENT, WHICH FOR A FLOOR IS THE UNSAFE DIRECTION, NOT
 * THE SAFE ONE. An earlier draft of this paragraph called it "a conservative stand-in" — precisely
 * backwards, and self-refuting two lines later. A floor built from a quantity that is strictly
 * EARLIER than the moment it stands for under-constrains: `lock > cut` is satisfied by a lock one
 * second past the cut, which expires before the retry it exists to outlive. The cut is used anyway
 * because it is the one precisely-known quantity here (it is the configured timeout), but it is
 * used WITH a margin for exactly this reason, never on its own.
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
export const DELETE_OLD_TRAINING_DATA_CALLER_CUT_SECONDS = 60 * 60;

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
 * WHY THIS VALUE. The floor is the first retry's POST: hold the lock through that one moment and
 * the ladder ends there. Six hours is six times the caller's cut — deliberately far more than the
 * floor needs, for a reason worth stating plainly, because the obvious framing of "headroom
 * against uncertainty" would be false:
 *
 * 🔴 BETWEEN THE FLOOR AND THE CRON PERIOD THE COST OF A LONGER HOLD IS FLAT, NOT RISING. Once the
 * first retry has been answered 200 the caller is done for the day, so NOTHING POSTS again until
 * the next tick 24h later: a hold of two hours and a hold of six block exactly the same set of
 * requests, namely none. So the value is chosen at the top of the flat region rather than the
 * bottom — it absorbs a raised `WebhookTimeoutMinutes` without anyone having to remember this
 * file. ⚠ To be exact about what "absorbs" means here, because two drafts of this sentence got it
 * wrong in opposite directions: the answer is that there is NO silent headroom at all. The floor
 * case pins the cut to its own literal before comparing anything, so ANY change to
 * CALLER_CUT_SECONDS reds that test and sends the next person to this paragraph — which is the
 * intent. What the value buys is that the re-argument will usually end in "still fine", not that
 * it can be skipped. (The previous draft said a cut could be raised "as far as three hours"
 * without failing; measured, two hours reds the floor case on the pin. The draft before it said
 * "several-fold" and named no guard at all.) ⚠ An earlier draft of this block asserted the opposite
 * about cost — that a longer hold costs more because an alive-but-wedged run holds it longer. That
 * is false here for the same reason: the wedged run's day has no further caller to block. Do not
 * re-derive it.
 *
 * ⚠ ONE CALLER A LONG HOLD *DOES* TURN AWAY, corrected from an earlier draft of this block that
 * said the escape hatch covers it. A human re-triggering the job from the scheduler's dashboard
 * gets the 200 "Job already running" for as long as the hold lasts: the scheduler builds its
 * trigger URL with `run`, `wait` and its auth token only, so `noCheck` — which would bypass the
 * lock — is NOT on that path. It is reachable only by calling the webhook directly. That is a real
 * cost of a long hold; it is a cost to an OPERATOR retrying by hand, not to the schedule, which is
 * why it does not move the value.
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
 *
 * 🔴 WHAT THIS CHANGE TAKES AWAY, WHICH IS EASY TO MISS BECAUSE THE DUPLICATE PASSES LOOK LIKE PURE
 * WASTE. They are not purely wasteful in general: each pass re-runs the query, which filters on
 * `dataPurged is not true`, so a later pass skips what an earlier one finished and can make
 * net-new progress. Going from four passes a day to one therefore removes throughput in principle.
 * Measured before shipping this, it removes NONE in practice — every row currently eligible fails
 * its delete and none is ever marked purged, so all four passes achieve nothing and one pass
 * achieves the same nothing.
 *
 * 🔴 HOW TO RE-TEST THAT, BECAUSE A CLAIM WITH NO INSTRUMENT IS THE ONE THAT ROTS SILENTLY: take
 * this job's own eligibility predicate — the `WHERE` clause below, minus its `dataPurged` term —
 * and group it by `dataPurged`. Compare the newest `completedAt` in each arm. If the purged arm's
 * newest is far older than the unpurged arm's newest, nothing has been purged since that date and
 * the paragraph above still holds; if the two track each other, purging is working again and this
 * whole caveat is spent. (At the time of writing the purged arm's newest trailed the unpurged
 * arm's by months.) 🔴 THAT IS A STATEMENT ABOUT TODAY AND IT EXPIRES. Whoever repairs
 * the delete path must re-ask it, because from that moment a single serial pass per day is the
 * whole throughput: the walk is one awaited delete plus one awaited update per row, and a row
 * whose delete throws is never marked purged and so returns every day forever. If one pass cannot
 * clear a day's inflow the backlog grows monotonically and files outlive the retention this job
 * exists to enforce. `deleteManyObjects` already exists in `~/utils/s3-utils` and is the obvious
 * lever.
 *
 * ⚠ An earlier draft of this paragraph said "the query takes no `LIMIT`". It does now — see
 * DELETE_OLD_TRAINING_DATA_MAX_ROWS_PER_PASS, added in the same change that repaired the delete
 * path, 60-odd lines below the sentence that denied it.
 */
export const DELETE_OLD_TRAINING_DATA_LOCK_SECONDS = 6 * 60 * 60;

/**
 * How many files one pass may delete.
 *
 * 🔴 WHY A CAP EXISTS AT ALL, since the job ran uncapped for years: it ran uncapped while its
 * deletes were FAILING. The routing fix turns a large standing backlog from never-deleting into
 * deleting, and an S3 delete is not reversible on a demand from this job. An uncapped first pass
 * would therefore issue tens of thousands of irreversible deletes, unattended, on a path whose
 * behaviour has never once been observed working in production.
 *
 * ⚠ THE NUMBER IS A CHOICE, NOT A DERIVATION, and saying so is the point. It is a round number
 * picked so that a pass is bounded and the standing backlog drains over weeks rather than in one
 * night, which is what makes the drain READABLE: a capped pass gives a monotone decline you can
 * watch over several days, where one uncapped pass gives a single cliff that tells you nothing if
 * it went wrong. Nothing here derives it from a rate, and no rate has been measured that would.
 * `minor-hash-sweep.ts` caps its own destructive sweep the same way and for the same reason.
 *
 * 🔴 THE ARMING ORDER, WRITTEN DOWN BECAUSE TWO DEFAULT-OFF FLAGS THAT NOBODY RECORDS ARE A TRAP
 * RATHER THAN A SAFEGUARD. Both `training-data-purge` and `training-data-purge-dry-run` default
 * off, so turning ON only the purge goes straight to real deletes — the dry run cannot protect a
 * first pass unless it is turned on FIRST. The order is: dry-run on, purge on, read one night's
 * `Dry run, would delete` lines and the `eligibleTotal`, then dry-run off. Skipping a step is a
 * choice someone may make; not knowing there was a step is the failure this paragraph prevents.
 *
 * A consequence worth knowing rather than discovering: a capped pass finishes far inside the
 * caller's timeout, which is exactly the condition under which the run lock above stops being the
 * mitigation — see DELETE_OLD_TRAINING_DATA_LOCK_SECONDS, which says so in those words.
 */
export const DELETE_OLD_TRAINING_DATA_MAX_ROWS_PER_PASS = 2000;

export const deleteOldTrainingData = createJob(
  'delete-old-training-data',
  '5 11 * * *',
  async () => {
    // 🔴 DEFAULT-OFF KILL SWITCH, and default-off is the load-bearing half. `isFlipt` returns
    // false for an unknown flag OR an unreachable Flipt, so this job deletes nothing until
    // someone turns it on deliberately — which is what turns "the first release after merge
    // silently starts deleting" into "somebody flips it and watches". It also stays the only
    // stop button for the NEXT run that works WITHOUT a deploy, and that matters here
    // specifically: this app ships from a `release` branch on a cadence the person watching does
    // not control.
    //
    // ⚠ IT CANNOT STOP A PASS ALREADY RUNNING, and an earlier draft of this comment implied it
    // could by calling it "the only stop button" without qualification. It is read once, here;
    // the loop below never re-reads it and takes no `jobContext` (deliberately — see the lock
    // constant). To stop a pass that is already deleting, delete the jobs pod: the run lock's
    // redis key carries a ~10s TTL refreshed in-process, so it lapses within seconds of the pod
    // going away.
    if (!(await isFlipt(FLIPT_FEATURE_FLAGS.TRAINING_DATA_PURGE))) {
      logJob({ type: 'info', message: `Skipped, purge switch is off` });
      return { status: 'ok', skipped: 'disabled' };
    }

    // 🔴 THE UNCAPPED TOTAL, AND IT IS NOT DECORATION — WITHOUT IT THE CAP MAKES THE BACKLOG
    // INVISIBLE, which is the exact opposite of the reason the cap exists. With a backlog well
    // above the cap, every night reports the cap and nothing else: the same number whether the
    // set is a little over it or a thousand times over it, and the same number whether it is
    // shrinking or growing. The drain is only "readable" if something reports the quantity that
    // is actually draining. `minor-hash.service.ts` pairs its capped slice with a separate
    // uncapped count for this reason; so does this.
    // Resolved once, beside the switch, so a pass cannot change mode halfway through.
    const dryRun = await isFlipt(FLIPT_FEATURE_FLAGS.TRAINING_DATA_PURGE_DRY_RUN);

    const [{ total }] = await dbWrite.$queryRaw<{ total: bigint }[]>`
      SELECT count(*) as total
      FROM "ModelVersion" mv
             JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
      WHERE mv."uploadType" = 'Trained'
        AND mv."trainingStatus" in ('InReview', 'Approved')
        AND (timezone('utc', current_timestamp) -
             (mf.metadata -> 'trainingResults' ->> 'completedAt')::timestamp) > '30 days'
        AND mf."dataPurged" is not true
        AND mf.visibility != 'Public'
    `;

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
      -- 🔴 RANDOM, AND A DETERMINISTIC ORDER WOULD BE A BUG HERE. Several outcomes leave a row
      -- eligible forever by design: a non-allowlisted bucket and an unparseable url can never
      -- succeed, and a still-referenced object must not. Under any stable order those rows hold
      -- the first LIMIT slots every single night, so the pass does the same futile work forever
      -- and never reaches the rest of the set — a starvation the uncapped loop could not have,
      -- because it walked everything. Sampling bounds the expected wait for every row instead.
      -- The cost is real and accepted: this must find the whole eligible set to sort it, where
      -- an unordered LIMIT could stop early.
      ORDER BY random()
      LIMIT ${DELETE_OLD_TRAINING_DATA_MAX_ROWS_PER_PASS}
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
      data: {
        count: oldTraining.length,
        eligibleTotal: Number(total),
        cap: DELETE_OLD_TRAINING_DATA_MAX_ROWS_PER_PASS,
      },
    });

    let goodJobs = 0;
    let errorJobs = 0;
    let skippedJobs = 0;
    let dryRunJobs = 0;

    for (const { mf_id, job_id, url } of oldTraining) {
      try {
        // 🔴 `deleteModelFileObject`, NOT a bare `deleteObject(bucket, key)` off `parseKey`.
        // That is what this loop used to do, and it is why nothing was ever purged from the
        // newer backend: `parseKey` resolves a path-style url's bucket correctly, but the bare
        // call then sends it to the DEFAULT client, where that bucket does not exist. Measured
        // in production before this change: every failure was one error, `The specified bucket
        // does not exist.`, for a bucket that is real — on the other backend. The helper picks
        // the client from the url, and also applies the bucket allowlist and the refcount guard
        // that this loop never had.
        //
        // 🔴 `mf_id` as `excludeId` is REQUIRED and is not a refinement. This job KEEPS its row
        // and only sets `dataPurged`, so the refcount guard would otherwise find the row as a
        // live reference to its own url and veto every delete, forever and silently — trading a
        // loud failure for a quiet one. `urlsSafeToDelete` documents this case by name.
        // 🔴 THE DRY RUN STOPS SHORT OF THE DELETE, AND IT IS THE ONLY WAY TO SEE WHAT THIS PASS
        // WOULD TOUCH BEFORE IT TOUCHES IT. An S3 delete is not reversible from here, and until
        // the switch is first thrown this path has never been observed working in production —
        // so "what would it have deleted" is not a question any amount of reading answers. It
        // deliberately skips the refcount query too: that query is the expensive part per row,
        // and a dry run exists to be cheap enough to leave on for a night.
        if (dryRun) {
          dryRunJobs += 1;
          logJob({
            type: 'info',
            message: `Dry run, would delete`,
            data: { jobId: job_id, modelFileId: mf_id, url },
          });
          continue;
        }

        const outcome = await deleteModelFileObject(url, mf_id);

        // 🔴 Only a real delete may set `dataPurged`. A skip means THE OBJECT IS STILL THERE, and
        // marking it purged would drop the row out of this job's query permanently while the
        // bytes remain — a durable lie, and worse than the error it replaces, because an error
        // leaves the row to be retried. A skip is not a failure either: `still-referenced` is
        // the guard doing its job, so it is counted and logged separately from both.
        if (!outcome.deleted) {
          skippedJobs += 1;
          logJob({
            type: 'info',
            message: `Skipped, object left in place`,
            data: { reason: outcome.reason, jobId: job_id, modelFileId: mf_id },
          });
          continue;
        }

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
            url,
          },
        });
        errorJobs += 1;
      }
    }

    logJob({
      type: 'info',
      message: `Finished`,
      data: {
        successes: goodJobs,
        failures: errorJobs,
        skipped: skippedJobs,
        eligibleTotal: Number(total),
        dryRun: dryRunJobs,
      },
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
