import { createJob } from './job';
import { cleanupAllIndexes } from '~/server/meilisearch/cleanup';
import { logToAxiom } from '~/server/logging/client';

export const searchIndexCleanupJob = createJob(
  'search-index-cleanup',
  '0 2 * * *',
  async (jobContext) => {
    const results = await cleanupAllIndexes(null, {
      apply: true,
      concurrency: 8,
      batch: 1000,
      jobContext,
      onError: ({ key, offset, error }) => {
        logToAxiom({
          type: 'error',
          name: 'search-index-cleanup',
          message: `batch error in ${key} at offset ${offset}: ${error.message}`,
        }).catch();
      },
    });

    return {
      indexes: results.map((r) => ({
        key: r.key,
        scanned: r.idsScanned,
        stale: r.staleFound,
        deleted: r.deleted,
        errors: r.errors,
        total: r.totalInIndex,
      })),
    };
  },
  {
    lockExpiration: 2 * 60 * 60,
  }
);
