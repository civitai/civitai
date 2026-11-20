import { Prisma } from '@prisma/client';
import { updateDocs } from '~/server/meilisearch/client';
import { getOrCreateIndex, onSearchIndexDocumentsCleanup } from '~/server/meilisearch/util';
import { createSearchIndexUpdateProcessor } from '~/server/search-index/base.search-index';
import type {
  BountyType,
  CosmeticSource,
  CosmeticType,
  ImageGenerationProcess,
  MediaType,
} from '~/shared/utils/prisma/enums';
import { BOUNTIES_SEARCH_INDEX } from '~/server/common/constants';
import { bountiesFilterableAttributes } from '~/server/search-index/filterable-attributes';
import { bountiesSortableAttributes } from '~/server/search-index/sortable-attributes';
import { isDefined } from '~/utils/type-guards';
import { dbRead } from '~/server/db/client';
import type { ImageMetadata } from '~/server/schema/media.schema';
import type { ImageModelWithIngestion } from '../selectors/image.selector';
import { isMinorMatureImage, withoutMinorFlag } from '~/server/common/image-visibility';
import { NsfwLevel } from '~/server/common/enums';
import {
  bountyImageNsfwLevel,
  bountyNsfwFlagLevel,
  getTextRatedBountyLevels,
  mayBeTextRated,
} from '~/server/services/bounty-rated-level';
import { getServableProfilePictures } from '~/server/services/profile-picture.sql';
import { entityImageVisibilityConditions } from '~/server/services/image-visibility.service';
import { fallbackUserImageColumn } from '~/server/services/profile-picture-fallback.sql';
import type { profileImageSelect } from '../selectors/image.selector';
import { parseBitwiseBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import { publicBountyDetails } from '~/server/utils/bounty-details';

const READ_BATCH_SIZE = 1000; // 10 items per bounty are fetched for images. Careful with this number
const MEILISEARCH_DOCUMENT_BATCH_SIZE = 1000;
const INDEX_ID = BOUNTIES_SEARCH_INDEX;

const onIndexSetup = async ({ indexName }: { indexName: string }) => {
  const index = await getOrCreateIndex(indexName, { primaryKey: 'id' });
  console.log('onIndexSetup :: Index has been gotten or created', index);

  if (!index) {
    return;
  }

  const settings = await index.getSettings();

  const searchableAttributes = ['name', 'user.username'];

  if (JSON.stringify(searchableAttributes) !== JSON.stringify(settings.searchableAttributes)) {
    const updateSearchableAttributesTask = await index.updateSearchableAttributes(
      searchableAttributes
    );
    console.log(
      'onIndexSetup :: updateSearchableAttributesTask created',
      updateSearchableAttributesTask
    );
  }

  // `id` required by the keyset cleanup scan (src/server/meilisearch/cleanup.ts).
  const sortableAttributes = [...bountiesSortableAttributes];

  if (JSON.stringify(sortableAttributes.sort()) !== JSON.stringify(settings.sortableAttributes)) {
    const sortableFieldsAttributesTask = await index.updateSortableAttributes(sortableAttributes);
    console.log(
      'onIndexSetup :: sortableFieldsAttributesTask created',
      sortableFieldsAttributesTask
    );
  }

  const rankingRules = ['sort', 'attribute', 'words', 'proximity', 'exactness', 'typo'];

  if (JSON.stringify(rankingRules) !== JSON.stringify(settings.rankingRules)) {
    const updateRankingRulesTask = await index.updateRankingRules(rankingRules);
    console.log('onIndexSetup :: updateRankingRulesTask created', updateRankingRulesTask);
  }

  if (
    // Meilisearch stores sorted.
    JSON.stringify(bountiesFilterableAttributes.sort()) !==
    JSON.stringify(settings.filterableAttributes)
  ) {
    const updateFilterableAttributesTask = await index.updateFilterableAttributes(
      bountiesFilterableAttributes
    );

    console.log(
      'onIndexSetup :: updateFilterableAttributesTask created',
      updateFilterableAttributesTask
    );
  }

  console.log('onIndexSetup :: all tasks completed');
};

type ImageProps = {
  type: MediaType;
  id: number;
  createdAt: Date;
  name: string | null;
  url: string;
  hash: string | null;
  height: number | null;
  width: number | null;
  nsfwLevel: number;
  userId: number;
  postId: number | null;
  index: number | null;
  scannedAt: Date | null;
  mimeType: string | null;
  meta: Prisma.JsonObject | null;
  generationProcess: ImageGenerationProcess;
  needsReview: string;
  minor: boolean | null;
  metadata: ImageMetadata | null;
  entityId: number;
} | null;

type BountyForSearchIndex = {
  id: number;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  userId: number;
  startsAt: Date;
  expiresAt: Date;
  type: BountyType;
  details: Prisma.JsonObject | null;
  complete: boolean;
  nsfwLevel: number;
  /** Marked mature by its creator; with the ratings below, it raises its images as the feed does. */
  nsfw: boolean;
  moderatorNsfwLevel: number | null;
  stats: {
    favoriteCountAllTime: number;
    trackCountAllTime: number;
    entryCountAllTime: number;
    benefactorCountAllTime: number;
    unitAmountCountAllTime: number;
    commentCountAllTime: number;
  } | null;
  user: {
    id: number;
    image: string | null;
    username: string | null;
    deletedAt: Date | null;
    profilePictureId: number | null;
    profilePicture: ImageModelWithIngestion | null;
  };
  cosmetics: {
    data: Prisma.JsonValue;
    cosmetic: {
      data: Prisma.JsonValue;
      type: CosmeticType;
      id: number;
      name: string;
      source: CosmeticSource;
    };
  }[];
  images: ImageProps[] | null;
  tags: { id: number; name: string }[] | null;
};

const WHERE = [
  Prisma.sql`b."userId" != -1`,
  Prisma.sql`(b."startsAt" <= NOW() OR b."expiresAt" >= NOW())`,
  Prisma.sql`b."availability" NOT IN ('Unsearchable'::"Availability", 'Private'::"Availability")`,
];

export const transformData = async ({
  bounties,
  imageTags,
  profilePictures,
}: {
  bounties: BountyForSearchIndex[];
  imageTags: ImageTag[];
  profilePictures: ProfileImage[];
}) => {
  const textRated = await getTextRatedBountyLevels(
    bounties.filter(mayBeTextRated).map((bounty) => bounty.id)
  );
  const records = bounties
    .map(({ cosmetics, user, tags, images: bountyImages, moderatorNsfwLevel, ...bounty }) => {
      if (!bountyImages) {
        return null;
      }
      const levels = { ...bounty, moderatorNsfwLevel };
      const flagLevel = bountyNsfwFlagLevel(levels, textRated.get(bounty.id));

      const images = bountyImages
        .filter(isDefined)
        .map((i) => ({
          ...i,
          nsfwLevel: bountyImageNsfwLevel(levels, textRated.get(bounty.id), i.nsfwLevel),
          tags: imageTags
            .filter((t) => t.imageId === i.id)
            .map((t) => ({ id: t.tagId, name: t.tag.name })),
        }))
        // The index has no viewer, so a restricted minor image is left out for everyone.
        .filter((i) => !isMinorMatureImage(i))
        .map(withoutMinorFlag);
      const profilePicture = profilePictures.find((p) => p.id === user.profilePictureId) ?? null;

      const { nsfwLevel, nsfw: _nsfw, ...rest } = bounty;
      return {
        ...rest,
        details: rest.details && publicBountyDetails(rest.details, false),
        nsfwLevel: parseBitwiseBrowsingLevel(flagLevel ?? nsfwLevel),
        tags: tags || [],
        images,
        stats: bounty.stats || null,
        user: {
          ...user,
          cosmetics: cosmetics ?? [],
          profilePicture,
        },
      };
    })
    .filter(isDefined);

  return records;
};

export type BountySearchIndexRecord = Awaited<ReturnType<typeof transformData>>[number];

type ProfileImage = Prisma.ImageGetPayload<{
  select: typeof profileImageSelect;
}>;

const imageTagSelect = { imageId: true, tagId: true, tag: { select: { name: true } } };

type ImageTag = Prisma.TagsOnImageDetailsGetPayload<{
  select: typeof imageTagSelect;
}>;

export const bountiesSearchIndex = createSearchIndexUpdateProcessor({
  indexName: INDEX_ID,
  setup: onIndexSetup,
  prepareBatches: async ({ db, logger }, lastUpdatedAt) => {
    const where = [
      ...WHERE,
      lastUpdatedAt ? Prisma.sql`b."createdAt" >= ${lastUpdatedAt}` : undefined,
    ].filter(isDefined);

    const data = await db.$queryRaw<{ startId: number; endId: number }[]>`
      SELECT MIN(id) as "startId", MAX(id) as "endId" FROM "Bounty" b
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
  pullData: async ({ db, logger, indexName }, batch) => {
    logger(`PullData :: Pulling data for batch: ${batch}`);
    const where = [
      ...WHERE,
      batch.type === 'update' ? Prisma.sql`b.id IN (${Prisma.join(batch.ids)})` : undefined,
      batch.type === 'new'
        ? Prisma.sql`b.id >= ${batch.startId} AND b.id <= ${batch.endId}`
        : undefined,
    ].filter(isDefined);

    const bounties = await db.$queryRaw<BountyForSearchIndex[]>`
      WITH target AS MATERIALIZED (
        SELECT
        b.id,
        b.name,
        b."nsfwLevel",
        b."description",
        b."createdAt",
        b."updatedAt",
        b."userId",
        b."startsAt",
        b."expiresAt",
        b."type",
        b."details",
        b."complete",
        b."nsfw",
        b."moderatorNsfwLevel"
        FROM "Bounty" b
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
          ) user
        FROM "User" u
        WHERE u.id IN (SELECT "userId" FROM target)
        GROUP BY u.id
      ), cosmetics AS MATERIALIZED (
        SELECT
          uc."userId",
          jsonb_agg(
            jsonb_build_object(
              'data', uc.data,
              'cosmetic', jsonb_build_object(
                'id', c.id,
                'data', c.data,
                'type', c.type,
                'source', c.source,
                'name', c.name,
                'leaderboardId', c."leaderboardId",
                'leaderboardPosition', c."leaderboardPosition"
              )
            )
          )  cosmetics
        FROM "UserCosmetic" uc
        JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
        AND "equippedAt" IS NOT NULL
        WHERE uc."userId" IN (SELECT "userId" FROM target) AND uc."equippedToId" IS NULL
        GROUP BY uc."userId"
      ), images AS MATERIALIZED (
        SELECT
          ic."entityId",
          jsonb_agg(
            jsonb_build_object(
              'id', i."id",
              'index', i."index",
              'postId', i."postId",
              'userId', i."userId",
              'name', i."name",
              'url', i."url",
              'nsfwLevel', i."nsfwLevel",
              'width', i."width",
              'height', i."height",
              'hash', i."hash",
              'createdAt', i."createdAt",
              'mimeType', i."mimeType",
              'scannedAt', i."scannedAt",
              'type', i."type",
              'meta', CASE WHEN i."hideMeta" THEN NULL ELSE i."meta" END,
              'generationProcess', i."generationProcess",
              'needsReview', i."needsReview",
              'minor', i."minor",
              'entityId', ic."entityId"
            )
          ) images
        FROM "Image" i
        JOIN "ImageConnection" ic ON ic."imageId" = i.id AND ic."entityId" IN (SELECT "id" FROM target) AND ic."entityType" = 'Bounty'
        -- No viewer: the images a signed-out visitor is served on the bounty page.
        WHERE ${Prisma.join(entityImageVisibilityConditions({}), ' AND ')}
        GROUP BY ic."entityId"
      ), tags AS MATERIALIZED (
        SELECT
          tob."bountyId",
          jsonb_agg(
            jsonb_build_object(
              'id', t."id",
              'name', t."name"
            )
          ) tags
        FROM "Tag" t
        JOIN "TagsOnBounty" tob ON tob."tagId" = t.id AND tob."bountyId" IN (SELECT "id" FROM target)
        GROUP BY tob."bountyId"
      ), stats as MATERIALIZED (
        SELECT
          bs."bountyId",
          jsonb_build_object(
            'favoriteCountAllTime', bs."favoriteCountAllTime",
            'trackCountAllTime', bs."trackCountAllTime",
            'entryCountAllTime', bs."entryCountAllTime",
            'benefactorCountAllTime', bs."benefactorCountAllTime",
            'unitAmountCountAllTime', bs."unitAmountCountAllTime",
            'commentCountAllTime', bs."commentCountAllTime"
          ) stats
        FROM "BountyStat" bs
        WHERE bs."bountyId" IN (SELECT id FROM target)
      )
      SELECT
        t.*,
        (SELECT tags FROM tags WHERE tags."bountyId" = t.id),
        (SELECT images FROM images i WHERE i."entityId" = t.id),
        (SELECT stats FROM stats m WHERE m."bountyId" = t.id),
        (SELECT "user" FROM users u WHERE u.id = t."userId"),
        (SELECT cosmetics FROM cosmetics c WHERE c."userId" = t."userId")
      FROM target t
      `;
    logger(`PullData :: Pulled bounties`);

    // transformData leaves these out, which would leave their earlier documents in place.
    const imageless = bounties.filter((b) => !b.images?.length).map((b) => b.id);
    if (imageless.length) await onSearchIndexDocumentsCleanup({ indexName, ids: imageless });

    if (bounties.length === 0) {
      return {
        bounties: [],
        imageTags: [],
        profilePictures: [],
      };
    }

    const imageIds = bounties
      .flatMap((b) => b.images)
      .filter(isDefined)
      .map((i) => i.id);

    const imageTags = !imageIds.length
      ? []
      : await dbRead.$queryRaw<
          {
            imageId: number;
            tagId: number;
            tag: { name: string };
          }[]
        >`
      SELECT
      toi."imageId",
      toi."tagId",
      (
        SELECT to_json(obj)
        FROM (
          SELECT t."name"
          FROM "Tag" t
          WHERE t.id = toi."tagId"
        ) as obj
      ) AS "tag"
      FROM "TagsOnImageDetails" toi
      WHERE toi."imageId" IN (${Prisma.join(imageIds)}) AND NOT toi."disabled"
    `;

    const profilePictures = await getServableProfilePictures(
      db,
      bounties.map((b) => b.user.profilePictureId).filter(isDefined)
    );

    logger(`PullData :: Pulled tags & profile pics.`);

    return {
      bounties,
      imageTags,
      profilePictures,
    };
  },
  transformData,
  pushData: async ({ indexName, jobContext }, records) => {
    await updateDocs({
      indexName,
      documents: records as any[],
      batchSize: MEILISEARCH_DOCUMENT_BATCH_SIZE,
    });

    return;
  },
});
