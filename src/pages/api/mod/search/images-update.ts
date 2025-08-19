import { Prisma } from '@prisma/client';
import type { CosmeticSource, CosmeticType } from '~/shared/utils/prisma/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { IMAGES_SEARCH_INDEX } from '~/server/common/constants';
import type { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { dataProcessor } from '~/server/db/db-helpers';
import { updateDocs } from '~/server/meilisearch/client';
import type { ImageModelWithIngestion } from '~/server/selectors/image.selector';
import { profileImageSelect } from '~/server/selectors/image.selector';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { withRetries } from '~/server/utils/errorHandling';
import { isDefined } from '~/utils/type-guards';

const BATCH_SIZE = 10000;
const INDEX_ID = IMAGES_SEARCH_INDEX;
const IMAGE_WHERE: (start: number, end?: number) => Prisma.Sql[] = (
  start: number,
  end?: number
) => [
  end ? Prisma.sql`i."id" BETWEEN ${start} AND ${end}` : Prisma.sql`i."id" > ${start}`,
  Prisma.sql`i."postId" IS NOT NULL`,
  Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
  Prisma.sql`i."tosViolation" = false`,
  Prisma.sql`i."needsReview" IS NULL`,
  Prisma.sql`p."publishedAt" IS NOT NULL`,
  Prisma.sql`p."availability" != 'Private'::"Availability"`,
];

const schema = z.object({
  update: z.enum(['user', 'dateFields', 'nsfw', 'flags']),
});

const updateUserDetails = (idOffset: number) =>
  withRetries(async () => {
    type ImageForSearchIndex = {
      id: number;
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
    };

    console.log('Fetching records from ID: ', idOffset);
    const records = await dbRead.$queryRaw<ImageForSearchIndex[]>`
      WITH target AS MATERIALIZED (
        SELECT
          i."id",
          i."userId"
        FROM "Image" i
        JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" < now()
        WHERE ${Prisma.join(IMAGE_WHERE(idOffset), ' AND ')}
        ORDER BY i."id"
        LIMIT ${BATCH_SIZE}
      ), users AS MATERIALIZED (
        SELECT
          u.id,
          jsonb_build_object(
            'id', u.id,
            'username', u.username,
            'deletedAt', u."deletedAt",
            'image', u.image,
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
      )
      SELECT
        t.*,
        (SELECT "user" FROM users u WHERE u.id = t."userId"),
        (SELECT cosmetics FROM cosmetics c WHERE c."userId" = t."userId")
      FROM target t`;

    console.log(
      'Fetched records: ',
      records[0]?.id ?? 'N/A',
      ' - ',
      records[records.length - 1]?.id ?? 'N/A'
    );

    if (records.length === 0) {
      return -1;
    }

    const profilePictures = await dbRead.image.findMany({
      where: { id: { in: records.map((i) => i.user.profilePictureId).filter(isDefined) } },
      select: profileImageSelect,
    });

    const updateIndexReadyRecords = records.map(({ user, cosmetics, ...imageRecord }) => {
      const profilePicture = profilePictures.find((p) => p.id === user.profilePictureId) ?? null;

      return {
        ...imageRecord,
        user: {
          ...user,
          cosmetics: cosmetics ?? [],
          profilePicture,
        },
      };
    });

    if (updateIndexReadyRecords.length === 0) {
      return -1;
    }

    await updateDocs({
      indexName: INDEX_ID,
      documents: updateIndexReadyRecords,
      batchSize: BATCH_SIZE,
    });

    console.log('Indexed records count: ', updateIndexReadyRecords.length);

    return updateIndexReadyRecords[updateIndexReadyRecords.length - 1].id;
  });

const updateDateFields = (idOffset: number) =>
  withRetries(async () => {
    type ImageForSearchIndex = {
      id: number;
      sortAt?: Date;
      publishedAt?: Date;
    };

    console.log('Fetching records from ID: ', idOffset);
    const records = await dbRead.$queryRaw<ImageForSearchIndex[]>`
        SELECT
          i."id",
          GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt",
          p."publishedAt" as "publishedAt"
        FROM "Image" i
        JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" < now()
        WHERE ${Prisma.join(IMAGE_WHERE(idOffset), ' AND ')}
        ORDER BY i."id"
        LIMIT ${BATCH_SIZE};
    `;

    console.log(
      'Fetched records: ',
      records[0]?.id ?? 'N/A',
      ' - ',
      records[records.length - 1]?.id ?? 'N/A'
    );

    if (records.length === 0) {
      return -1;
    }

    await updateDocs({
      indexName: INDEX_ID,
      documents: records,
      batchSize: BATCH_SIZE,
    });

    console.log('Indexed records count: ', records.length);

    return records[records.length - 1].id;
  });

async function updateNsfw() {
  await dataProcessor({
    params: { batchSize: 100000, concurrency: 10, start: 0 },
    runContext: {
      on: (event: 'close', listener: () => void) => {
        // noop
      },
    },
    rangeFetcher: async (ctx) => {
      const [{ start, end }] = await dbRead.$queryRaw<{ start: number; end: number }[]>`
        WITH dates AS (
          SELECT
          MIN("createdAt") as start,
          MAX("createdAt") as end
          FROM "Image"
        )
        SELECT MIN(id) as start, MAX(id) as end
        FROM "Image" i
        JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";
      `;

      return { start, end };
    },
    processor: async ({ start, end }) => {
      type ImageForSearchIndex = {
        id: number;
        nsfwLevel: NsfwLevel;
        aiNsfwLevel: NsfwLevel;
        nsfwLevelLocked: boolean;
      };

      const consoleFetchKey = `Fetch: ${start} - ${end}`;
      console.log(consoleFetchKey);
      console.time(consoleFetchKey);
      const records = await dbRead.$queryRaw<ImageForSearchIndex[]>`
        SELECT
          i."id",
          p."publishedAt",
          GREATEST(p."publishedAt", i."scannedAt", i."createdAt") as "sortAt",
          i."nsfwLevel",
          i."aiNsfwLevel",
          i."nsfwLevelLocked"
        FROM "Image" i
        JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" < now()
        WHERE ${Prisma.join(IMAGE_WHERE(start, end), ' AND ')}
      `;
      console.timeEnd(consoleFetchKey);

      if (records.length === 0) {
        console.log(`No updates found:  ${start} - ${end}`);
        return;
      }

      const consoleTransformKey = `Transform: ${start} - ${end}`;
      console.log(consoleTransformKey);
      console.time(consoleTransformKey);
      const documents = records.map(({ nsfwLevelLocked, ...r }) => ({
        ...r,
        combinedNsfwLevel: nsfwLevelLocked ? r.nsfwLevel : Math.max(r.nsfwLevel, r.aiNsfwLevel),
      }));
      console.timeEnd(consoleTransformKey);

      const consolePushKey = `Push: ${start} - ${end}`;
      console.log(consolePushKey);
      console.time(consolePushKey);
      await updateDocs({
        indexName: INDEX_ID,
        documents,
        batchSize: 100000,
      });
      console.timeEnd(consolePushKey);
    },
  });
}

async function updateFlags() {
  await dataProcessor({
    params: { batchSize: 100000, concurrency: 10, start: 0 },
    runContext: {
      on: (event: 'close', listener: () => void) => {
        // noop
      },
    },
    rangeFetcher: async (ctx) => {
      const [{ start, end }] = await dbRead.$queryRaw<{ start: number; end: number }[]>`
        SELECT
          MIN("imageId") as start,
          MAX("imageId") as end
        FROM "ImageFlag"
      `;

      return { start, end };
    },
    processor: async ({ start, end }) => {
      type ImageWithImageFlag = {
        imageId: number;
        promptNsfw?: boolean;
      };

      const consoleFetchKey = `Fetch: ${start} - ${end}`;
      console.log(consoleFetchKey);
      console.time(consoleFetchKey);
      const records = await dbRead.$queryRaw<ImageWithImageFlag[]>`
        SELECT fl.*
        FROM "ImageFlag" fl
        JOIN "Image" i ON i."id" = fl."imageId"
        JOIN "Post" p ON p."id" = i."postId" AND p."publishedAt" < now()
        WHERE ${Prisma.join(IMAGE_WHERE(start, end), ' AND ')}
      `;
      console.timeEnd(consoleFetchKey);

      if (records.length === 0) {
        console.log(`No updates found:  ${start} - ${end}`);
        return;
      }

      const documents = records.map(({ imageId, ...flags }) => ({ id: imageId, flags }));

      const consolePushKey = `Push: ${start} - ${end}`;
      console.log(consolePushKey);
      console.time(consolePushKey);
      await updateDocs({
        indexName: INDEX_ID,
        documents,
        batchSize: 100000,
      });
      console.timeEnd(consolePushKey);
    },
  });
}

export default ModEndpoint(
  async function updateImageSearchIndex(req: NextApiRequest, res: NextApiResponse) {
    const { update } = schema.parse(req.query);
    const start = Date.now();
    if (update === 'nsfw') {
      await updateNsfw();
      return res.status(200).json({ ok: true, duration: Date.now() - start });
    }

    if (update === 'flags') {
      await updateFlags();
      return res.status(200).json({ ok: true, duration: Date.now() - start });
    }

    const updateMethod: ((idOffset: number) => Promise<number>) | null =
      update === 'user' ? updateUserDetails : update === 'dateFields' ? updateDateFields : null;

    try {
      if (!updateMethod) {
        return res.status(400).json({ ok: false, message: 'Invalid update method' });
      }

      let id = -1;
      while (true) {
        const updatedId = await updateMethod(id);

        if (updatedId === -1) {
          break;
        }

        id = updatedId;
      }

      return res.status(200).json({ ok: true, duration: Date.now() - start });
    } catch (error: unknown) {
      res.status(500).send(error);
    }
  },
  ['GET']
);
