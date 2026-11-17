import { createJob } from './job';
import { runCrucibleThemeReview } from '~/server/services/crucible-theme-review';

export const crucibleThemeReviewJob = createJob(
  'crucible-theme-review',
  '*/5 * * * *',
  () => runCrucibleThemeReview(),
  { lockExpiration: 15 * 60 }
);
