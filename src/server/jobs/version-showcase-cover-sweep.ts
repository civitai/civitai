import { createJob } from '~/server/jobs/job';
import { sweepCommunityCovers } from '~/server/services/version-showcase-curation.service';

/** Clears model covers that name a featured community image no longer allowed there. */
export const versionShowcaseCoverSweepJob = createJob(
  'version-showcase-cover-sweep',
  '*/15 * * * *',
  async () => sweepCommunityCovers()
);
