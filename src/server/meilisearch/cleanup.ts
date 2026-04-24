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
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
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
    where: (ids) => Prisma.sql`
      cp.id IN (${Prisma.join(ids)})
      AND cp.status = 'Active'::"ComicProjectStatus"
      AND cp."userId" != -1
      AND EXISTS (
        SELECT 1 FROM "ComicChapter" cc
        WHERE cc."projectId" = cp.id
        AND cc.status = 'Published'::"ComicChapterStatus"
        AND EXISTS (
          SELECT 1 FROM "ComicPanel" cpn
          WHERE cpn."projectId" = cc."projectId"
          AND cpn."chapterPosition" = cc."position"
          AND cpn.status = 'Ready'::"ComicPanelStatus"
          AND cpn."imageUrl" IS NOT NULL
        )
      )
    `,
  },
];

export type CleanupOptions = {
  apply: boolean;
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
  const concurrency = opts.concurrency ?? 8;
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

  let offset = 0;
  let done = false;
  const allStaleIds: number[] = [];

  const generator = () => {
    if (done || stats.batchesProcessed >= maxBatches) return null;
    if (opts.jobContext?.status === 'canceled') return null;
    const myOffset = offset;
    offset += batch;
    return async () => {
      try {
        opts.jobContext?.checkIfCanceled();
        const page = await index.getDocuments<{ id: number }>({
          fields: ['id'],
          limit: batch,
          offset: myOffset,
        });
        const docIds = page.results
          .map((r) => r.id)
          .filter((n): n is number => Number.isFinite(n));

        if (docIds.length === 0) {
          done = true;
          return;
        }

        const validIds = await fetchValidIds(cfg, docIds);
        const staleIds = docIds.filter((id) => !validIds.has(id));

        stats.batchesProcessed += 1;
        stats.idsScanned += docIds.length;
        stats.staleFound += staleIds.length;

        if (staleIds.length > 0) allStaleIds.push(...staleIds);

        opts.onBatch?.({ key: cfg.key, offset: myOffset, scanned: docIds.length, stale: staleIds.length });

        if (docIds.length < batch) done = true;
      } catch (err) {
        stats.errors += 1;
        opts.onError?.({ key: cfg.key, offset: myOffset, error: err as Error });
      }
    };
  };

  await limitConcurrency(generator, { limit: concurrency });

  if (opts.apply && allStaleIds.length > 0) {
    let chunkIdx = 0;
    for (let i = 0; i < allStaleIds.length; i += deleteChunkSize) {
      const chunk = allStaleIds.slice(i, i + deleteChunkSize);
      try {
        opts.jobContext?.checkIfCanceled();
        await index.deleteDocuments(chunk);
        stats.deleted += chunk.length;
        opts.onDelete?.({ key: cfg.key, chunk: chunkIdx, ids: chunk.length });
      } catch (err) {
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
