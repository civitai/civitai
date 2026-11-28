import { createJob } from './job';

/**
 * Unpublishes the live files of every suspended on-site app whose takedown is not confirmed
 * (`reconcileSuspendedLiveApps` in live-unpublish.service), behind `app-blocks-live-unpublish`.
 * The takedown paths only reconcile an app when it is taken down, relisted or deployed; this run
 * catches an app taken down before the flag was on and a takedown whose Job failed.
 *
 * Each app goes through the same per-app lock and markers as a takedown, so a later relist
 * restores it as usual. The lock covers the longest run: a batch of apps, a few at a time, each
 * with its own Job budget.
 */
export const reconcileLiveUnpublishJob = createJob(
  'reconcile-live-unpublish',
  '17 * * * *',
  async (jobContext) => {
    const { reconcileSuspendedLiveApps } = await import(
      '~/server/services/blocks/live-unpublish.service'
    );
    return reconcileSuspendedLiveApps({ shouldStop: () => jobContext.status !== 'running' });
  },
  { lockExpiration: 60 * 60 }
);
