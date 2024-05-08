import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { CacheTTL } from '~/server/common/constants';
import { dbRead, dbWrite } from '~/server/db/client';
import { redis, REDIS_KEYS } from '~/server/redis/client';
import { moderatorProcedure, protectedProcedure, router } from '~/server/trpc';
import { cachedCounter } from '~/server/utils/cache-helpers';
import { calculateLevelProgression } from '~/server/utils/research-utils';
import { queueNewRaterLevelWebhook } from '~/server/webhooks/research.webhooks';
import { getRandomInt } from '~/utils/number-helpers';
import { NsfwLevel } from '~/server/common/enums';

const raterGetImagesSchema = z.object({
  level: z.number().transform((val) => val & ~32), // Remove the "Blocked" bit (32)
  cursor: z.number().optional(),
  tag: z.string().optional(),
});

const raterSetRatingsSchema = z.object({
  ratings: z.record(z.string(), z.number()),
  trackId: z.string().optional(),
});

const raterUpdateSanityImagesSchema = z.object({
  add: z.number().array().optional(),
  remove: z.number().array().optional(),
});

const trackSchema = z.object({
  startingPoint: z.number(),
  startTime: z.coerce.date(),
  filters: z
    .object({
      tags: z.number().array().optional(),
      misaligned: z.boolean().optional(),
      ratingModel: z.string().optional(),
    })
    .optional(),
});

async function getUserPosition(userId: number) {
  const position = {
    trackId: undefined as string | undefined,
    trackPosition: undefined as number | undefined,
  };

  const userProgress = await redis.hGetAll(REDIS_KEYS.RESEARCH.RATINGS_PROGRESS + ':' + userId);
  if (userProgress) {
    position.trackId = userProgress.currentTrack;
    if (userProgress[`track:${position.trackId}`])
      position.trackPosition = Number(userProgress[`track:${position.trackId}`]);
  }

  return position;
}

export type RaterImage = { id: number; url: string; nsfwLevel: number | null };
export type SanityImage = {
  id: number;
  url: string;
  width: number;
  height: number;
  hash: string;
  nsfwLevel: NsfwLevel;
};
export const ratingsCounter = cachedCounter(
  REDIS_KEYS.RESEARCH.RATINGS_COUNT,
  async (userId: number) => {
    const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>`
    WITH last_reset AS (
      SELECT COALESCE(MAX("createdAt"), '2024-03-01') date
      FROM research_ratings_resets
      WHERE "userId" = ${userId}
    )
    SELECT COUNT(*) as count
    FROM "research_ratings" rr
    JOIN last_reset lr ON rr."createdAt" > lr.date
    WHERE rr."userId" = ${userId};
  `;
    return Number(count ?? 0);
  }
);

async function getSanityIds() {
  const sanityIds = ((await redis.sMembers(REDIS_KEYS.RESEARCH.RATINGS_SANITY_IDS)) ?? []).map(
    Number
  );
  return sanityIds;
}

async function getUserSanity(userId: number, sanityIds?: number[], refresh = false) {
  const cacheKey = REDIS_KEYS.RESEARCH.RATINGS_PROGRESS + ':' + userId;
  if (!refresh) {
    const cachedStrikes = await redis.hGet(cacheKey, 'strikes');
    if (cachedStrikes)
      return {
        strikes: Number(cachedStrikes),
        sane: Number(cachedStrikes) < 3,
      };
  }

  if (!sanityIds) sanityIds = await getSanityIds();
  const [{ strikes }] = await dbWrite.$queryRaw<{ strikes: number }[]>`
    WITH last_reset AS (
      SELECT COALESCE(MAX("createdAt"), '2024-03-01') date
      FROM research_ratings_resets
      WHERE "userId" = ${userId}
    )
    SELECT COUNT(*) as strikes
    FROM "research_ratings" rr
    JOIN last_reset lr ON rr."createdAt" > lr.date
    JOIN "Image" i ON rr."imageId" = i.id
    WHERE i."nsfwLevel" != rr."nsfwLevel"
      AND rr."imageId" IN (${Prisma.join(sanityIds)})
      AND rr."userId" = ${userId};
  `;
  await redis.hSet(cacheKey, 'strikes', strikes.toString());
  return { strikes: Number(strikes), sane: strikes < 3 };
}

export const researchRouter = router({
  raterGetStatus: protectedProcedure.query(async ({ ctx }) => {
    const count = await ratingsCounter.get(ctx.user.id);
    const sanityIds = await getSanityIds();
    let sanityImages: RaterImage[] = [];
    const { strikes, sane } = await getUserSanity(ctx.user.id, sanityIds);
    if (sane) {
      sanityImages = await dbRead.$queryRaw<RaterImage[]>`
        SELECT i.id, i.url, null as "nsfwLevel"
        FROM "Image" i
        WHERE i.id IN (${Prisma.join(sanityIds)});
      `;
    }

    return { count, sanityImages, sane, strikes };
  }),
  raterGetImages: protectedProcedure.input(raterGetImagesSchema).query(async ({ ctx, input }) => {
    // Get the user's current position
    const userPosition = await getUserPosition(ctx.user.id);
    const tracks = await redis.hGetAll(REDIS_KEYS.RESEARCH.RATINGS_TRACKS);
    const foundTrack = userPosition.trackId && tracks[userPosition.trackId];
    if (!foundTrack) {
      input.cursor = undefined; // Reset the cursor if we don't have a track
      const trackIds = Object.keys(tracks);
      userPosition.trackId = trackIds[getRandomInt(0, trackIds.length)];
      userPosition.trackPosition = undefined;
    }
    const track = trackSchema.parse(JSON.parse(tracks[userPosition.trackId!]));

    if (!userPosition.trackPosition) {
      userPosition.trackPosition = track.startingPoint;
      const [highestImageId] = await dbRead.$queryRaw<{ id: number }[]>`
        SELECT MAX(rr."imageId") as id
        FROM research_ratings rr
        WHERE rr."userId" = ${ctx.user.id}
          AND rr."imageId" BETWEEN ${track.startingPoint} AND ${track.startingPoint + 300000}
          AND rr."createdAt" > ${track.startTime.toISOString()}::timestamp;
      `;
      if (highestImageId?.id) userPosition.trackPosition = highestImageId.id;
    }

    // Set the user's position if they don't have one
    if (!foundTrack) {
      await redis.hSet(REDIS_KEYS.RESEARCH.RATINGS_PROGRESS + ':' + ctx.user.id, {
        currentTrack: userPosition.trackId!.toString(),
        [`track:${userPosition.trackId}`]: userPosition.trackPosition!.toString(),
      });
      await redis.expire(REDIS_KEYS.RESEARCH.RATINGS_PROGRESS + ':' + ctx.user.id, CacheTTL.week);
    }

    // Get the images
    input.cursor ??= userPosition.trackPosition;
    const where = [Prisma.sql`i.id > ${input.cursor}`];
    if (track.filters?.tags) {
      where.push(Prisma.sql`EXISTS (
        SELECT 1 FROM "ImageTag" it
        WHERE it."imageId" = i.id
          AND it."tagId" IN (${Prisma.join(track.filters.tags)})
      )`);
    }

    if (track.filters?.misaligned) {
      where.push(Prisma.sql`i."nsfwLevel" != i."aiNsfwLevel" AND i."aiNsfwLevel" > 0`);
    }

    if (track.filters?.ratingModel) {
      where.push(Prisma.sql`i."aiModel" = ${track.filters.ratingModel}`);
    }

    const images = await dbRead.$queryRaw<RaterImage[]>`
      SELECT i.id, i.url, i."nsfwLevel"
      FROM "Image" i
      JOIN "Post" p ON i."postId" = p.id
      WHERE (i."nsfwLevel" & ${input.level}) != 0
        AND i.type = 'image'
        AND p."publishedAt" IS NOT NULL
        AND ${Prisma.join(where, ' AND ')}
      ORDER BY i.id
      LIMIT 30;
    `;

    return {
      images,
      trackId: userPosition.trackId,
    };
  }),
  raterSetRatings: protectedProcedure
    .input(raterSetRatingsSchema)
    .mutation(async ({ input, ctx }) => {
      const currentSanity = await getUserSanity(ctx.user.id);
      const count = await ratingsCounter.get(ctx.user.id);
      const values = Object.entries(input.ratings).map(
        ([imageId, nsfwLevel]) =>
          `(${ctx.user.id}, ${Number(imageId)}, ${nsfwLevel}, ${currentSanity.sane})`
      );
      if (!values.length) return;

      const results = await dbWrite.$queryRawUnsafe<{ imageId: number }[]>(`
        INSERT INTO "research_ratings" ("userId", "imageId", "nsfwLevel", "sane")
        VALUES ${values.join(', ')}
        ON CONFLICT ("userId", "imageId") DO UPDATE SET "nsfwLevel" = EXCLUDED."nsfwLevel", "createdAt" = NOW()
        RETURNING "imageId";
      `);

      const sanityIds = await getSanityIds();
      const isSanityCheck = Object.keys(input.ratings).every((imageId) =>
        sanityIds.includes(Number(imageId))
      );
      if (isSanityCheck) {
        const newSanity = await getUserSanity(ctx.user.id, sanityIds, true);
        if (newSanity.strikes !== currentSanity.strikes)
          throw new Error('You have failed the sanity check.');
        return;
      }

      if (results.length && currentSanity.sane) {
        const currentProgress = calculateLevelProgression(count);
        await ratingsCounter.incrementBy(ctx.user.id, results.length);
        const newProgress = calculateLevelProgression(count + results.length);

        // If we just did enough to level up, queue a webhook
        if (newProgress.level > currentProgress.level) await queueNewRaterLevelWebhook(ctx.user.id);

        // Update the user's position
        const progressKey = REDIS_KEYS.RESEARCH.RATINGS_PROGRESS + ':' + ctx.user.id;
        const lastImageId = results[results.length - 1].imageId;
        await redis.hSet(progressKey, `track:${input.trackId}`, lastImageId.toString());
        await redis.expire(progressKey, CacheTTL.week);
      }
    }),
  raterReset: protectedProcedure.mutation(async ({ ctx }) => {
    await dbWrite.$queryRaw`
      INSERT INTO research_ratings_resets ("userId")
      VALUES (${ctx.user.id});
    `;
    await redis.del(REDIS_KEYS.RESEARCH.RATINGS_PROGRESS + ':' + ctx.user.id);
    ratingsCounter.clear(ctx.user.id);
  }),
  raterGetSanityImages: moderatorProcedure.query(async () => {
    const sanityIds = await getSanityIds();
    const sanityImages = await dbRead.$queryRaw<SanityImage[]>`
      SELECT i.id, i.url, i.width, i.height, i.hash, i."nsfwLevel"
      FROM "Image" i
      WHERE i.id IN (${Prisma.join(sanityIds)});
    `;
    return sanityImages;
  }),
  raterUpdateSanityImages: moderatorProcedure
    .input(raterUpdateSanityImagesSchema)
    .mutation(async ({ input }) => {
      if (input.add?.length) {
        await redis.sAdd(REDIS_KEYS.RESEARCH.RATINGS_SANITY_IDS, input.add.map(String));
      }

      if (input.remove?.length) {
        await redis.sRem(REDIS_KEYS.RESEARCH.RATINGS_SANITY_IDS, input.remove.map(String));
      }
    }),
});
