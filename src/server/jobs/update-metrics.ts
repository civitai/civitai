import { createJob } from './job';
import * as metrics from '~/server/metrics';

const metricSets = {
  models: [metrics.modelMetrics],
  users: [metrics.userMetrics],
  images: [metrics.imageMetrics],
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
    async () => {
      const stats = {
        metrics: {} as Record<string, number>,
        ranks: {} as Record<string, number>,
      };

      for (const metric of metrics)
        stats.metrics[metric.name] = await timedExecution(metric.update);

      for (const metric of metrics)
        stats.ranks[metric.name] = await timedExecution(metric.refreshRank);

      return stats;
    },
    {
      lockExpiration: 30 * 60,
    }
  )
);

async function timedExecution<T>(fn: () => Promise<T>) {
  const start = Date.now();
  await fn();
  return Date.now() - start;
}
