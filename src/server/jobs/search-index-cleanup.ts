import { createJob } from './job';
import { cleanupAllIndexes } from '~/server/meilisearch/cleanup';
import { logToAxiom } from '~/server/logging/client';

// Page size REQUESTED per keyset scan. `cleanupIndex` clamps this down to each
// index's own `pagination.maxTotalHits`, so asking for a large page is safe on
// indexes that cannot serve it — they fall back to their own ceiling.
//
// It has to be large: a multi-million-document index at the old 1,000 needs
// thousands of sequential round trips, and seven indexes' worth of that does
// not fit in one nightly run.
//
// What bounds it from above is that this same number is the length of the
// `id IN (...)` list handed to Postgres once per page, in `fetchValidIds`.
// (It is NOT bounded by `deleteChunkSize`, which sizes only the delete calls
// made against the search engine and applies to the far smaller stale set.)
const SCAN_BATCH = 10000;

/**
 * How far `idsScanned` may fall short of the pre-scan document count before the
 * run is called incomplete on the counts alone.
 *
 * A shortfall is NORMAL: `totalInIndex` is a snapshot taken before a scan that
 * then runs for a long time, and a separate cleanup job issues delete-by-filter
 * against most of these indexes every five minutes, so documents legitimately
 * disappear from under the cursor. The authoritative truncation signal is
 * `stoppedEarly` — a fact about how the loop exited, immune to that drift —
 * and this band is only the backstop for "the loop claimed to finish but
 * covered implausibly little".
 *
 * The band is a judgement, not a measurement, and it is deliberately loose:
 * the real incident it has to catch was a 63% shortfall. Every run logs
 * `scanned`, `total` and `coverage`, so it can be re-derived from data rather
 * than re-guessed.
 */
const COVERAGE_SHORTFALL_RATIO = 0.25;
const COVERAGE_SHORTFALL_FLOOR = 1000;

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
          // `.catch(() => undefined)` and NOT a bare `.catch()`: `catch(undefined)` is
          // `then(undefined, undefined)`, a pass-through that leaves the
          // rejection unhandled. A bare one swallows nothing.
        }).catch(() => undefined);
      },
    });

    // Emit the per-index outcome. Until this existed the run's only observable
    // was its duration, so a pass that covered a fraction of an index and
    // deleted only the stale documents it happened to reach was indistinguish-
    // able from a complete one — the shortfall had to be reconstructed from the
    // engine's own task history after the fact.
    for (const r of results) {
      // Three INDEPENDENT facts, kept independent because each has a different
      // cause and a different fix, and because a message that asserts the wrong
      // one is worse than a message that just reports numbers.
      //
      //  - stoppedEarly: the loop exited without reaching a confirmed end of
      //    the index. Authoritative, and the reason a scanned-vs-total
      //    comparison is not the primary signal.
      //  - idsSkipped: ids fetched but never judged, because their eligibility
      //    lookup failed. The cursor advanced past them, so this can be
      //    non-zero on a scan that DID reach the end.
      //  - lowCoverage: the loop finished, but covered implausibly little.
      const coverage = r.totalInIndex && r.totalInIndex > 0 ? r.idsScanned / r.totalInIndex : null;
      const shortfall = r.totalInIndex === null ? null : r.totalInIndex - r.idsScanned;
      const lowCoverage =
        !r.stoppedEarly &&
        shortfall !== null &&
        // A count taken while the engine was mid-ingest is a moving number, so
        // a shortfall against it is not evidence of anything.
        r.indexingAtStart !== true &&
        shortfall > COVERAGE_SHORTFALL_FLOOR &&
        shortfall > (r.totalInIndex as number) * COVERAGE_SHORTFALL_RATIO;

      const incomplete = r.stoppedEarly || lowCoverage;
      // `errors > 0` escalates on its own. The case that forces this: an index
      // the engine cannot serve at all fails BOTH `getStats` and `getSettings`,
      // so `totalInIndex` stays null and no coverage comparison is possible —
      // an index that was not cleaned at all would otherwise be filed as a
      // healthy `info` line.
      const level = incomplete || r.errors > 0 ? 'error' : 'info';

      const problems: string[] = [];
      if (r.stoppedEarly) {
        problems.push(
          `scan STOPPED EARLY after ${r.idsScanned} id(s)` +
            (r.totalInIndex === null
              ? ' (index document count unavailable)'
              : ` of ${r.totalInIndex} at the start of the run`)
        );
      } else if (lowCoverage) {
        problems.push(
          `scan reached the end of the index but covered only ${r.idsScanned} of ` +
            `${r.totalInIndex} document(s)`
        );
      }
      if (r.idsSkipped > 0) {
        problems.push(`${r.idsSkipped} id(s) SKIPPED — eligibility lookup failed`);
      }
      if (r.errors > 0) problems.push(`${r.errors} error(s)`);

      logToAxiom({
        type: level,
        name: 'search-index-cleanup',
        message:
          problems.length > 0
            ? `${r.key}: ${problems.join('; ')} — scanned ${r.idsScanned}, stale ${
                r.staleFound
              }, deleted ${r.deleted}`
            : `${r.key}: scanned ${r.idsScanned}, stale ${r.staleFound}, deleted ${r.deleted}`,
        key: r.key,
        scanned: r.idsScanned,
        stale: r.staleFound,
        deleted: r.deleted,
        errors: r.errors,
        total: r.totalInIndex,
        coverage,
        incomplete,
        stoppedEarly: r.stoppedEarly,
        skipped: r.idsSkipped,
        rescuedByPrimary: r.rescuedByPrimary,
        indexingAtStart: r.indexingAtStart,
      }).catch(() => undefined);
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
