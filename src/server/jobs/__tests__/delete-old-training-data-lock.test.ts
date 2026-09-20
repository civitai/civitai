import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

/**
 * The run lock on `delete-old-training-data`.
 *
 * THE DEFECT THIS PINS. The job registered with no options object at all, so it inherited
 * `createJob`'s five-minute `lockExpiration` and the default release-on-disconnect. It walks the
 * whole outstanding set of expired training-data files serially and no pass has been observed to
 * finish inside the caller's timeout — so in production the caller hung up, the route's close
 * handler released the lock, and each of the scheduler's retries acquired it and started another
 * concurrent pass over the same rows. Measured over several consecutive days: one daily trigger,
 * four full-length attempts.
 *
 * WHY BOTH OPTIONS OR NEITHER. A longer `lockExpiration` alone is inert — the disconnect throws
 * the budget away before it can govern anything. `keepLockOnDisconnect` alone leaves the lock
 * expiring five minutes in, long before the first retry. Every case below therefore exists to fail
 * when EITHER half is reverted.
 *
 * The generic both-arms contract for the disconnect handler, and the check that the route still
 * installs it in a position where it can fire, live in `job-disconnect-lock.test.ts`.
 */

// The job module reaches for the S3 client at call time only, but stubbing the module keeps the
// AWS SDK out of a suite that never runs the handler — none of the cases below invoke it.
vi.mock('~/utils/s3-utils', () => ({
  deleteObject: vi.fn(),
  parseKey: vi.fn(() => ({ key: 'k', bucket: 'b' })),
}));

import {
  DELETE_OLD_TRAINING_DATA_CALLER_CUT_SECONDS,
  DELETE_OLD_TRAINING_DATA_LOCK_SECONDS,
  deleteOldTrainingData,
} from '~/server/jobs/delete-old-training-data';
import { createDisconnectHandler, createJob } from '~/server/jobs/job';

const RUN_JOBS_ROUTE = path.resolve(
  __dirname,
  '../../../pages/api/webhooks/run-jobs/[[...run]].ts'
);

function harness(options: Parameters<typeof createDisconnectHandler>[0]) {
  const cancel = vi.fn(async () => undefined);
  const release = vi.fn(async () => undefined);
  return { cancel, release, handler: createDisconnectHandler(options, { cancel }, { release }) };
}

describe('delete-old-training-data asks for a lock that outlasts the caller’s retries', () => {
  it('uses the named constant, not createJob’s inherited default', () => {
    const inherited = createJob('probe-delete-old-training-data', '5 11 * * *', async () => void 0);

    expect(deleteOldTrainingData.options.lockExpiration).toBe(
      DELETE_OLD_TRAINING_DATA_LOCK_SECONDS
    );
    // The non-vacuous half. An "override" that is not actually longer than the inherited default
    // leaves the duplicate-pass hazard exactly where it was, and reads in review like a fix.
    expect(DELETE_OLD_TRAINING_DATA_LOCK_SECONDS).toBeGreaterThan(inherited.options.lockExpiration);
  });

  it('🔴 outlives the FIRST retry — the one moment the lock has to survive', () => {
    // 🔴 The yardstick is pinned to its own literal FIRST, and that is what makes the comparison
    // below a guard at all. Both constants live in the same module, so with only the lock pinned,
    // shrinking the yardstick satisfies any ratio for any lock value — and the exact mutant this
    // case exists to kill, a lock cut back under the caller's timeout, would survive a one-token
    // edit to the constant it is supposedly measured against.
    expect(DELETE_OLD_TRAINING_DATA_CALLER_CUT_SECONDS).toBe(60 * 60);

    // 🔴 The FIRST retry, not the last of the four seen today. A retry that finds the lock held is
    // answered 200, the caller scores that as success, and a caller that did not fail does not
    // retry again — so the first suppressed retry ends the ladder. Sizing against the fourth
    // attempt would be sizing against attempts that only exist while the bug does.
    //
    // 🔴 A MULTIPLE, NOT `> CUT`, AND THE DIFFERENCE IS THE WHOLE GUARD. The constant is the
    // moment the caller ABANDONS; the retry POSTs after that plus a backoff that is a range rather
    // than a constant. So `lock > cut` is satisfied by a lock ONE SECOND past the cut, which
    // expires before the retry it is supposed to outlive — measured: at 3601 this case stayed
    // green and only the exact pin below caught it. Two times the cut is the least margin that
    // cannot be satisfied by a value inside the backoff window.
    expect(DELETE_OLD_TRAINING_DATA_LOCK_SECONDS).toBeGreaterThanOrEqual(
      2 * DELETE_OLD_TRAINING_DATA_CALLER_CUT_SECONDS
    );
  });

  it('is below the cron period, so a hold cannot reach a scheduled run', () => {
    // Asserting the SCHEDULE as well as the number is what makes this a relationship rather than
    // two unrelated literals: if the cron is ever made faster, this fails instead of silently
    // comparing the lock against a period the job no longer runs at.
    expect(deleteOldTrainingData.cron).toBe('5 11 * * *'); // once daily
    const cronPeriodSeconds = 24 * 60 * 60;

    expect(DELETE_OLD_TRAINING_DATA_LOCK_SECONDS).toBeLessThan(cronPeriodSeconds);
  });

  it('is an exact pin, not a range — any change to the value must be re-argued here', () => {
    // 🔴 WHY THIS IS SPELLED OUT. The two cases above read like a range with headroom at both
    // ends, and they are not: between the floor and the cron period the cost of a longer hold is
    // FLAT, because once the first retry is answered 200 nothing POSTs again until the next daily
    // tick. So there is no optimum for an inequality to converge on, and a reader who takes those
    // two bounds as the whole argument will think any value between them is equally justified by
    // measurement. It is not — the choice is explained in the constant's own docblock. This pin is
    // what forces an edit to go and read it.
    expect(DELETE_OLD_TRAINING_DATA_LOCK_SECONDS).toBe(6 * 60 * 60);
  });
});

describe('delete-old-training-data’s lock survives the caller hanging up', () => {
  // 🔴 THE HALF THAT MAKES THE CONSTANT ABOVE MEAN ANYTHING. These drive the REAL factory the
  // route installs, using this job's own options object, so they fail if the opt-in is dropped
  // from the job OR broken in the factory.

  // 🔴 There is deliberately NO case here asserting `options.keepLockOnDisconnect === true` on its
  // own. One was written and cut: its name promised "a disconnect cancels the context but leaves
  // the lock held" while its body read a single boolean, driving no handler and asserting nothing
  // about `cancel` — a description claiming coverage the implementation did not provide, which is
  // worse than no case because it stops the next reader looking. The case below subsumes it: it
  // fails on the same mutant, through the real factory, for the behaviour the name describes.

  it('drives the real handler: cancel fires, release does not', async () => {
    const { cancel, release, handler } = harness(deleteOldTrainingData.options);

    await handler();

    // Cancel still fires. The flag is about the LOCK, not about whether the context is told to
    // stop — dropping the cancel would change every cancellation-aware job that adopts this.
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
  });

  it('CONTROL: a job that does not opt in still releases on a disconnect', async () => {
    // Same factory, same harness, a job built the ordinary way — so a green above is a fact about
    // THIS job's options rather than about a harness that never calls `release` at all.
    const control = createJob(
      'probe-delete-old-training-data-control',
      '5 11 * * *',
      async () => undefined
    );
    const { cancel, release, handler } = harness(control.options);

    await handler();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('the options above can actually reach a run', () => {
  it('the job is still registered in the run-jobs route’s dispatch list', () => {
    // 🔴 WHAT THIS IS: a source read, because importing that route pulls in every job in the
    // application. WHAT IT IS WORTH: the route dispatches by looking the requested name up in its
    // `jobs` array and reads `options` off whatever it finds. Drop this job from that array and
    // every assertion above stays green while the job never runs at all — the seam neither the
    // options tests nor the handler tests own. It cannot tell you the lookup behaves correctly.
    const source = readFileSync(RUN_JOBS_ROUTE, 'utf8');

    // 🔴 COMMENTED-OUT LINES ARE STRIPPED FIRST, AND THAT IS THE POINT OF THIS CASE, NOT TIDINESS.
    // De-registration in this file is done by COMMENTING THE ENTRY OUT, not by deleting it —
    // `// refreshImageGenerationCoverage,` and `// processCreatorProgramImageGenerationRewards,`
    // are both sitting in the very array this reads. A plain substring test therefore passes
    // happily over `// deleteOldTrainingData,`: measured, that mutant left all seven cases green
    // while the job was in fact unreachable, i.e. the guard was blind to the ONLY de-registration
    // shape this repo actually uses. Strip the comments, then require a whole LINE.
    const live = (block: string) =>
      block
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');

    expect(live(source)).toContain(
      "import { deleteOldTrainingData } from '~/server/jobs/delete-old-training-data';"
    );
    // Membership in the exported array, not merely the import — an unused import type-checks.
    const jobsArray = live(
      source.slice(
        source.indexOf('export const jobs: Job[] = ['),
        source.indexOf('const log = createLogger')
      )
    );
    expect(jobsArray).not.toHaveLength(0);
    expect(jobsArray).toMatch(/^\s*deleteOldTrainingData,\s*$/m);
  });
});
