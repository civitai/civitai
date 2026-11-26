import { createJob } from './job';
import { kyselyWrite } from '~/server/db/kyselyDb';
import {
  reconcileRunnerAttempts,
  sweepRunnerAttempts,
} from '~/server/services/blocks/runner-reconcile.service';

// Not gated on the offline-grant flag: turning runners off must not strand their reservations.

export const reconcileRunnerAttemptsJob = createJob(
  'recipe-runner-reconcile',
  '* * * * *',
  async () => reconcileRunnerAttempts(kyselyWrite)
);

export const sweepRunnerAttemptsJob = createJob('recipe-runner-sweep', '*/5 * * * *', async () =>
  sweepRunnerAttempts(kyselyWrite)
);
