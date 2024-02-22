import { createJob, JobContext } from './job';
import * as metrics from '~/server/metrics';

const metricSets = {
  models: [metrics.modelMetrics],
  users: [metrics.userMetrics],
  images: [metrics.imageMetrics],
  bounties: [metrics.bountyEntryMetrics, metrics.bountyMetrics],
  clubs: [metrics.clubPostMetrics, metrics.clubMetrics],
  other: [
    metrics.answerMetrics,
    metrics.articleMetrics,
    metrics.postMetrics,
    metrics.questionMetrics,
    metrics.tagMetrics,
    metrics.collectionMetrics,
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

      for (const metric of metrics)
        stats.metrics[metric.name] = await timedExecution(metric.update, e);

      for (const metric of metrics)
        stats.ranks[metric.name] = await timedExecution(metric.refreshRank, e);

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
