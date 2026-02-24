import { Prisma } from '@prisma/client';
import { updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import { COMICS_SEARCH_INDEX } from '~/server/common/constants';
import { isDefined } from '~/utils/type-guards';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { profileImageSelect } from '../selectors/image.selector';

const READ_BATCH_SIZE = 1000;
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = COMICS_SEARCH_INDEX;

const searchableAttributes = ['name', 'description', 'user.username'];
const sortableAttributes = ['createdAt', 'updatedAt', 'stats.chapterCount', 'stats.followerCount'];
const filterableAttributes = ['user.username', 'genre', 'nsfwLevel'];
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
    JSON.stringify(filterableAttributes.sort()) !== JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      filterableAttributes
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

const WHERE = [
  Prisma.sql`cp."status" = 'Active'::"ComicProjectStatus"`,
  Prisma.sql`cp."userId" != -1`,
  Prisma.sql`EXISTS (
    SELECT 1 FROM "ComicChapter" cc
    WHERE cc."projectId" = cp.id
    AND cc."status" = 'Published'::"ComicChapterStatus"
    AND EXISTS (
      SELECT 1 FROM "ComicPanel" cpn
      WHERE cpn."projectId" = cc."projectId"
      AND cpn."chapterPosition" = cc."position"
      AND cpn."status" = 'Ready'::"ComicPanelStatus"
      AND cpn."imageUrl" IS NOT NULL
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

export type ComicSearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

type ProfileImage = Prisma.ImageGetPayload<{
  select: typeof profileImageSelect;
}>;

export const comicsSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  setup: onIndexSetup,
  prepareBatches: async ({ db, logger }, lastUpdatedAt) => {
    const where = [
      ...WHERE,
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
  pullData: async ({ db, logger }, batch) => {
    logger(
      `PullData :: Pulling data for batch`,
      batch.type === 'new' ? `${batch.startId} - ${batch.endId}` : batch.ids.length
    );
    const where = [
      ...WHERE,
      batch.type === 'update' ? Prisma.sql`cp.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`cp.id >= ${batch.startId} AND cp.id <= ${batch.endId}`
        : undefined,
    ].filter(isDefined);

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
            'image', u.image,
            'profilePictureId', u."profilePictureId"
          ) "user"
        FROM "User" u
        WHERE u.id IN (SELECT "userId" FROM target)
        GROUP BY u.id
      ), cover_images AS MATERIALIZED (
        SELECT
          cp.id AS "projectId",
          i.url AS "coverImageUrl",
          i."nsfwLevel" AS "coverImageNsfwLevel"
        FROM "ComicProject" cp
        JOIN "Image" i ON i.id = cp."coverImageId"
        WHERE cp.id IN (SELECT id FROM target)
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
        (SELECT "user" FROM users u WHERE u.id = t."userId"),
        (SELECT stats FROM stats s WHERE s."projectId" = t.id)
      FROM target t
    `;

    if (!comics.length) return null;

    const profilePictures = await db.image.findMany({
      where: {
        id: { in: comics.map((c) => c.user.profilePictureId).filter(isDefined) },
      },
      select: profileImageSelect,
    });

    logger(`PullData :: Pulled comics and profile pictures`);

    return {
      comics,
      profilePictures,
    };
  },
  transformData,
  pushData: async ({ indexName }, records) => {
    await updateDocs({
      indexName,
      documents: records as any[],
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    return;
  },
});
