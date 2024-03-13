import { createJob, JobContext } from './job';
import * as metrics from '~/server/metrics';

const metricSets = {
  models: [metrics.modelMetrics],
  users: [metrics.userMetrics],
  images: [metrics.imageMetrics],
  bounties: [metrics.bountyEntryMetrics, metrics.bountyMetrics],
  clubs: [
    // metrics.clubPostMetrics, metrics.clubMetrics // disable clubs
  ],
  posts: [metrics.postMetrics],
  tags: [metrics.tagMetrics],
  collections: [metrics.collectionMetrics],
  articles: [metrics.articleMetrics],
  other: [
    // metrics.answerMetrics, metrics.questionMetrics // disable questions and answers
  ],
};

export const metricJobs = Object.entries(metricSets).map(([name, metrics]) =>
  createJob(
    `update-metrics-${name}`,
    '*/1 * * * *',
    async (e) => {
      const stats = {
        metrics: {} as Record<string, number>,
        ranks: {} as Record<string, number>,
      };

      for (const metric of metrics) {
        e.checkIfCanceled();
        stats.metrics[metric.name] = await timedExecution(metric.update, e);
      }

      for (const metric of metrics) {
        e.checkIfCanceled();
        stats.ranks[metric.name] = await timedExecution(metric.refreshRank, e);
      }

      return stats;
    },
    {
      lockExpiration: 30 * 60,
      queue: 'metrics',
    }
  )
);

async function timedExecution<T>(
  fn: (jobContext: JobContext) => Promise<T>,
  jobContext: JobContext
) {
  const start = Date.now();
  await fn(jobContext);
  return Date.now() - start;
}
