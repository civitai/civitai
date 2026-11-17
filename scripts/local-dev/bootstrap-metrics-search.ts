import type { Job } from '~/server/jobs/job';
import { searchIndexJobs } from '~/server/jobs/search-index-sync';
import { metricJobs } from '~/server/jobs/update-metrics';
import { createLogger } from '~/utils/logging';
import { checkLocalMeili } from './utils';

const log = createLogger('seed-metrics-search', 'green');

export const jobs: Job[] = [...metricJobs, ...searchIndexJobs];

async function main() {
  checkLocalMeili();

  // Some jobs read production-only ClickHouse aggregates; don't let one of those block the rest.
  const failed: string[] = [];
  for (const job of jobs) {
    log(`Running job ${job.name}`);
    try {
      await job.run().result;
      log(`Job ${job.name} completed`);
    } catch (error) {
      failed.push(job.name);
      log(`Job ${job.name} failed: ${(error as Error).message}`);
    }
  }
  return failed;
}

main()
  .then((failed) => {
    if (!failed.length) {
      log('All jobs completed');
      process.exit(0);
    }
    log(`${failed.length} job(s) failed: ${failed.join(', ')}`);
    process.exit(1);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
