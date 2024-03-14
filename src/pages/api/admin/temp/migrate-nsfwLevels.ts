import { ImageIngestionStatus, Prisma } from '@prisma/client';
import { NextApiResponse } from 'next';
import { NsfwLevel } from '~/server/common/enums';
import { dbRead } from '~/server/db/client';
import { pgDbWrite } from '~/server/db/pgDb';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { invalidateAllSessions } from '~/server/utils/session-helpers';

const BATCH_SIZE = 500;
const CONCURRENCY_LIMIT = 50;
export default WebhookEndpoint(async (req, res) => {
  const migrations = [
    [migrateImages, migrateUsers],
    [migratePosts, migrateArticles, migrateBounties, migrateBountyEntries],
    [migrateModelVersions],
    [migrateModels],
    [migrateCollections],
  ];

  console.time('run migrations');
  let counter = 0;
  for (const steps of migrations) {
    await Promise.all(steps.map((step) => step(res)));
    counter++;
    console.log(`end ${counter}`);
  }
  console.timeEnd('run migrations');

  res.status(200).json({ finished: true });
});

async function migrateImages(res: NextApiResponse) {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  const [{ max: maxImageId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "Image";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Image";`
  );

  let cursor = min ?? 0;
  await limitConcurrency(() => {
    if (cursor > maxImageId || shouldStop) return null; // We've reached the end of the images
    const start = cursor;
    cursor += BATCH_SIZE;
    const end = cursor;
    console.log(`Updating images ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        UPDATE "Image" i
        SET "nsfwLevel" = (
          SELECT COALESCE(MAX(t."nsfwLevel"), 0)
          FROM "TagsOnImage" toi
          JOIN "Tag" t ON t.id = toi."tagId"
          WHERE toi."imageId" = i.id
            AND NOT toi.disabled
        )
        WHERE i.id BETWEEN ${start} AND ${end} AND i.ingestion = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
      `);
      onCancel.push(cancel);
      await result();
    };
  }, CONCURRENCY_LIMIT);
}

async function migrateUsers(res: NextApiResponse) {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "User";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "User";`
  );

  let cursor = min ?? 0;
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images
    const start = cursor;
    cursor += BATCH_SIZE;
    const end = cursor;
    console.log(`Updating users ${start} - ${end}`);
    return async () => {
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
      onCancel.push(cancel);
      await result();
    };
  }, CONCURRENCY_LIMIT);

  await invalidateAllSessions();
}

async function migratePosts(res: NextApiResponse) {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "Post";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Post";`
  );

  let cursor = min ?? 0;
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += BATCH_SIZE;
    const end = cursor;
    console.log(`Updating posts ${start} - ${end}`);
    return async () => {
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
        WHERE level.id = p.id;
      `);
      onCancel.push(cancel);
      await result();
    };
  }, CONCURRENCY_LIMIT);
}

async function migrateBounties(res: NextApiResponse) {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "Bounty";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Bounty";`
  );

  let cursor = min ?? 0;
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += BATCH_SIZE;
    const end = cursor;
    console.log(`Updating bounties ${start} - ${end}`);
    return async () => {
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
            WHEN b.nsfw = TRUE THEN ${NsfwLevel.XXX}
            ELSE level."nsfwLevel"
          END
        )
        FROM level
        WHERE level."entityId" = b.id AND level."nsfwLevel" != b."nsfwLevel";
      `);
      onCancel.push(cancel);
      await result();
    };
  }, CONCURRENCY_LIMIT);
}

async function migrateBountyEntries(res: NextApiResponse) {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "BountyEntry";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "BountyEntry";`
  );

  let cursor = min ?? 0;
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += BATCH_SIZE;
    const end = cursor;
    console.log(`Updating bounty entries ${start} - ${end}`);
    return async () => {
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
      onCancel.push(cancel);
      await result();
    };
  }, CONCURRENCY_LIMIT);
}

async function migrateModelVersions(res: NextApiResponse) {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });

  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "ModelVersion";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "ModelVersion";`
  );

  let cursor = min ?? 0;
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += BATCH_SIZE;
    const end = cursor;
    console.log(`Updating modelVersions ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level as (
          SELECT
            mv.id,
            CASE
              WHEN m.nsfw = TRUE THEN ${NsfwLevel.XXX}
              ELSE (
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
      onCancel.push(cancel);
      await result();
    };
  }, CONCURRENCY_LIMIT);
}

async function migrateModels(res: NextApiResponse) {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "Model";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Model";`
  );

  let cursor = min ?? 0;
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += BATCH_SIZE;
    const end = cursor;
    console.log(`Updating models ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
        WITH level AS (
          SELECT DISTINCT ON ("modelId")
            mv."modelId" as "id",
            bit_or(mv."nsfwLevel") "nsfwLevel"
          FROM "ModelVersion" mv
          JOIN "Model" m on m.id = mv."modelId"
          WHERE m.id BETWEEN ${start} AND ${end}
          GROUP BY mv.id
        )
        UPDATE "Model" m
        SET "nsfwLevel" = (
          CASE
            WHEN m.nsfw = TRUE THEN ${NsfwLevel.XXX}
            ELSE level."nsfwLevel"
          END
        )
        FROM level
        WHERE level.id = m.id AND level."nsfwLevel" != m."nsfwLevel";
      `);
      onCancel.push(cancel);
      await result();
    };
  }, CONCURRENCY_LIMIT);
}

async function migrateCollections(res: NextApiResponse) {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "Collection";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Collection";`
  );

  let cursor = min ?? 0;
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += BATCH_SIZE;
    const end = cursor;
    console.log(`Updating collections ${start} - ${end}`);
    return async () => {
      const { cancel, result } = await pgDbWrite.cancellableQuery(Prisma.sql`
          UPDATE "Collection" c
          SET "nsfwLevel" = (
            SELECT COALESCE(bit_or(COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel",0)), 0)
            FROM "CollectionItem" ci
            LEFT JOIN "Image" i on i.id = ci."imageId" AND c.type = 'Image'
            LEFT JOIN "Post" p on p.id = ci."postId" AND c.type = 'Post' AND p."publishedAt" IS NOT NULL
            LEFT JOIN "Model" m on m.id = ci."modelId" AND c.type = 'Model' AND m."status" = 'Published'
            LEFT JOIN "Article" a on a.id = ci."articleId" AND c.type = 'Article' AND a."publishedAt" IS NOT NULL
            WHERE ci."collectionId" = c.id
          )
          WHERE c.id BETWEEN ${start} AND ${end};
      `);
      onCancel.push(cancel);
      await result();
    };
  }, CONCURRENCY_LIMIT);
}

async function migrateArticles(res: NextApiResponse) {
  const onCancel: (() => Promise<void>)[] = [];
  let shouldStop = false;
  res.on('close', async () => {
    console.log('Cancelling');
    shouldStop = true;
    await Promise.all(onCancel.map((cancel) => cancel()));
  });
  const [{ max: maxId }] = await dbRead.$queryRaw<{ max: number }[]>(
    Prisma.sql`SELECT MAX(id) "max" FROM "Article";`
  );
  const [{ min }] = await dbRead.$queryRaw<{ min: number }[]>(
    Prisma.sql`SELECT MIN(id) "min" FROM "Article";`
  );

  let cursor = min ?? 0;
  await limitConcurrency(() => {
    if (cursor > maxId || shouldStop) return null; // We've reached the end of the images

    const start = cursor;
    cursor += BATCH_SIZE;
    const end = cursor;
    console.log(`Updating articles ${start} - ${end}`);
    return async () => {
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
      onCancel.push(cancel);
      await result();
    };
  }, CONCURRENCY_LIMIT);
}
