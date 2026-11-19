import { Prisma } from '@prisma/client';
import { updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex, onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
import {
  createSearchIndexUpdateProcessor,
  type SearchIndexContext,
  type SearchIndexPullBatch,
} from '~/server/search-index/base.search-index';
import { COMICS_SEARCH_INDEX } from '~/server/common/constants';
import { imageNotRestrictedSql } from '~/server/common/image-visibility';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { comicsFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { comicsSortableAttributes } from '~/server/search-index/sortable-attributes';
import { isDefined } from '~/utils/type-guards';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import {
  getServableProfilePictures,
  type RawQueryClient,
} from '~/server/services/profile-picture.sql';
import { fallbackUserImageColumn } from '~/server/services/profile-picture-fallback.sql';
import type { profileImageSelect } from '../selectors/image.selector';
import { heldUserSql } from '@civitai/shared/held-media';
import {
  semanticCoverImageCleanText,
  semanticImageHeldText,
} from '~/server/services/semantic-held-content.sql';

const READ_BATCH_SIZE = 1000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = COMICS_SEARCH_INDEX;

const searchableAttributes = ['name', 'description', 'user.username'];
// `id` is here and in the filterable list for the keyset cleanup scan
// (src/server/meilisearch/cleanup.ts).
const sortableAttributes = [...comicsSortableAttributes];
const rankingRules = ['sort', 'words', 'typo', 'proximity', 'attribute', 'exactness'];

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  if (!index) return;

  console.log('onIndexSetup :: Index has been gotten or created', index);
  const settings = await index.getSettings();

  if (JSON.stringify(searchableAttributes) !== JSON.stringify(settings.searchableAttributes)) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      searchableAttributes
    );
    console.log(
      'onIndexSetup :: updateSearchableAttributesTask created',
      updateSearchableAttributesTask
    );
  }

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  if (
    JSON.stringify(comicsFilterableAttributes.sort()) !==
    JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      comicsFilterableAttributes
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  console.log('onIndexSetup :: all tasks completed');
};

type ComicForSearchIndex = {
  id: number;
  name: string;
  description: string | null;
  genre: string | null;
  nsfwLevel: number;
  createdAt: Date;
  updatedAt: Date;
  userId: number;
  coverImageUrl: string | null;
  coverImageNsfwLevel: number | null;
  /** The cover's enabled tag ids, for the client's hidden-tag filter. */
  coverImageTagIds: number[] | null;
  user: {
    id: number;
    username: string | null;
    deletedAt: Date | null;
    image: string | null;
    profilePictureId: number | null;
  };
  stats: {
    chapterCount: number;
    followerCount: number;
  } | null;
};

// Visibility gates for the search index — must mirror the
// `getPublicProjects` listing query in `comics.router.ts`. Anything that
// passes here ends up indexed in Meilisearch and reachable by anonymous
// search, so missing a gate here is a leak even if the listing route
// gets it right.
//
//  - project Active and not TOS-violated
//  - author exists, isn't the system user (-1), isn't banned
//  - has at least one Published chapter with a Ready panel that has a
//    *clean* underlying Image: ingestion = Scanned, not in review, not
//    TOS-violated. Without the Image checks, panels whose underlying
//    Image was flagged AFTER scan would still surface in search.
export const comicSearchEligibleWhere = [
  Prisma.sql`cp."status" = 'Active'::"ComicProjectStatus"`,
  Prisma.sql`cp."tosViolation" = FALSE`,
  Prisma.sql`cp."userId" != -1`,
  Prisma.sql`cp."nsfwLevel" NOT IN (0, 32)`,
  Prisma.sql`EXISTS (
    SELECT 1 FROM "User" u
    WHERE u.id = cp."userId" AND u."bannedAt" IS NULL AND u."deletedAt" IS NULL
  )`,
  Prisma.raw(`NOT ${heldUserSql('cp."userId"')}`),
  Prisma.raw(semanticCoverImageCleanText('cp."coverImageId"')),
  Prisma.raw(`NOT EXISTS (
    SELECT 1 FROM "ComicPanel" hp JOIN "Image" hi ON hi.id = hp."imageId"
    WHERE hp."projectId" = cp.id AND ${semanticImageHeldText('hi')}
  )`),
  Prisma.sql`NOT EXISTS (
    SELECT 1 FROM "ComicChapter" fc
    JOIN "ComicPanel" fp ON fp."projectId" = fc."projectId" AND fp."chapterPosition" = fc."position"
    JOIN "Image" fi ON fi.id = fp."imageId"
    WHERE fc."projectId" = cp.id
    AND fc."status" = 'Published'::"ComicChapterStatus"
    AND fc."availability" = 'Public'::"Availability"
    AND fp."status" = 'Ready'::"ComicPanelStatus"
    AND (fi."blockedFor" IS NOT NULL OR fi.minor = TRUE OR fi.poi = TRUE)
  )`,
  Prisma.sql`EXISTS (
    SELECT 1 FROM "ComicChapter" cc
    WHERE cc."projectId" = cp.id
    AND cc."status" = 'Published'::"ComicChapterStatus"
    AND cc."availability" = 'Public'::"Availability"
    AND EXISTS (
      SELECT 1 FROM "ComicPanel" cpn
      JOIN "Image" i ON i.id = cpn."imageId"
      WHERE cpn."projectId" = cc."projectId"
      AND cpn."chapterPosition" = cc."position"
      AND cpn."status" = 'Ready'::"ComicPanelStatus"
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
      AND cpn."status" = 'Ready'::"ComicPanelStatus"
      AND (
        i.id IS NULL
        OR i."ingestion" != 'Scanned'::"ImageIngestionStatus"
        OR i."needsReview" IS NOT NULL
        OR i."tosViolation" = TRUE
        OR i."blockedFor" IS NOT NULL
        OR i.minor = TRUE
        OR i.poi = TRUE
        OR i."nsfwLevel" IN (0, 32)
      )
    )
  )`,
];

const transformData = async ({
  comics,
  profilePictures,
}: {
  comics: ComicForSearchIndex[];
  profilePictures: ProfileImage[];
}) => {
  const records = comics
    .map(({ user, nsfwLevel, ...comic }) => {
      const profilePicture = profilePictures.find((p) => p.id === user.profilePictureId) ?? null;
      return {
        ...comic,
        nsfwLevel: parseBitwiseBrowsingLevel(nsfwLevel),
        user: {
          ...user,
          profilePicture,
        },
        stats: comic.stats ?? { chapterCount: 0, followerCount: 0 },
      };
    })
    .filter(isDefined);

  return records;
};

/** The index's rows for the eligible comics that also match every one of `filters`. */
async function pullComics(db: RawQueryClient, filters: Prisma.Sql[]) {
  const where = [...comicSearchEligibleWhere, ...filters];
  const comics = await db.$queryRaw<ComicForSearchIndex[]>`
    WITH target AS MATERIALIZED (
      SELECT
        cp.id,
        cp.name,
        cp.description,
        cp.genre,
        cp."nsfwLevel",
        cp."createdAt",
        cp."updatedAt",
        cp."userId"
      FROM "ComicProject" cp
      WHERE ${Prisma.join(where, ' AND ')}
    ), users AS MATERIALIZED (
      SELECT
        u.id,
        jsonb_build_object(
          'id', u.id,
          'username', u.username,
          'deletedAt', u."deletedAt",
          'image', ${Prisma.raw(fallbackUserImageColumn)},
          'profilePictureId', u."profilePictureId"
        ) "user"
      FROM "User" u
      WHERE u.id IN (SELECT "userId" FROM target)
      GROUP BY u.id
    ), cover_images AS MATERIALIZED (
      SELECT
        cp.id AS "projectId",
        i.url AS "coverImageUrl",
        i."nsfwLevel" AS "coverImageNsfwLevel",
        ARRAY(
          SELECT t."tagId" FROM "TagsOnImageDetails" t
          WHERE t."imageId" = i.id AND NOT t.disabled
        ) AS "coverImageTagIds"
      FROM "ComicProject" cp
      JOIN "Image" i ON i.id = cp."coverImageId"
      WHERE cp.id IN (SELECT id FROM target)
      AND ${imageNotRestrictedSql()}
    ), stats AS MATERIALIZED (
      SELECT
        t.id AS "projectId",
        jsonb_build_object(
          'chapterCount', (
            SELECT COUNT(*) FROM "ComicChapter" cc
            WHERE cc."projectId" = t.id AND cc."status" = 'Published'::"ComicChapterStatus"
          ),
          'followerCount', (
            SELECT COUNT(*) FROM "ComicProjectEngagement" cpe
            WHERE cpe."projectId" = t.id AND cpe."type" = 'Notify'::"ComicEngagementType"
          )
        ) stats
      FROM target t
    )
    SELECT
      t.*,
      (SELECT "coverImageUrl" FROM cover_images ci WHERE ci."projectId" = t.id),
      (SELECT "coverImageNsfwLevel" FROM cover_images ci WHERE ci."projectId" = t.id),
      (SELECT "coverImageTagIds" FROM cover_images ci WHERE ci."projectId" = t.id),
      (SELECT "user" FROM users u WHERE u.id = t."userId"),
      (SELECT stats FROM stats s WHERE s."projectId" = t.id)
    FROM target t
  `;

  if (!comics.length) return null;

  const profilePictures = await getServableProfilePictures(
    db,
    comics.map((c) => c.user.profilePictureId).filter(isDefined)
  );

  return { comics, profilePictures };
}

/** Index records for those of `ids` that are still eligible, in no particular order. */
export async function getComicSearchRecords(db: RawQueryClient, ids: number[]) {
  if (!ids.length) return [];
  const data = await pullComics(db, [Prisma.sql`cp.id IN (${Prisma.join(ids)})`]);
  return data ? transformData(data) : [];
}

export type ComicSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

type ProfileImage = Prisma.ImageGetPayload<{
  select: typeof profileImageSelect;
}>;

export const pullData = async (
  { db, logger }: SearchIndexContext,
  batch: SearchIndexPullBatch
): Promise<PulledComics | null> => {
  logger(
    `PullData :: Pulling data for batch`,
    batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length
  );
  const data = await pullComics(
    db,
    [
      batch.type === 'update' ? Prisma.sql`cp.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`cp.id >= ${batch.startId} AND cp.id <= ${batch.endId}`
        : undefined,
    ].filter(isDefined)
  );
  const matched = new Set(data?.comics.map((c) => c.id));
  const disqualifiedIds = batch.type === 'update' ? batch.ids.filter((id) => !matched.has(id)) : [];
  if (!data && !disqualifiedIds.length) return null;

  logger(`PullData :: Pulled comics and profile pictures`);

  return { comics: [], profilePictures: [], ...data, disqualifiedIds };
};

export const transformIndexData = async ({
  disqualifiedIds,
  ...data
}: PulledComics): Promise<TransformedComics> => ({
  records: await transformData(data),
  disqualifiedIds,
});

export const pushData = async (
  { indexName }: SearchIndexContext,
  { records, disqualifiedIds }: TransformedComics
) => {
  await updateDocs({
    indexName,
    documents: records as any[],
    batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
  });
  // `updateDocs` upserts, so a comic that stopped qualifying keeps its document unless deleted here.
  if (disqualifiedIds.length)
    await onSearchIndexDocumentsCleanup({ indexName, ids: disqualifiedIds });
};

export const comicsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  outboxEntity: 'Comic',
  setup: onIndexSetup,
  prepareBatches: async ({ db, logger }, lastUpdatedAt) => {
    const where = [
      ...comicSearchEligibleWhere,
      lastUpdatedAt ? Prisma.sql`cp."createdAt" >= ${lastUpdatedAt}` : undefined,
    ].filter(isDefined);

    const data = await db.$queryRaw<{ startId: number; endId: number }[]>`
      SELECT MIN(id) as "startId", MAX(id) as "endId" FROM "ComicProject" cp
      WHERE ${Prisma.join(where, ' AND ')}
    `;

    const { startId, endId } = data[0];

    logger(
      `PrepareBatches :: Prepared batch: ${startId} - ${endId} ... Last updated: ${lastUpdatedAt}`
    );

    return {
      batchSize: READ_BATCH_SIZE,
      startId,
      endId,
    };
  },
  pullData,
  transformData: transformIndexData,
  pushData,
  // A disqualified comic is handled: `pushData` deletes its document.
  getHandledIds: ({ records, disqualifiedIds }: TransformedComics) => [
    ...records.map((record) => record.id),
    ...disqualifiedIds,
  ],
});

/**
 * Queues every comic for an update, so one whose owner was banned, deleted or held, or whose cover
 * or panel image was flagged, leaves the index (`pushData` deletes it) though no comic row changed.
 */
export async function queueAllComicsForRefresh(db: RawQueryClient) {
  const rows = await db.$queryRaw<{ id: number }[]>`SELECT id FROM "ComicProject"`;
  if (rows.length)
    await comicsSearchIndex.queueUpdate(
      rows.map(({ id }) => ({ id, action: SearchIndexUpdateQueueAction.Update })),
      { reason: 'refresh' }
    );
  return rows.length;
}

type PulledComics = NonNullable<Awaited<ReturnType<typeof pullComics>>> & {
  disqualifiedIds: number[];
};
type TransformedComics = { records: ComicSearchIndexRecord[]; disqualifiedIds: number[] };
