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

  // Bring back disabled tag where voted by moderator
  // --------------------------------------------
  await dbWrite.$executeRawUnsafe(`
    -- Enable upvoted moderation tags if voted by mod
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > '${lastApplied}'
        AND applied.disabled
        AND vote.vote > 5
    )
    UPDATE "TagsOnImage" SET "disabled" = false, "disabledAt" = null
    WHERE ("tagId", "imageId") IN (
      SELECT "tagId", "imageId" FROM affected
    );
  `);

  // Update NSFW baseline
  // --------------------------------------------
  await dbWrite.$executeRawUnsafe(`
    -- Update NSFW baseline
    WITH to_update AS (
      SELECT array_agg(i.id) ids
      FROM "Image" i
      WHERE EXISTS (
        SELECT 1 FROM "TagsOnImage" toi
        JOIN "Tag" t ON t.id = toi."tagId" AND t.type = 'Moderation'
        WHERE
          NOT toi.disabled
          AND toi."imageId" = i.id
          AND toi."createdAt" > '${lastApplied}'
      )
    )
    SELECT update_nsfw_levels(ids)
    FROM to_update;
  `);

  // Update the last sent time
  // --------------------------------------------
  await dbWrite?.keyValue.upsert({
    where: { key: LAST_UPDATED_KEY },
    create: { key: LAST_UPDATED_KEY, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });
});
