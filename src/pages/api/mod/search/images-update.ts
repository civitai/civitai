import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead, dbWrite } from '~/server/db/client';
import { z } from 'zod';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { IMAGES_SEARCH_INDEX } from '../../../../server/common/constants';
import { updateDocs } from '../../../../server/meilisearch/client';
import { CosmeticSource, CosmeticType, ImageIngestionStatus, Prisma } from '@prisma/client';
import { isDefined } from '../../../../utils/type-guards';
import { withRetries } from '../../../../server/utils/errorHandling';
import {
  ImageModelWithIngestion,
  profileImageSelect,
} from '../../../../server/selectors/image.selector';

const BATCH_SIZE = 10000;
const INDEX_ID = IMAGES_SEARCH_INDEX;
const IMAGE_WHERE: (idOffset: number) => Prisma.Sql[] = (idOffset: number) => [
  Prisma.sql`i."id" > ${idOffset}`,
  Prisma.sql`i."postId" IS NOT NULL`,
  Prisma.sql`i."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"`,
  Prisma.sql`i."tosViolation" = false`,
  Prisma.sql`i."type" = 'image'`,
  Prisma.sql`i."needsReview" IS NULL`,
  Prisma.sql`p."publishedAt" IS NOT NULL`,
  Prisma.sql`p.metadata->>'unpublishedAt' IS NULL`,
  Prisma.sql`p."availability" != 'Private'::"Availability"`,
];

const schema = z.object({
  update: z.enum(['user']),
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

export default ModEndpoint(
  async function updateImageSearchIndex(req: NextApiRequest, res: NextApiResponse) {
    const { update } = schema.parse(req.query);
    const start = Date.now();
    const updateMethod: ((idOffset: number) => Promise<number>) | null =
      update === 'user' ? updateUserDetails : null;

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
