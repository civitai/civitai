import { createJob } from '~/server/jobs/job';
import { runTrainingCanary } from '~/server/services/orchestrator/training/training-canary';

// A full 50-entry matrix of whatif quotes at 3 concurrent can outlast the default 5-minute lock.
export const trainingCanaryJob = createJob('training-canary', '17 * * * *', () => runTrainingCanary(), {
  lockExpiration: 10 * 60,
});
