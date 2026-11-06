import { createJob } from '~/server/jobs/job';
import { purgeReleasedHeldCopies } from '~/server/services/held-review.service';

export const purgeReleasedHeldCopiesJob = createJob(
  'purge-released-held-copies',
  '35 10 * * *',
  purgeReleasedHeldCopies
);
