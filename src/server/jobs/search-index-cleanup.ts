import { createJob } from './job';
import { cleanupAllIndexes } from '~/server/meilisearch/cleanup';
import { logToAxiom } from '~/server/logging/client';

// Page size REQUESTED per keyset scan. `cleanupIndex` clamps this down to each
// index's own `pagination.maxTotalHits`, so asking for a large page is safe on
// indexes that cannot serve it — they fall back to their own ceiling.
//
// It has to be large: a multi-million-document index at the old 1,000 needs
// thousands of sequential round trips, and seven indexes' worth of that does
// not fit in one nightly run. 10,000 matches `deleteChunkSize`, which is the
// id-list size this code already sends to Postgres and to the engine.
const SCAN_BATCH = 10000;

export const searchIndexCleanupJob = createJob(
  'search-index-cleanup',
  '0 2 * * *',
  async (jobContext) => {
    const results = await cleanupAllIndexes(null, {
      apply: true,
      batch: SCAN_BATCH,
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

    // Emit the per-index outcome. Until this existed the run's only observable
    // was its duration, so a pass that covered a fraction of an index and
    // deleted only the stale documents it happened to reach was indistinguish-
    // able from a complete one — the shortfall had to be reconstructed from the
    // engine's own task history after the fact.
    for (const r of results) {
      // `totalInIndex` is null when the stats call failed, in which case we
      // cannot say whether the pass was complete — do not claim either way.
      const incomplete = r.totalInIndex !== null && r.idsScanned < r.totalInIndex;
      logToAxiom({
        // An incomplete pass is a defect, not a statistic: it must not be
        // filed under the same level as a healthy run, or it stays invisible.
        type: incomplete ? 'error' : 'info',
        name: 'search-index-cleanup',
        message: incomplete
          ? `INCOMPLETE SCAN: ${r.key} scanned ${r.idsScanned} of ${r.totalInIndex} documents — ` +
            `the pass ended before reaching the end of the index, so stale documents past the ` +
            `stopping point were not deleted`
          : `${r.key}: scanned ${r.idsScanned}, stale ${r.staleFound}, deleted ${r.deleted}`,
        key: r.key,
        scanned: r.idsScanned,
        stale: r.staleFound,
        deleted: r.deleted,
        errors: r.errors,
        total: r.totalInIndex,
        incomplete,
      }).catch();
    }

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
