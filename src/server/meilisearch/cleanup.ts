import { Prisma } from '@prisma/client';
import { dbRead } from '~/server/db/client';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  COMICS_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  TOOLS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';
import { searchClient } from '~/server/meilisearch/client';
import type { JobContext } from '~/server/jobs/job';
import {
  ArticleIngestionStatus,
  ArticleStatus,
  Availability,
  CollectionReadConfiguration,
  ModelStatus,
} from '~/shared/utils/prisma/enums';

export type CleanupIndexKey =
  | 'models'
  | 'articles'
  | 'users'
  | 'collections'
  | 'bounties'
  | 'tools'
  | 'comics';

type IndexConfig = {
  key: CleanupIndexKey;
  indexName: string;
  tableName: string;
  alias: string;
  where: (ids: number[]) => Prisma.Sql;
};

export const CLEANUP_INDEXES: IndexConfig[] = [
  {
    key: 'models',
    indexName: MODELS_SEARCH_INDEX,
    tableName: 'Model',
    alias: 'm',
    where: (ids) => Prisma.sql`
      m.id IN (${Prisma.join(ids)})
      AND m.status = ${ModelStatus.Published}::"ModelStatus"
      AND m.availability != ${Availability.Unsearchable}::"Availability"
    `,
  },
  {
    key: 'articles',
    indexName: ARTICLES_SEARCH_INDEX,
    tableName: 'Article',
    alias: 'a',
    where: (ids) => Prisma.sql`
      a.id IN (${Prisma.join(ids)})
      AND a."publishedAt" IS NOT NULL
      AND a.status = ${ArticleStatus.Published}::"ArticleStatus"
      AND a.ingestion = ${ArticleIngestionStatus.Scanned}::"ArticleIngestionStatus"
      AND a."tosViolation" = FALSE
      AND a.availability != ${Availability.Unsearchable}::"Availability"
    `,
  },
  {
    key: 'users',
    indexName: USERS_SEARCH_INDEX,
    tableName: 'User',
    alias: 'u',
    where: (ids) => Prisma.sql`
      u.id IN (${Prisma.join(ids)})
      AND u.id != -1
      AND u."deletedAt" IS NULL
    `,
  },
  {
    key: 'collections',
    indexName: COLLECTIONS_SEARCH_INDEX,
    tableName: 'Collection',
    alias: 'c',
    where: (ids) => Prisma.sql`
      c.id IN (${Prisma.join(ids)})
      AND c."userId" != -1
      AND c.read = ${CollectionReadConfiguration.Public}::"CollectionReadConfiguration"
      AND c.availability != 'Unsearchable'::"Availability"
      AND EXISTS (SELECT 1 FROM "CollectionItem" ci WHERE ci."collectionId" = c.id)
    `,
  },
  {
    key: 'bounties',
    indexName: BOUNTIES_SEARCH_INDEX,
    tableName: 'Bounty',
    alias: 'b',
    where: (ids) => Prisma.sql`
      b.id IN (${Prisma.join(ids)})
      AND b."userId" != -1
      AND (b."startsAt" <= NOW() OR b."expiresAt" >= NOW())
      AND b.availability != 'Unsearchable'::"Availability"
    `,
  },
  {
    key: 'tools',
    indexName: TOOLS_SEARCH_INDEX,
    tableName: 'Tool',
    alias: 't',
    where: (ids) => Prisma.sql`
      t.id IN (${Prisma.join(ids)})
      AND t.enabled = TRUE
      AND t.unlisted = FALSE
    `,
  },
  {
    key: 'comics',
    indexName: COMICS_SEARCH_INDEX,
    tableName: 'ComicProject',
    alias: 'cp',
    // MUST mirror `comics.search-index.ts:WHERE`. Cleanup compares
    // index docs against this predicate to decide which still belong
    // — a permissive predicate here means newly TOS-violated, banned-
    // user, or tainted-image projects are kept "valid" and never
    // pruned from Meilisearch.
    where: (ids) => Prisma.sql`
      cp.id IN (${Prisma.join(ids)})
      AND cp.status = 'Active'::"ComicProjectStatus"
      AND cp."tosViolation" = FALSE
      AND cp."userId" != -1
      AND EXISTS (
        SELECT 1 FROM "User" u
        WHERE u.id = cp."userId" AND u."bannedAt" IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM "ComicChapter" cc
        WHERE cc."projectId" = cp.id
        AND cc.status = 'Published'::"ComicChapterStatus"
        AND EXISTS (
          SELECT 1 FROM "ComicPanel" cpn
          JOIN "Image" i ON i.id = cpn."imageId"
          WHERE cpn."projectId" = cc."projectId"
          AND cpn."chapterPosition" = cc."position"
          AND cpn.status = 'Ready'::"ComicPanelStatus"
          AND cpn."imageUrl" IS NOT NULL
          AND i."ingestion" = 'Scanned'::"ImageIngestionStatus"
          AND i."needsReview" IS NULL
          AND i."tosViolation" = FALSE
        )
        AND NOT EXISTS (
          SELECT 1 FROM "ComicPanel" cpn
          LEFT JOIN "Image" i ON i.id = cpn."imageId"
          WHERE cpn."projectId" = cc."projectId"
          AND cpn."chapterPosition" = cc."position"
          AND cpn.status = 'Ready'::"ComicPanelStatus"
          AND (
            i.id IS NULL
            OR i."ingestion" != 'Scanned'::"ImageIngestionStatus"
            OR i."needsReview" IS NOT NULL
            OR i."tosViolation" = TRUE
          )
        )
      )
    `,
  },
];

export type CleanupOptions = {
  apply: boolean;
  /** Retained for backwards compatibility. Ignored under keyset pagination — scans are sequential by id. */
  concurrency?: number;
  batch?: number;
  maxBatches?: number;
  /** Max ids per delete call. Meili accepts large bodies; keep chunks sane. */
  deleteChunkSize?: number;
  onBatch?: (info: { key: string; offset: number; scanned: number; stale: number }) => void;
  onError?: (info: { key: string; offset: number; error: Error }) => void;
  onDelete?: (info: { key: string; chunk: number; ids: number }) => void;
  jobContext?: JobContext;
};

export type CleanupIndexStats = {
  key: string;
  indexName: string;
  batchesProcessed: number;
  idsScanned: number;
  staleFound: number;
  deleted: number;
  totalInIndex: number | null;
  errors: number;
};

async function fetchValidIds(cfg: IndexConfig, ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await dbRead.$queryRaw<{ id: number }[]>`
    SELECT ${Prisma.raw(`${cfg.alias}.id`)}::int AS id
    FROM ${Prisma.raw(`"${cfg.tableName}"`)} ${Prisma.raw(cfg.alias)}
    WHERE ${cfg.where(ids)}
  `;
  return new Set(rows.map((r) => r.id));
}

export async function cleanupIndex(
  cfg: IndexConfig,
  opts: CleanupOptions
): Promise<CleanupIndexStats> {
  if (!searchClient) throw new Error('searchClient not configured');
  const index = searchClient.index(cfg.indexName);

  const batch = opts.batch ?? 1000;
  const maxBatches = opts.maxBatches ?? Infinity;
  const deleteChunkSize = opts.deleteChunkSize ?? 10000;

  const stats: CleanupIndexStats = {
    key: cfg.key,
    indexName: cfg.indexName,
    batchesProcessed: 0,
    idsScanned: 0,
    staleFound: 0,
    deleted: 0,
    totalInIndex: null,
    errors: 0,
  };

  try {
    const statsRes = await index.getStats();
    stats.totalInIndex = statsRes.numberOfDocuments;
  } catch {
    // non-fatal
  }

  // Preflight: keyset pagination needs `id` declared both filterable AND
  // sortable on the index. If either is missing, the scan would 4xx every
  // batch — bail out early with a logged error so the cron doesn't waste
  // retries and the missing-setting cause is surfaced clearly.
  try {
    const indexSettings = await index.getSettings();
    const filt = indexSettings.filterableAttributes ?? [];
    const sort = indexSettings.sortableAttributes ?? [];
    if (!filt.includes('id') || !sort.includes('id')) {
      stats.errors += 1;
      opts.onError?.({
        key: cfg.key,
        offset: -1,
        error: new Error(
          `index ${cfg.indexName} is missing required settings for keyset scan ` +
            `(filterable has id=${filt.includes('id')}, sortable has id=${sort.includes('id')}). ` +
            `Add 'id' to both lists in ${cfg.key}.search-index.ts and let onIndexSetup run.`
        ),
      });
      return stats;
    }
  } catch (err) {
    stats.errors += 1;
    opts.onError?.({ key: cfg.key, offset: -1, error: err as Error });
    return stats;
  }

  // Keyset (cursor) pagination over `id`. Per-call cost is O(batch) on
  // Meilisearch regardless of depth — replaces offset pagination where
  // deep pages were saturating LMDB read I/O on the search host.
  let lastId = -1;
  const allStaleIds: number[] = [];

  // Retry helper: run `fn` up to MAX_ATTEMPTS times with linear backoff.
  // Re-throws immediately if the job is canceled mid-retry — otherwise the
  // inner try/catch would treat the cancellation as a transient error and
  // burn through the backoff before bailing.
  const MAX_ATTEMPTS = 3;
  const withRetries = async <T>(fn: () => Promise<T>): Promise<T> => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      opts.jobContext?.checkIfCanceled();
      try {
        return await fn();
      } catch (err) {
        // If the job is no longer running, surface the canonical
        // cancellation error (not the underlying fetch/PG error) so log
        // handlers can distinguish "we stopped on purpose" from "we failed".
        // `!== 'running'` mirrors `createJob.checkIfCanceled` exactly —
        // catches both `canceled` and (theoretically) `finished`.
        if (opts.jobContext && opts.jobContext.status !== 'running') {
          opts.jobContext.checkIfCanceled();
          throw err; // unreachable if checkIfCanceled threw, but kept for typing
        }
        lastErr = err;
        if (attempt < MAX_ATTEMPTS) {
          // Linear backoff: 1000ms, 1500ms.
          await new Promise((r) => setTimeout(r, attempt * 500 + 500));
        }
      }
    }
    throw lastErr;
  };

  // Defensive cap: if Postgres fails for many batches in a row, abandon
  // this index for the run rather than walking the whole id-space at
  // ~2.5s per batch. The job lock would eventually cancel us anyway,
  // but this short-circuits before we waste an hour.
  const MAX_CONSECUTIVE_PG_FAILURES = 10;
  let consecutivePgFailures = 0;

  while (stats.batchesProcessed < maxBatches) {
    if (opts.jobContext?.status === 'canceled') break;

    // Retry transient errors on the Meili scan a few times before aborting
    // the whole index. The original concurrent-offset code naturally
    // tolerated a single bad batch (other concurrent batches still made
    // progress); sequential keyset has no such redundancy.
    //
    // Note: `limit` is capped at the Meilisearch index `maxTotalHits`
    // setting (default 1000). Bumping `batch` past 1000 without also
    // raising `maxTotalHits` would silently truncate the page. Keyset
    // would still advance correctly on the last returned id, so we
    // wouldn't miss docs — just halve throughput.
    let page: Awaited<ReturnType<typeof index.search<{ id: number }>>>;
    try {
      page = await withRetries(() =>
        index.search<{ id: number }>('', {
          filter: `id > ${lastId}`,
          sort: ['id:asc'],
          limit: batch,
          attributesToRetrieve: ['id'],
        })
      );
    } catch (err) {
      // Cancellation surfaced from withRetries is a clean stop, not a failure.
      if (opts.jobContext && opts.jobContext.status !== 'running') break;
      stats.errors += 1;
      opts.onError?.({ key: cfg.key, offset: lastId, error: err as Error });
      // Out of retries — without advancing the cursor we'd loop on the same page.
      break;
    }

    const docIds = page.hits
      .map((r) => r.id)
      .filter((n): n is number => Number.isFinite(n));

    if (docIds.length === 0) break;

    // Same retry envelope on the Postgres side. A connection blip or short
    // replica-lag spike shouldn't drop ~10M docs of users cleanup.
    try {
      const validIds = await withRetries(() => fetchValidIds(cfg, docIds));
      const staleIds = docIds.filter((id) => !validIds.has(id));

      stats.batchesProcessed += 1;
      stats.idsScanned += docIds.length;
      stats.staleFound += staleIds.length;
      consecutivePgFailures = 0;

      if (staleIds.length > 0) allStaleIds.push(...staleIds);

      // `offset` in the callback reports the cursor (last id seen before this batch).
      opts.onBatch?.({ key: cfg.key, offset: lastId, scanned: docIds.length, stale: staleIds.length });
    } catch (err) {
      // Cancellation surfaced from withRetries is a clean stop, not a
      // Postgres failure — don't pollute the consecutivePgFailures counter
      // or log it as an error.
      if (opts.jobContext && opts.jobContext.status !== 'running') break;
      // Postgres-side error survived retries. Don't abandon the whole
      // index for a single transient batch — advance the cursor and try
      // the next page. We'll miss cleanup for the ids in this batch this
      // run; the next nightly run will catch them. But cap consecutive
      // failures so a hard outage doesn't grind through millions of ids.
      stats.errors += 1;
      consecutivePgFailures += 1;
      opts.onError?.({ key: cfg.key, offset: lastId, error: err as Error });
      if (consecutivePgFailures >= MAX_CONSECUTIVE_PG_FAILURES) {
        opts.onError?.({
          key: cfg.key,
          offset: lastId,
          error: new Error(
            `aborting ${cfg.indexName} scan: ${consecutivePgFailures} consecutive Postgres errors`
          ),
        });
        // ids come back sorted asc; advance cursor so a possible retry of
        // the outer cron picks up where we left off.
        lastId = docIds[docIds.length - 1];
        break;
      }
    }

    // ids come back sorted asc; advance cursor. Length is guaranteed > 0
    // by the empty-check above, so the access is safe.
    lastId = docIds[docIds.length - 1];

    if (docIds.length < batch) break;
  }

  if (opts.apply && allStaleIds.length > 0) {
    let chunkIdx = 0;
    for (let i = 0; i < allStaleIds.length; i += deleteChunkSize) {
      // Bail before submitting more delete tasks if the job is no longer
      // running. Without this, every remaining chunk logs a separate
      // "Job has ended" error via the catch below — for a ~10M-doc index
      // with hundreds of thousands of stale ids that's tens of duplicate
      // Axiom errors per cancellation. (`!== 'running'` mirrors what
      // `createJob.checkIfCanceled` actually throws on: status flipped to
      // either `canceled` or `finished`. Phrased this way to avoid TS's
      // control-flow narrowing inside the catch below, which would
      // otherwise reject the equivalent `=== 'canceled'` comparison.)
      if (opts.jobContext && opts.jobContext.status !== 'running') break;
      const chunk = allStaleIds.slice(i, i + deleteChunkSize);
      try {
        opts.jobContext?.checkIfCanceled();
        await index.deleteDocuments(chunk);
        stats.deleted += chunk.length;
        opts.onDelete?.({ key: cfg.key, chunk: chunkIdx, ids: chunk.length });
      } catch (err) {
        // Treat cancellation thrown mid-deleteDocuments as a clean stop,
        // not an error. See the comment above for the !== 'running' form.
        if (opts.jobContext && opts.jobContext.status !== 'running') break;
        stats.errors += 1;
        opts.onError?.({ key: cfg.key, offset: -1, error: err as Error });
      }
      chunkIdx += 1;
    }
  }

  return stats;
}

export async function cleanupAllIndexes(
  keys: CleanupIndexKey[] | null,
  opts: CleanupOptions
): Promise<CleanupIndexStats[]> {
  const selected = keys
    ? CLEANUP_INDEXES.filter((i) => keys.includes(i.key))
    : CLEANUP_INDEXES;
  const results: CleanupIndexStats[] = [];
  for (const cfg of selected) {
    if (opts.jobContext?.status === 'canceled') break;
    results.push(await cleanupIndex(cfg, opts));
  }
  return results;
}
