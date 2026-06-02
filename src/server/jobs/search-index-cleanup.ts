import { createJob } from './job';
import { cleanupAllIndexes } from '~/server/meilisearch/cleanup';
import { logToAxiom } from '~/server/logging/client';

export const searchIndexCleanupJob = createJob(
  'search-index-cleanup',
  '0 2 * * *',
  async (jobContext) => {
    const results = await cleanupAllIndexes(null, {
      apply: true,
      batch: 1000,
      jobContext,
      onError: ({ key, offset, error }) => {
        // `offset === -1` is the sentinel for preflight or delete-phase
        // errors (no scan cursor associated). Otherwise it's the cursor
        // (last id seen) at the point of failure.
        const phase = offset === -1 ? 'preflight/delete' : `cursor=${offset}`;
        logToAxiom({
          type: 'error',
          name: 'search-index-cleanup',
          message: `error in ${key} (${phase}): ${error.message}`,
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
