import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import { constants } from '~/server/common/constants';
import { imagesSearchIndex } from '~/server/search-index';
import { Prisma } from '@prisma/client';
import { SearchIndexUpdateQueueAction } from '~/server/common/enums';
import { chunk, uniqBy } from 'lodash-es';
import { updateImageTagIdsForImages } from '~/server/services/image.service';

const UPVOTE_TAG_THRESHOLD = constants.tagVoting.upvoteThreshold;
const DOWNVOTE_TAG_THRESHOLD = 0;
export const applyVotedTags = createJob('apply-voted-tags', '*/2 * * * *', async () => {
  await applyUpvotes();
  await applyDownvotes();
});

async function applyUpvotes() {
  // Get the last sent time
  // --------------------------------------------
  const [lastApplied, setLastApplied] = await getJobDate('last-tags-applied');
  const now = new Date();

  // Apply tags over the threshold
  // --------------------------------------------
  const addedImageTags = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    -- Apply voted tags
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      LEFT JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE
          vote.vote > 0
        AND vote."createdAt" > ${lastApplied}
        AND applied."tagId" IS NULL
    ), over_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) >= ${UPVOTE_TAG_THRESHOLD}
    )
    INSERT INTO "TagsOnImage"("tagId", "imageId", "createdAt")
    SELECT
      "tagId",
      "imageId",
      ${now}
    FROM over_threshold
    ON CONFLICT ("tagId", "imageId") DO NOTHING
    RETURNING "tagId", "imageId";
  `;

  // Bring back disabled tag where voted by moderator
  // --------------------------------------------
  const restoredImageTags = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    -- Enable upvoted moderation tags if voted by mod
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE vote."createdAt" > ${lastApplied}
        AND applied.disabled
        AND vote.vote > 5
    )
    UPDATE "TagsOnImage" SET "disabled" = false, "disabledAt" = null, "createdAt" = ${now}
    WHERE ("tagId", "imageId") IN (
      SELECT "tagId", "imageId" FROM affected
    )
    RETURNING "tagId", "imageId";
  `;

  // Get affected images to update search index, cache, and votes
  // --------------------------------------------
  const affectedImageTags = uniqBy(
    [...addedImageTags, ...restoredImageTags],
    ({ imageId, tagId }) => `${imageId}-${tagId}`
  );

  const affectedImageResults = [...new Set(affectedImageTags.map(({ imageId }) => imageId))];

  // Update votes
  await dbWrite.$executeRaw`
    -- Update image tag votes
    with affected AS (
      SELECT "imageId", "tagId" FROM "TagsOnImage"
      WHERE "createdAt" = ${now}
    )
    UPDATE "TagsOnImageVote" SET "applied" = true
    WHERE ("imageId", "tagId") IN (SELECT "imageId", "tagId" FROM affected)
      AND vote > 0;
  `;

  // Bust cache
  await updateImageTagIdsForImages(affectedImageResults);

  // Update search index
  await imagesSearchIndex.queueUpdate(
    affectedImageResults.map((imageId) => ({
      id: imageId,
      action: SearchIndexUpdateQueueAction.Update,
    }))
  );

  // Update NSFW baseline
  // --------------------------------------------
  const toUpdate = (
    await dbWrite.$queryRaw<{ id: number }[]>`
      -- Get updated images
      SELECT DISTINCT i.id
      FROM "Image" i
      -- if any moderation tags were applied since last run
      WHERE EXISTS (
        SELECT 1 FROM "TagsOnImage" toi
        JOIN "Tag" t ON t.id = toi."tagId" AND t.type = 'Moderation'
        WHERE
          NOT toi.disabled
          AND toi."imageId" = i.id
          AND toi."createdAt" > ${lastApplied} - INTERVAL '1 minute'
      )
    `
  ).map(({ id }) => id);

  const batches = chunk(toUpdate, 500);
  for (const batch of batches) {
    // Update NSFW baseline - images
    await dbWrite.$executeRawUnsafe(`SELECT update_nsfw_levels(ARRAY[${batch.join(',')}])`);
    // Update NSFW baseline - posts
    await dbWrite.$executeRaw`
      WITH to_update AS (
        SELECT array_agg(DISTINCT i."postId") ids
        FROM "Image" i
        WHERE i.id IN (${Prisma.join(batch)})
      )
      SELECT update_post_nsfw_levels(ids)
      FROM to_update;
    `;
  }

  // Update the last sent time
  // --------------------------------------------
  await setLastApplied();
}

async function applyDownvotes() {
  // Get the last sent time
  // --------------------------------------------
  const [lastApplied, setLastApplied] = await getJobDate('last-tags-disabled');
  const now = new Date();

  // Delete tags under the threshold (not moderation)
  // --------------------------------------------
  const deletedImageTags = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    -- Delete downvoted tags (not moderation)
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE
          vote.vote < 0
        AND vote."createdAt" > (${lastApplied} - INTERVAL '1 minute')
        AND applied."disabled" = FALSE
        AND applied."needsReview" = FALSE
        AND applied."automated" = TRUE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= ${DOWNVOTE_TAG_THRESHOLD}
    )
    DELETE FROM "TagsOnImage" WHERE ("tagId", "imageId") IN (
      SELECT
        "tagId",
        "imageId"
      FROM under_threshold ut
      JOIN "Tag" t ON t.id = ut."tagId"
      WHERE t.type != 'Moderation'
    )
    RETURNING "tagId", "imageId";
  `;

  // Disable tags under the threshold (moderation) where voted by moderator
  // --------------------------------------------
  const disabledImageTags = await dbWrite.$queryRaw<{ imageId: number; tagId: number }[]>`
    -- Disable downvoted moderation tags if voted by mod
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE
          vote.vote < 0
        AND vote."createdAt" > (${lastApplied} - INTERVAL '1 minute')
        AND applied."disabled" = FALSE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId",
        SUM(votes.vote) "votes",
        SUM(IIF(votes.vote < -5, 1, 0)) "heavyVotes"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= 0
    )
    UPDATE "TagsOnImage" SET "disabled" = true, "needsReview" = false, "disabledAt" = ${now}
    WHERE ("tagId", "imageId") IN (
      SELECT
        "tagId",
        "imageId"
      FROM under_threshold ut
      JOIN "Tag" t ON t.id = ut."tagId"
      WHERE t.type = 'Moderation' AND ut."heavyVotes" > 0
    )
    RETURNING "tagId", "imageId";
  `;

  // Add "Needs Review" to tags under the threshold (moderation)
  // --------------------------------------------
  await dbWrite.$executeRaw`
    -- Send downvoted tags for review (moderation)
    WITH affected AS (
      SELECT DISTINCT vote."imageId", vote."tagId"
      FROM "TagsOnImageVote" vote
      JOIN "TagsOnImage" applied ON applied."imageId" = vote."imageId" AND applied."tagId" = vote."tagId"
      WHERE
          vote.vote < 0
        AND vote."createdAt" > (${lastApplied} - INTERVAL '1 minute')
        AND applied."disabled" = FALSE
        AND applied."needsReview" = FALSE
    ), under_threshold AS (
      SELECT
        a."imageId",
        a."tagId"
      FROM affected a
      JOIN "TagsOnImageVote" votes ON votes."tagId" = a."tagId" AND votes."imageId" = a."imageId"
      GROUP BY a."imageId", a."tagId"
      HAVING SUM(votes.vote) <= ${UPVOTE_TAG_THRESHOLD}
    )
    UPDATE "TagsOnImage" SET "needsReview" = TRUE WHERE ("tagId", "imageId") IN (
      SELECT
        "tagId",
        "imageId"
      FROM under_threshold ut
      JOIN "Tag" t ON t.id = ut."tagId"
      WHERE t.type = 'Moderation'
    );
  `;

  // Get affected images to update search index
  // --------------------------------------------
  const affectedImageResults = [
    ...new Set([...disabledImageTags, ...deletedImageTags].map((x) => x.imageId)),
  ];

  // Update votes
  await dbWrite.$executeRaw`
    -- Update image tag votes (unapply)
    with affected AS (
      SELECT "imageId", "tagId" FROM "TagsOnImage"
      WHERE "disabledAt" = ${now}
    )
    UPDATE "TagsOnImageVote" SET "applied" = false
    WHERE ("imageId", "tagId") IN (SELECT "imageId", "tagId" FROM affected)
      AND vote > 0;
  `;

  // Bust cache
  await updateImageTagIdsForImages(affectedImageResults);

  // Update search index
  await imagesSearchIndex.queueUpdate(
    affectedImageResults.map((imageId) => ({
      id: imageId,
      action: SearchIndexUpdateQueueAction.Update,
    }))
  );

  // Update NSFW baseline
  // --------------------------------------------
  const toUpdate = (
    await dbWrite.$queryRaw<{ id: number }[]>`
      -- Get updated images
      SELECT DISTINCT i.id
      FROM "Image" i
      WHERE nsfw != 'None'
      -- If any moderation tags were disabled since last run, update
      AND EXISTS (
        SELECT 1 FROM "TagsOnImage" toi
        JOIN "Tag" t ON t.id = toi."tagId"
        WHERE
          toi.disabled AND t.type = 'Moderation' AND toi."imageId" = i.id
          AND toi."disabledAt" > ${lastApplied} - INTERVAL '1 minute'
      )
    `
  ).map(({ id }) => id);

  const batches = chunk(toUpdate, 500);
  for (const batch of batches) {
    // Update NSFW baseline - images
    await dbWrite.$executeRawUnsafe(`SELECT update_nsfw_levels(ARRAY[${batch.join(',')}])`);
    // Update NSFW baseline - posts
    await dbWrite.$executeRaw`
      WITH to_update AS (
        SELECT array_agg(DISTINCT i."postId") ids
        FROM "Image" i
        WHERE i.id IN (${Prisma.join(batch)})
      )
      SELECT update_post_nsfw_levels(ids)
      FROM to_update;
    `;
  }

  // Update the last sent time
  // --------------------------------------------
  await setLastApplied();
}
