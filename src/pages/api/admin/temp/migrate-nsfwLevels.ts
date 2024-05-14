import { CollectionItemStatus, ImageIngestionStatus, Prisma } from '@prisma/client';
import { NextApiRequest, NextApiResponse } from 'next';
import { dbRead } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { invalidateAllSessions } from '~/server/utils/session-helpers';
import z from 'zod';
import { dataProcessor } from '~/server/db/db-helpers';
import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

type MigrationType = z.infer<typeof migrationTypes>;
const migrationTypes = z.enum([
  'images',
  'users',
  'posts',
  'articles',
  'bounties',
  'bountyEntries',
  'modelVersions',
  'models',
  'collections',
]);
const schema = z.object({
  concurrency: z.coerce.number().min(1).max(50).optional().default(15),
  batchSize: z.coerce.number().min(0).optional().default(500),
  start: z.coerce.number().min(0).optional().default(0),
  end: z.coerce.number().min(0).optional(),
  after: z.coerce.date().optional(),
  before: z.coerce.date().optional(),
  type: z
    .union([migrationTypes, migrationTypes.array()])
    .transform((val) => (Array.isArray(val) ? val : [val]))
    .optional(),
});

export default WebhookEndpoint(async (req, res) => {
  const params = schema.parse(req.query);
  const availableMigrations: Array<{
    type: MigrationType;
    fn: (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  }> = [
    // {
    //   type: 'users',
    //   fn: migrateUsers,
    // },
    // {
    //   type: 'images',
    //   fn: migrateImages,
    // },
    // {
    //   type: 'posts',
    //   fn: migratePosts,
    // },
    // {
    //   type: 'articles',
    //   fn: migrateArticles,
    // },
    // {
    //   type: 'bounties',
    //   fn: migrateBounties,
    // },
    // {
    //   type: 'bountyEntries',
    //   fn: migrateBountyEntries,
    // },
    {
      type: 'modelVersions',
      fn: migrateModelVersions,
    },
    {
      type: 'models',
      fn: migrateModels,
    },
    // {
    //   type: 'collections',
    //   fn: migrateCollections,
    // },
  ];

  const migrations = params.type
    ? availableMigrations.filter((x) => params.type?.includes(x.type))
    : availableMigrations;

  console.time('MIGRATION_TIMER');
  for (const migration of migrations) {
    console.log(`START ${migration.type}`);
    await migration.fn(req, res);
    console.log(`END ${migration.type}`);
  }
  console.timeEnd('MIGRATION_TIMER');
  res.status(200).json({ finished: true });
});

async function migrateImages(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
        WITH dates AS (
          SELECT
          MIN("createdAt") as start,
          MAX("createdAt") as end
          FROM "Image" WHERE "createdAt" > ${params.after}
        )
        SELECT MIN(id) as start, MAX(id) as end
        FROM "Image" i
        JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Image";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        UPDATE "Image" i
        SET "nsfwLevel" = (
          SELECT COALESCE(MAX(t."nsfwLevel"), 0)
          FROM "TagsOnImage" toi
          JOIN "Tag" t ON t.id = toi."tagId"
          WHERE toi."imageId" = i.id
            AND NOT toi.disabled
        )
        WHERE i.id BETWEEN ${start} AND ${end} AND i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus" AND NOT i."nsfwLevelLocked";
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated images ${start} - ${end}`);
    },
  });
}

async function migrateUsers(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        if (params.after) {
          const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "User" WHERE "createdAt" > ${params.after}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "User" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
          return results[0];
        }
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "User";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        UPDATE "User" SET
          "browsingLevel" = 1,
          "onboarding" = (
              IIF(tos, 1, 0) +
              IIF(username IS NOT NULL AND email IS NOT NULL, 2, 0) +
              IIF('Buzz'::"OnboardingStep" = ANY("onboardingSteps"), 0, 8)
            )
        WHERE id BETWEEN ${start} AND ${end};
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated users ${start} - ${end}`);
    },
  });

  await invalidateAllSessions();
}

async function migratePosts(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "Post" WHERE "createdAt" > ${params.after}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "Post" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Post";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level AS (
          SELECT DISTINCT ON (p.id) p.id, bit_or(i."nsfwLevel") "nsfwLevel"
          FROM "Post" p
          JOIN "Image" i ON i."postId" = p.id
          WHERE p.id BETWEEN ${start} AND ${end}
          GROUP BY p.id
        )
        UPDATE "Post" p
        SET "nsfwLevel" = level."nsfwLevel"
        FROM level
        WHERE level.id = p.id AND level."nsfwLevel" != p."nsfwLevel";
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated posts ${start} - ${end}`);
    },
  });
}

async function migrateBounties(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "Bounty" WHERE "createdAt" > ${params.after}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "Bounty" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Bounty";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level AS (
          SELECT DISTINCT ON ("entityId")
            "entityId",
            bit_or(i."nsfwLevel") "nsfwLevel"
          FROM "ImageConnection" ic
          JOIN "Image" i ON i.id = ic."imageId"
          JOIN "Bounty" b on b.id = ic."entityId" AND ic."entityType" = 'Bounty'
          WHERE ic."entityType" = 'Bounty' AND ic."entityId" BETWEEN ${start} AND ${end}
          GROUP BY 1
        )
        UPDATE "Bounty" b SET "nsfwLevel" = (
          CASE
            WHEN b.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
            ELSE level."nsfwLevel"
          END
        )
        FROM level
        WHERE level."entityId" = b.id AND level."nsfwLevel" != b."nsfwLevel";
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated bounties ${start} - ${end}`);
    },
  });
}

async function migrateBountyEntries(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "BountyEntry" WHERE "createdAt" > ${params.after}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "BountyEntry" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "BountyEntry";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level AS (
          SELECT DISTINCT ON ("entityId")
            "entityId",
            bit_or(i."nsfwLevel") "nsfwLevel"
          FROM "ImageConnection" ic
          JOIN "Image" i ON i.id = ic."imageId"
          JOIN "BountyEntry" b on b.id = "entityId" AND ic."entityType" = 'BountyEntry'
          WHERE ic."entityType" = 'BountyEntry' AND ic."entityId" BETWEEN ${start} AND ${end}
          GROUP BY 1
        )
        UPDATE "BountyEntry" b SET "nsfwLevel" = level."nsfwLevel"
        FROM level
        WHERE level."entityId" = b.id;
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated bounties ${start} - ${end}`);
    },
  });
}

async function migrateModelVersions(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "ModelVersion" WHERE "createdAt" > ${params.after}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "ModelVersion" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "ModelVersion";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level as (
          SELECT
            mv.id,
            CASE
              WHEN m.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
              WHEN m."userId" = -1 THEN (
                SELECT COALESCE(bit_or(ranked."nsfwLevel"), 0) "nsfwLevel"
                FROM (
                  SELECT
                  ir."imageId" id,
                  ir."modelVersionId",
                  row_number() OVER (PARTITION BY ir."modelVersionId" ORDER BY im."reactionCount" DESC) row_num,
                  i."nsfwLevel"
                  FROM "ImageResource" ir
                  JOIN "Image" i ON i.id = ir."imageId"
                  JOIN "Post" p ON p.id = i."postId"
                  JOIN "ImageMetric" im ON im."imageId" = ir."imageId" AND im.timeframe = 'AllTime'::"MetricTimeframe"
                  WHERE ir."modelVersionId" = mv.id
                  AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0
                ) AS ranked
                WHERE ranked.row_num <= 20
              )
              WHEN m."userId" != -1 THEN (
                SELECT COALESCE(bit_or(i."nsfwLevel"), 0) "nsfwLevel"
                FROM (
                  SELECT
                    i."nsfwLevel"
                  FROM "Post" p
                  JOIN "Image" i ON i."postId" = p.id
                  WHERE p."modelVersionId" = mv.id
                  AND p."userId" = m."userId"
                  AND p."publishedAt" IS NOT NULL AND i."nsfwLevel" != 0
                  ORDER BY p."id", i."index"
                  LIMIT 20
                ) AS i
              )
            END AS "nsfwLevel"
          FROM "ModelVersion" mv
          JOIN "Model" m ON mv."modelId" = m.id
          WHERE mv.id BETWEEN ${start} AND ${end}
        )
        UPDATE "ModelVersion" mv
        SET "nsfwLevel" = level."nsfwLevel"
        FROM level
        WHERE level.id = mv.id AND level."nsfwLevel" != mv."nsfwLevel";
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated modelVersions ${start} - ${end}`);
    },
  });
}

async function migrateModels(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "Model" WHERE "createdAt" > ${params.after}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "Model" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Model";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level AS (
          SELECT
            mv."modelId" as "id",
            bit_or(mv."nsfwLevel") "nsfwLevel"
          FROM "ModelVersion" mv
          WHERE mv."modelId" BETWEEN ${start} AND ${end}
          GROUP BY mv."modelId"
        )
        UPDATE "Model" m
        SET "nsfwLevel" = (
          CASE
            WHEN m.nsfw = TRUE THEN ${nsfwBrowsingLevelsFlag}
            ELSE level."nsfwLevel"
          END
        )
        FROM level
        WHERE level.id = m.id AND level."nsfwLevel" != m."nsfwLevel";
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated models ${start} - ${end}`);
    },
  });
}

async function migrateCollections(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "Collection" WHERE "createdAt" > ${params.after}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "Collection" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Collection";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
          UPDATE "Collection" c
          SET "nsfwLevel" = (
            SELECT COALESCE(bit_or(COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel",0)), 0)
            FROM "CollectionItem" ci
            LEFT JOIN "Image" i on i.id = ci."imageId" AND c.type = 'Image'
            LEFT JOIN "Post" p on p.id = ci."postId" AND c.type = 'Post' AND p."publishedAt" IS NOT NULL
            LEFT JOIN "Model" m on m.id = ci."modelId" AND c.type = 'Model' AND m."status" = 'Published'
            LEFT JOIN "Article" a on a.id = ci."articleId" AND c.type = 'Article' AND a."publishedAt" IS NOT NULL
            WHERE ci."collectionId" = c.id AND ci.status = ${CollectionItemStatus.ACCEPTED}::"CollectionItemStatus"
          )
          WHERE c.id BETWEEN ${start} AND ${end};
      `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated collections ${start} - ${end}`);
    },
  });
}

async function migrateArticles(req: NextApiRequest, res: NextApiResponse) {
  const params = schema.parse(req.query);
  await dataProcessor({
    params,
    runContext: res,
    rangeFetcher: async (context) => {
      if (params.after) {
        const results = await dbRead.$queryRaw<{ start: number; end: number }[]>`
          WITH dates AS (
            SELECT
            MIN("createdAt") as start,
            MAX("createdAt") as end
            FROM "Article" WHERE "createdAt" > ${params.after}
          )
          SELECT MIN(id) as start, MAX(id) as end
          FROM "Article" i
          JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";`;
        return results[0];
      }
      const [{ max }] = await dbRead.$queryRaw<{ max: number }[]>(
        Prisma.sql`SELECT MAX(id) "max" FROM "Article";`
      );
      return { ...context, end: max };
    },
    processor: async ({ start, end, cancelFns }) => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
      WITH level AS (
        SELECT DISTINCT ON (a.id) a.id, bit_or(i."nsfwLevel") "nsfwLevel"
        FROM "Article" a
        JOIN "Image" i ON a."coverId" = i.id
        WHERE a.id BETWEEN ${start} AND ${end}
        GROUP BY a.id
      )
      UPDATE "Article" a
      SET "nsfwLevel" = (
        CASE
          WHEN a."userNsfwLevel" > a."nsfwLevel" THEN a."userNsfwLevel"
          ELSE level."nsfwLevel"
        END
      )
      FROM level
      WHERE level.id = a.id AND level."nsfwLevel" != a."nsfwLevel";
    `);
      cancelFns.push(cancel);
      await result();
      console.log(`Updated ${params.type} ${start} - ${end}`);
    },
  });
}
