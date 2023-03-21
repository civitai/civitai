import { createJob } from './job';
import { dbWrite } from '~/server/db/client';

const TAG_THRESHOLD = 0;
const LAST_UPDATED_KEY = 'last-tags-disabled';
export const disabledVotedTags = createJob('disable-voted-tags', '*/10 * * * *', async () => {
  // Get the last sent time
  // --------------------------------------------
  const lastApplied = new Date(
    ((
      await dbWrite.keyValue.findUnique({
        where: { key: LAST_UPDATED_KEY },
      })
    )?.value as number) ?? 0
  ).toISOString();

  // Delete tags under the threshold (not moderation)
  // --------------------------------------------
  await dbWrite.$executeRawUnsafe(`
    -- Delete downvoted tags (not moderation)
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > '${lastApplied}' AND applied."disabled" = FALSE AND applied."needsReview" = FALSE AND applied."automated" = TRUE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= ${TAG_THRESHOLD}
    )
    DELETE FROM "TagsOnImage" WHERE ("tagId", "imageId") IN (
      SELECT
        "tagId",
        "imageId"
      FROM under_threshold ut
      JOIN "Tag" t ON t.id = ut."tagId"
      WHERE t.type != 'Moderation'
    );
  `);

  // Add "Needs Review" to tags under the threshold (moderation)
  // --------------------------------------------
  await dbWrite.$executeRawUnsafe(`
    -- Send downvoted tags for review (moderation)
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > '${lastApplied}' AND applied."disabled" = FALSE AND applied."needsReview" = FALSE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= ${TAG_THRESHOLD}
    )
    UPDATE "TagsOnImage" SET "needsReview" = TRUE WHERE ("tagId", "imageId") IN (
      SELECT
        "tagId",
        "imageId"
      FROM under_threshold ut
      JOIN "Tag" t ON t.id = ut."tagId"
      WHERE t.type = 'Moderation'
    );
  `);

  // Update the last sent time
  // --------------------------------------------
  await dbWrite?.keyValue.upsert({
    where: { key: LAST_UPDATED_KEY },
    create: { key: LAST_UPDATED_KEY, value: new Date().getTime() },
    update: { value: new Date().getTime() },
  });
});
