import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

const TAG_THRESHOLD = 3;
const LAST_UPDATED_KEY = 'last-tags-applied';
export const applyVotedTags = createJob('apply-voted-tags', '*/2 * * * *', async () => {
  // Get the last sent time
  // --------------------------------------------
  const lastApplied = new Date(
    ((
      await dbWrite.keyValue.findUnique({
        where: { key: LAST_UPDATED_KEY },
      })
    )?.value as number) ?? 0
  ).toISOString();

  // Apply tags over the threshold
  // --------------------------------------------
  await dbWrite.$executeRawUnsafe(`
    -- Apply voted tags
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      LEFT JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > '${lastApplied}' AND applied."tagId" IS NULL
    ), over_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) >= ${TAG_THRESHOLD}
    )
    INSERT INTO "TagsOnImage"("tagId", "imageId")
    SELECT
      "tagId",
      "imageId"
    FROM over_threshold
    ON CONFLICT ("tagId", "imageId") DO NOTHING;
  `);

  // Update NSFW baseline
  // --------------------------------------------
  await dbWrite.$executeRawUnsafe(`
    -- Add NSFW baseline
    UPDATE "Image" SET nsfw = true
    WHERE id IN (
      SELECT DISTINCT toi."imageId"
      FROM "TagsOnImage" toi
      JOIN "Image" i ON i.id = toi."imageId" AND i.nsfw IS FALSE
      JOIN "Tag" t ON t.id = toi."tagId" AND t.type = 'Moderation'
      WHERE toi."createdAt" > '${lastApplied}'
    )
  `);

  // Update the last sent time
  // --------------------------------------------
  await dbWrite?.keyValue.upsert({
    where: { key: LAST_UPDATED_KEY },
    create: { key: LAST_UPDATED_KEY, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });
});
