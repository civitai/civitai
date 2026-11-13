import { logToAxiom } from '~/server/logging/client';
import { createJob } from './job';

/**
 * APP HIBERNATE — the orphan sweep (`sweepOrphanedArchives` in
 * `services/app-hibernation/app-hibernation.service.ts`), hourly:
 *   1. finishes the deletion of every deleted account that still has sleeping-app rows: the
 *      account-deletion step deletes objects first and rows last, and throws on failure, so its
 *      leftover rows are the durable record of an unfinished deletion. This retries it, objects
 *      first, then rows;
 *   2. deletes archive objects older than a day that no row references (uploads of attempts that
 *      never committed, copies a failed delete left behind).
 *
 * Deliberately NOT gated on the `app-hibernate` flag. A job has no user, so it could only read the
 * flag's base value, which stays off while the flag is rolled out to a segment; the users in that
 * segment would then hibernate apps whose failed account deletions are never finished. And it is
 * safe ungated: it only finishes deletions of deleted accounts and removes objects no row
 * references. It is gated on the archive store instead: with none configured it does nothing.
 *
 * A deleted account under a legal hold (or whose hold cannot be read) is skipped and counted.
 * The orphan pass keeps a held user's objects too. Logs one line per run with its counts. Any error
 * (a missing table included) fails the run: the job runner counts and logs it, and the next run
 * retries.
 */
export const sweepHibernationObjectsJob = createJob(
  'sweep-hibernation-objects',
  '23 * * * *',
  async () => {
    const [{ sweepOrphanedArchives }, { defaultHibernationDeps }] = await Promise.all([
      import('~/server/services/app-hibernation/app-hibernation.service'),
      import('~/server/services/app-hibernation/hibernation-deps'),
    ]);
    const deps = await defaultHibernationDeps();
    if (!deps.store) return { skipped: 'no archive store configured' as const };
    const [{ isMissingTableError }, { isAccountUnderLegalHold, areAccountsUnderLegalHold }] =
      await Promise.all([
        import('~/server/services/blocks/app-access.service'),
        import('~/server/services/legal-hold.service'),
      ]);
    // A failure (a missing table included) is rethrown by not catching it: the job runner counts
    // it as a failed run and logs it.
    const result = await sweepOrphanedArchives({
      ...deps,
      isMissingTable: isMissingTableError,
      isUnderLegalHold: isAccountUnderLegalHold,
      areUnderLegalHold: areAccountsUnderLegalHold,
    });
    const summary = {
      scanned: result.scanned,
      removed: result.orphans.length,
      orphansHeld: result.orphansHeld,
      deletedAccountsFinished: result.accountsRetried.length,
      deletedAccountRowsFinished: result.accountRowsFinished,
      deletedAccountObjectsRemoved: result.accountObjectsRemoved,
      heldAccounts: result.accountsHeld.length,
      errors: result.accountsFailed.length,
    };
    logToAxiom({ name: 'sweep-hibernation-objects', type: 'info', ...summary }, 'webhooks').catch(
      () => undefined
    );
    return summary;
  },
  // A full listing of the archives prefix can outlast the 5-minute default; overlapping runs
  // would only repeat idempotent deletes, but there is no reason to start one.
  { lockExpiration: 30 * 60 }
);
