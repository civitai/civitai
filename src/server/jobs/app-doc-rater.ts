import { createJob } from '~/server/jobs/job';
import { appsWithLevelsOn, rateUnratedDocs } from '~/server/services/apps/doc-rater.service';

/**
 * Content levels, build 3: rate the unrated shared documents of every app whose
 * `app-blocks-shared-doc-levels` flag reads ON (`doc-rater.service.ts`). A flag that cannot be read
 * rates nothing; the text scan's kill switch and `AppDoc` rollout decide whether a scan runs at all.
 * Does nothing until the rating-id migration is applied.
 */
export const appDocRaterJob = createJob('app-doc-rater', '*/5 * * * *', async (job) => {
  const apps = await appsWithLevelsOn();
  if (!apps.length) return { apps: 0 };
  return rateUnratedDocs(apps, { checkIfCanceled: job.checkIfCanceled });
});
