import { sleep } from '~/server/utils/concurrency-helpers';
import { createJob, UNRUNNABLE_JOB_CRON } from './job';

export const dummyJob = createJob('dummy', UNRUNNABLE_JOB_CRON, async () => {
  await sleep(10000);
});
