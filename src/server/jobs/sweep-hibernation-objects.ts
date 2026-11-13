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
 * Does nothing while the `app-hibernate` flag is off (its base value: the job has no viewer).
 * FAIL-OPEN like the sibling reapers: an error is logged and the next run retries.
 */
export const sweepHibernationObjectsJob = createJob(
  'sweep-hibernation-objects',
  '23 * * * *',
  async () => {
    const [
      { isAppHibernateEnabledGlobally },
      { sweepOrphanedArchives },
      { defaultHibernationDeps },
    ] = await Promise.all([
      import('~/server/services/app-blocks-flag'),
      import('~/server/services/app-hibernation/app-hibernation.service'),
      import('~/server/services/app-hibernation/hibernation-deps'),
    ]);
    if (!(await isAppHibernateEnabledGlobally())) return { disabled: true as const };
    try {
      const { isMissingTableError } = await import('~/server/services/blocks/app-access.service');
      const result = await sweepOrphanedArchives({
        ...(await defaultHibernationDeps()),
        isMissingTable: isMissingTableError,
      });
      const summary = {
        accountsRetried: result.accountsRetried.length,
        accountsFailed: result.accountsFailed.length,
        orphans: result.orphans.length,
      };
      if (summary.accountsRetried + summary.accountsFailed + summary.orphans > 0)
        logToAxiom(
          { name: 'sweep-hibernation-objects', type: 'info', ...summary },
          'webhooks'
        ).catch(() => undefined);
      return summary;
    } catch (error) {
      logToAxiom(
        {
          name: 'sweep-hibernation-objects',
          type: 'error',
          message: (error as Error)?.message,
          stack: (error as Error)?.stack,
        },
        'webhooks'
      ).catch(() => undefined);
      return { failed: true as const };
    }
  },
  // A full listing of the archives prefix can outlast the 5-minute default; overlapping runs
  // would only repeat idempotent deletes, but there is no reason to start one.
  { lockExpiration: 30 * 60 }
);
