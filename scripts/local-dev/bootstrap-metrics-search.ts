import { Job } from '~/server/jobs/job';
import { searchIndexJobs } from '~/server/jobs/search-index-sync';
import { metricJobs } from '~/server/jobs/update-metrics';
import { createLogger } from '~/utils/logging';
import { checkLocalMeili } from './utils';

const log = createLogger('seed-metrics-search', 'green');

export const jobs: Job[] = [...metricJobs, ...searchIndexJobs];

async function main() {
  checkLocalMeili();

  for (const job of jobs) {
    log(`Running job ${job.name}`);
    await job.run().result;
    log(`Job ${job.name} completed`);
  }
}

main()
  .then(() => log('All jobs completed'))
  .catch((error) => console.error(error))
  .finally(() => process.exit(0));
