import { Job } from '~/server/jobs/job';
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
  if (failed.length) log(`${failed.length} job(s) failed: ${failed.join(', ')}`);
}

main()
  .then(() => log('All jobs completed'))
  .catch((error) => console.error(error))
  .finally(() => process.exit(0));
