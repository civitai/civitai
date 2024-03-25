import { z } from 'zod';
import { dbRead, dbWrite } from '~/server/db/client';
import { REDIS_KEYS } from '~/server/redis/client';
import { protectedProcedure, router } from '~/server/trpc';
import { cachedCounter } from '~/server/utils/cache-helpers';
import { calculateLevelProgression } from '~/server/utils/research-utils';
import { queueNewRaterLevelWebhook } from '~/server/webhooks/research.webhooks';
import { getRandomInt } from '~/utils/number-helpers';

const raterGetImagesSchema = z.object({
  level: z.number(),
  cursor: z.number().optional(),
});

const raterSetRatingsSchema = z.object({
  ratings: z.record(z.string(), z.number()),
});

async function getImageStartingPoint() {
  const [{ min, max }] = await dbRead.$queryRaw<{ min: number; max: number }[]>`
    WITH dates AS (
      SELECT MIN("createdAt") as start, MAX("createdAt") as end FROM "Image" WHERE "createdAt" > now() - interval '90 days'
    )
    SELECT MIN(id) as min, MAX(id) as max
    FROM "Image" i
    JOIN dates d ON d.start = i."createdAt" OR d.end = i."createdAt";
  `;
  return getRandomInt(min, max);
}

export type RaterImage = { id: number; url: string; nsfwLevel: number };
export const ratingsCounter = cachedCounter(
  REDIS_KEYS.RESEARCH.RATINGS_COUNT,
  async (userId: number) => {
    const [{ count }] = await dbRead.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*) as count
    FROM "research_ratings"
    WHERE "userId" = ${userId};
  `;
    return Number(count ?? 0);
  }
);

export const researchRouter = router({
  raterGetStatus: protectedProcedure.query(async ({ ctx }) => {
    const count = await ratingsCounter.get(ctx.user.id);
    return { count };
  }),
  raterGetImages: protectedProcedure.input(raterGetImagesSchema).query(async ({ input }) => {
    input.cursor ??= await getImageStartingPoint();
    return dbRead.$queryRaw<RaterImage[]>`
      SELECT id, url, "nsfwLevel"
      FROM "Image"
      WHERE id > ${input.cursor}
        AND ("nsfwLevel" & ${input.level}) != 0
        AND type = 'image'
      ORDER BY id
      LIMIT 10;
    `;
  }),
  raterSetRatings: protectedProcedure
    .input(raterSetRatingsSchema)
    .mutation(async ({ input, ctx }) => {
      const count = await ratingsCounter.get(ctx.user.id);
      const values = Object.entries(input.ratings).map(
        ([imageId, nsfwLevel]) => `(${ctx.user.id}, ${Number(imageId)}, ${nsfwLevel})`
      );
      const results = await dbWrite.$queryRawUnsafe<{ imageId: number }[]>(`
        INSERT INTO "research_ratings" ("userId", "imageId", "nsfwLevel")
        VALUES ${values.join(', ')}
        ON CONFLICT ("userId", "imageId") DO UPDATE SET "nsfwLevel" = EXCLUDED."nsfwLevel"
        RETURNING "imageId";
      `);

      if (results.length) {
        const currentProgress = calculateLevelProgression(count);
        await ratingsCounter.incrementBy(ctx.user.id, results.length);
        const newProgress = calculateLevelProgression(count + results.length);

        // If we just did enough to level up, queue a webhook
        if (newProgress.level > currentProgress.level) await queueNewRaterLevelWebhook(ctx.user.id);
      }
    }),
});
